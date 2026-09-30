import { BOOL, DYN, DYN_CLASS_PROPERTIES as PROPERTY_BAG, STRING, VOID, canConvertToDyn, canDynCheckTo, isClassOwnEnumerableFieldName, isDynTypedRefType, isUnitType, typeEquals, typeKey, type IrExpr, type IrFunction, type IrStmt, type IrType, type SrcLoc } from "../../ir/ir.js";
import { streamTypedRefEligible } from "../../ir/analysis.js";
import { varRef } from "../../ir/build.js";
import { everyStmtList, transformExpr, transformStmtList } from "../../ir/traverse.js";
import { dynUndefinedExpr, PoisonError, type Lowerer } from "./lowerer.js";
import { implicitDefaultInstance, type ParamShape } from "./lower-calls.js";
import { accessorCall, classValueRef, findGenericMethodOn, findMethodOn, genericOverrideBelow, upcastTo, type ClassInfo } from "./lower-classes.js";
import { classPrototypeData, hasClassPrototypeData } from "./class-prototypes.js";
import { errorToStringCall, errorToStringMethod, refreshErrorMethodDispatch } from "./error-methods.js";
import { GeneratorDynamicDispatch } from "./generator-dynamic-dispatch.js";
import { classMethodValue } from "./class-method-values.js";
import * as ts from "../ts7/adapter.js";
import { SYMBOL_T } from "../../ir/ir.js";
import { isClassCallback } from "./class-callbacks.js";

type Invoke = Extract<IrExpr, { kind: "dynInvoke" }>;
interface Dispatch {
  source: Invoke;
  fn: IrFunction;
  callback: IrFunction;
  classes: Set<string>;
}

interface PropertyReceiver {
  info: ClassInfo;
  capsule: ClassInfo;
  key: string;
}

interface PropertyDispatch {
  name: string;
  write: boolean;
  fn: IrFunction;
  classes: Set<string>;
}

export function classInstanceOf(lowerer: Lowerer, value: IrExpr, info: ClassInfo, loc: SrcLoc): IrExpr {
  const name = `%dyn.class.instanceof:${info.def.name}`;
  if (!lowerer.liftedFns.some((fn) => fn.name === name)) lowerer.liftedFns.push({
    name, params: [{ localId: "value", name: "value", type: DYN }], returnType: BOOL,
    locals: [{ id: "value", name: "value", type: DYN, mutable: false }],
    body: [{ kind: "return", value: { kind: "boolLit", value: false, type: BOOL, loc }, loc }], loc,
  });
  return { kind: "call", callee: name, args: [value], type: BOOL, loc };
}

export function classPropertiesHelper(lowerer: Lowerer, loc: SrcLoc): IrFunction {
  const name = "%dyn.class.properties";
  const existing = lowerer.liftedFns.find((fn) => fn.name === name);
  if (existing) return existing;
  const helper: IrFunction = {
    name, params: [{ localId: "p.0", name: "value", type: DYN }], returnType: DYN,
    locals: [{ id: "p.0", name: "value", type: DYN, mutable: false }],
    body: [{ kind: "return", value: varRef("p.0", DYN, loc), loc }], loc,
  };
  lowerer.liftedFns.push(helper);
  return helper;
}

/** Calls on native class capsules keep the instance's compiled methods. The
 * reachable-body fixed point discovers both the boxed classes and method
 * names before generating checked native dispatch; ordinary dyn receivers
 * continue through their existing runtime implementation. */
export class ClassDynamicDispatch {
  constructor(private readonly asyncFree = false) {}

  private readonly generatorDispatch = new GeneratorDynamicDispatch();
  private readonly boxed = new Set<string>();
  private readonly dispatches = new Map<string, Dispatch>();
  private readonly properties = new Map<string, PropertyDispatch>();
  private readonly computed = new Map<string, Omit<PropertyDispatch, "name"> & { keyLocal: string; branchIndex: number; dynamicKey: boolean; probe: "in" | "own" | "enumerable" | undefined }>();
  private propertyBag: IrFunction | null = null;
  private readonly errorStrings = new Map<string, IrFunction>();
  private readonly bagClasses = new Set<string>();
  private readonly bagInitializers = new Map<string, Extract<IrStmt, { kind: "fieldSet" }>[]>();
  private readonly typedPropertyBags = new Map<string, IrFunction>();
  private readonly generated = new Set<IrFunction>();
  private constructDispatch: IrFunction | null = null;
  private readonly constructors = new Map<string, ClassInfo>();
  private readonly constructed = new Set<string>();
  private readonly instanceTests = new Map<string, Set<string>>();

  process(lowerer: Lowerer, functions: readonly IrFunction[]): boolean {
    let changed = refreshErrorMethodDispatch(lowerer, functions);
    changed = this.generatorDispatch.process(lowerer, functions, this.generated) || changed;
    const seenTypes = new Set<string>();
    const rewrite = new Set<IrFunction>();
    const discover = (type: IrType): void => {
      const key = typeKey(type);
      if (seenTypes.has(key)) return;
      seenTypes.add(key);
      if (isDynTypedRefType(type)) this.boxed.add(type.className);
      else if (type.kind === "array") discover(type.elem);
      else if (type.kind === "record") {
        const shape = lowerer.shapes.get(type.shapeId);
        shape?.fields.forEach((field) => discover(field.type));
        if (shape?.indexValue) discover(shape.indexValue);
      } else if (type.kind === "union") lowerer.unions.get(type.unionId)?.arms.forEach(discover);
      else if (type.kind === "func") discover(type.ret);
      else if (type.kind === "promise") discover(type.inner);
    };
    for (const fn of functions) everyStmtList(fn.body, {
      stmt: () => true,
      expr: (expr) => {
        switch (expr.kind) {
          case "dynFrom":
            discover(expr.value.type);
            break;
          case "call":
            if (expr.callee === "%dyn.class.properties" && expr.args[0]?.kind === "dynFrom" && isDynTypedRefType(expr.args[0].value.type)) rewrite.add(fn);
            break;
          case "dynKeyGet":
          case "dynInvoke":
            rewrite.add(fn);
            break;
          case "libCall":
            if (expr.fn === "bytes.construct" || expr.fn === "dyn.keySet" || expr.fn === "dyn.keySetComputed" || (expr.fn === "dyn.iterator" || expr.fn === "dyn.arrayFromIterator") || expr.fn === "dyn.toString" || expr.fn === "dyn.stringConstructor" ||
                expr.fn === "dyn.hasKeyComputed" || expr.fn === "dyn.hasOwnComputed" || expr.fn === "dyn.propertyIsEnumerableComputed") rewrite.add(fn);
            break;
        }
        return true;
      },
    });
    if (this.boxed.size === 0 && rewrite.size === 0) return changed;
    for (const fn of functions) {
      if (!fn.name.startsWith("%dyn.class.instanceof:")) continue;
      const target = fn.name.slice("%dyn.class.instanceof:".length);
      let checked = this.instanceTests.get(fn.name);
      if (!checked) { checked = new Set(); this.instanceTests.set(fn.name, checked); }
      for (const className of this.boxed) {
        if (checked.has(className)) continue;
        checked.add(className);
        const subtype = className === target || lowerer.isSubclassOf(className, target);
        if (!subtype && !lowerer.isSubclassOf(target, className)) continue;
        const loc = fn.loc;
        const value = varRef("value", DYN, loc);
        const type: IrType = { kind: "object", className };
        const result: IrExpr = subtype ? { kind: "boolLit", value: true, type: BOOL, loc }
          : { kind: "instanceOf", value: { kind: "dynCheck", value, type, loc }, className: target, type: BOOL, loc };
        fn.body.unshift({ kind: "if", cond: { kind: "libCall", fn: "dyn.typedRefIs", args: [value,
          { kind: "strLit", value: typeKey(type), type: STRING, loc }], type: BOOL, loc }, then: [{ kind: "return", value: result, loc }], else_: null, loc });
        changed = true;
      }
    }
    if (!this.propertyBag) {
      this.propertyBag = classPropertiesHelper(lowerer, functions[0]!.loc);
      this.generated.add(this.propertyBag);
      changed = true;
    }
    for (const className of this.boxed) {
      const info = lowerer.classes.get(className);
      if (!info || info.builtinEmitter || info.builtinStream || info.builtinError) continue;
      const needsPrototype = (current: ClassInfo): boolean => hasClassPrototypeData(current) || current.subclasses.some(needsPrototype);
      const prototypeFor = (current: ClassInfo, receiver: IrExpr, loc: SrcLoc): IrExpr | null => {
        const currentReceiver: IrExpr = receiver.type.kind === "object" && receiver.type.className !== current.def.name
          ? { kind: "downcast", value: receiver, type: { kind: "object", className: current.def.name }, loc }
          : receiver;
        let result = classPrototypeData(lowerer, current, loc, currentReceiver);
        for (const child of current.subclasses) {
          const selected = prototypeFor(child, receiver, loc);
          if (selected && result) result = { kind: "ternary", cond: { kind: "instanceOf", value: receiver, className: child.def.name, type: BOOL, loc },
            then: selected, else_: result, type: DYN, loc };
        }
        return result;
      };
      for (const existingInit of this.bagInitializers.get(className) ?? []) {
        if (existingInit.value.kind === "dynObjLit" && needsPrototype(info)) {
          const prototype = prototypeFor(info, existingInit.obj, existingInit.loc);
          if (prototype) {
            existingInit.value = { kind: "libCall", fn: "dyn.objCreate", args: [prototype], type: DYN, loc: existingInit.loc };
            changed = true;
          }
        }
      }
      if (this.bagClasses.has(className)) continue;
      this.bagClasses.add(className);
      this.ensurePropertyBag(info);
      const loc = this.propertyBag.loc;
      const type: IrType = { kind: "object", className };
      const value = varRef("p.0", DYN, loc);
      const receiver: IrExpr = { kind: "dynCheck", value, type, loc };
      const bag: IrExpr = { kind: "fieldGet", obj: receiver, className, field: PROPERTY_BAG, type: DYN, loc };
      const prototype = needsPrototype(info) ? prototypeFor(info, receiver, loc) : null;
      const initialize: Extract<IrStmt, { kind: "fieldSet" }> = {
        kind: "fieldSet", obj: receiver, className, field: PROPERTY_BAG, value: prototype
          ? { kind: "libCall", fn: "dyn.objCreate", args: [prototype], type: DYN, loc }
          : { kind: "dynObjLit", fields: [], type: DYN, loc }, loc,
      };
      this.bagInitializers.set(className, [initialize]);
      this.propertyBag.body.unshift({
        kind: "if", cond: { kind: "libCall", fn: "dyn.typedRefIs", args: [value, { kind: "strLit", value: typeKey(type), type: STRING, loc }], type: BOOL, loc },
        then: [
          { kind: "if", cond: { kind: "dynTest", test: "undefined", value: bag, type: BOOL, loc }, then: [
            initialize,
          ], else_: null, loc },
          { kind: "return", value: bag, loc },
        ], else_: null, loc,
      });
      changed = true;
    }
    const byMethod = new Map<string, ClassInfo[]>();
    const candidates = (method: string): ClassInfo[] => {
      const found = byMethod.get(method);
      if (found) return found;
      const matching = [...this.boxed].flatMap((name) => {
        const info = lowerer.classes.get(name);
        if (!info || info.fields.has(method) || info.builtinEmitter || info.builtinStream || info.builtinError) return [];
        return findMethodOn(lowerer, info, method) || findGenericMethodOn(lowerer, info, method) ? [info] : [];
      });
      byMethod.set(method, matching);
      return matching;
    };
    for (const fn of functions) {
      // Discovery already visits every expression. Preserve bodies without
      // dispatch sites instead of rebuilding their entire typed IR tree on
      // every reachability pass. Recompute this set as new bodies appear.
      if (this.generated.has(fn) || !rewrite.has(fn)) continue;
      fn.body = transformStmtList(fn.body, {
        stmt: (stmt) => stmt,
        expr: (expr) => {
          if (expr.kind === "libCall" && (expr.fn === "dyn.toString" || expr.fn === "dyn.stringConstructor") && lowerer.classes.has("%Error")) {
            const key = JSON.stringify([expr.fn, ...expr.args.map((arg) => typeKey(arg.type))]);
            let errorString = this.errorStrings.get(key);
            if (!errorString) {
              const loc = expr.loc;
              const params = expr.args.map((arg, i) => ({ localId: `p.${i}`, name: `p${i}`, type: arg.type }));
              const value = varRef("p.0", DYN, loc);
              errorString = { name: `%dyn.error.${expr.fn.slice(4)}.${this.errorStrings.size}`, params, returnType: STRING,
                locals: params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })), loc,
                body: [
                  { kind: "if", cond: { kind: "dynTest", test: "error", value, type: BOOL, loc }, then: [
                    { kind: "return", value: { kind: "dynCheck", type: STRING, loc, value: {
                      kind: "dynCall", callee: errorToStringMethod(lowerer, { kind: "dynCheck", value, type: { kind: "object", className: "%Error" }, loc }),
                      receiver: value, calleeName: "value.toString", args: params.slice(1).map((p) => lowerer.coerceToExpected(varRef(p.localId, p.type, loc), DYN)), type: DYN, loc,
                    } }, loc },
                  ], else_: null, loc },
                  { kind: "return", value: { ...expr, args: params.map((p) => varRef(p.localId, p.type, loc)) }, loc },
                ] };
              this.errorStrings.set(key, errorString);
              this.generated.add(errorString);
              lowerer.liftedFns.push(errorString);
              changed = true;
            }
            return { kind: "call", callee: errorString.name, args: expr.args, type: STRING, loc: expr.loc };
          }
          if (expr.kind === "call" && expr.callee === this.propertyBag!.name) {
            const boxed = expr.args[0];
            if (boxed?.kind === "dynFrom" && isDynTypedRefType(boxed.value.type)) {
              const helper = this.typedPropertyBag(lowerer, boxed.value.type, expr.loc);
              if (helper) {
                changed = true;
                return { ...expr, callee: helper.name, args: [boxed.value] };
              }
            }
          }
          if (expr.kind === "libCall" && expr.fn === "bytes.construct") {
            if (!this.constructDispatch) {
              const loc = expr.loc;
              const params = [DYN, DYN, STRING].map((type, i) => ({localId: `p.${i}`, name: `p${i}`, type}));
              this.constructDispatch = { name: "%dyn.class.construct", params, returnType: DYN,
                locals: params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
                body: [{ kind: "return", value: { ...expr, args: params.map((p) => varRef(p.localId, p.type, loc)) }, loc }], loc };
              this.generated.add(this.constructDispatch);
              lowerer.liftedFns.push(this.constructDispatch);
              changed = true;
            }
            return { kind: "call", callee: this.constructDispatch.name, args: expr.args, type: DYN, loc: expr.loc };
          }
          const computedRead = expr.kind === "dynKeyGet" && expr.key.kind !== "strLit" ? expr : null;
          const computedWrite = expr.kind === "libCall" && (expr.fn === "dyn.keySetComputed" || expr.fn === "dyn.keySet" && expr.args[1]?.kind !== "strLit") ? expr : null;
          const computedProbe = expr.kind === "libCall" && ["dyn.hasKeyComputed", "dyn.hasOwnComputed", "dyn.propertyIsEnumerableComputed"].includes(expr.fn) ? expr : null;
          if (computedRead || computedWrite || computedProbe) {
            const probe = computedProbe ? computedProbe.fn === "dyn.hasKeyComputed" ? "in" : computedProbe.fn === "dyn.hasOwnComputed" ? "own" : "enumerable" : undefined;
            const dynamicKey = !!computedProbe || computedWrite?.fn === "dyn.keySetComputed" || computedRead?.key.type.kind === "dyn";
            const key = JSON.stringify([!!computedWrite, computedRead?.optional ?? false, dynamicKey, probe]);
            let dispatch = this.computed.get(key);
            if (!dispatch) {
              const loc = expr.loc;
              const params = [
                { localId: "p.0", name: "value", type: DYN },
                { localId: "p.key", name: "key", type: dynamicKey ? DYN : STRING },
                ...(computedWrite ? [{ localId: "p.1", name: "stored", type: DYN }] : []),
              ];
              const keyLocal = dynamicKey ? "key.string" : "p.key";
              const bag: IrExpr = { kind: "call", callee: this.propertyBag!.name, args: [varRef("p.0", DYN, loc)], type: DYN, loc };
              const fallback: IrExpr = computedProbe
                ? { ...computedProbe, fn: probe === "in" ? "dyn.hasKey" : probe === "own" ? "dyn.hasOwn" : "dyn.propertyIsEnumerable", args: [bag, varRef(keyLocal, STRING, loc)] }
                : computedRead
                ? { ...computedRead, value: bag, key: varRef(keyLocal, STRING, loc) }
                : { ...computedWrite!, fn: "dyn.keySet", args: [bag, varRef(keyLocal, STRING, loc), varRef("p.1", DYN, loc)] };
              const helper: IrFunction = {
                name: `%dyn.class.computed.${this.computed.size}`, params, returnType: computedProbe ? BOOL : computedWrite ? VOID : DYN,
                locals: [...params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })), ...(dynamicKey ? [{ id: keyLocal, name: "key", type: STRING, mutable: false }] : [])],
                body: computedWrite
                  ? [{ kind: "exprStmt", expr: fallback, loc }, { kind: "return", value: null, loc }]
                  : [{ kind: "return", value: fallback, loc }], loc,
              };
              if (dynamicKey) helper.body.unshift(
                { kind: "if", cond: { kind: "dynTest", test: "symbol", value: varRef("p.key", DYN, loc), type: BOOL, loc }, then: computedProbe ? [
                  { kind: "return", value: { ...computedProbe, args: [bag, varRef("p.key", DYN, loc)] }, loc },
                ] : computedRead ? [
                  { kind: "return", value: { ...computedRead, value: bag, key: varRef("p.key", DYN, loc) }, loc },
                ] : [
                  { kind: "exprStmt", expr: { ...computedWrite!, args: [bag, varRef("p.key", DYN, loc), varRef("p.1", DYN, loc)] }, loc },
                  { kind: "return", value: null, loc },
                ], else_: null, loc },
                { kind: "if", cond: { kind: "dynTest", test: "nullish", value: varRef("p.0", DYN, loc), type: BOOL, loc }, then: [
                  ...(computedProbe ? [{ kind: "return", value: { ...computedProbe, args: [varRef("p.0", DYN, loc), varRef("p.key", DYN, loc)] }, loc } as IrStmt] : computedRead ? [{ kind: "return", value: { ...computedRead, value: varRef("p.0", DYN, loc), key: varRef("p.key", DYN, loc) }, loc } as IrStmt] : [
                    { kind: "exprStmt", expr: { ...computedWrite!, args: [varRef("p.0", DYN, loc), varRef("p.key", DYN, loc), varRef("p.1", DYN, loc)] }, loc } as IrStmt,
                    { kind: "return", value: null, loc } as IrStmt,
                  ]),
                ], else_: null, loc },
                { kind: "varDecl", localId: keyLocal, init: { kind: "libCall", fn: "dyn.toStringCoerce", args: [varRef("p.key", DYN, loc)], type: STRING, loc }, loc },
              );
              dispatch = { write: !!computedWrite, fn: helper, classes: new Set(), keyLocal, branchIndex: dynamicKey ? 3 : 0, dynamicKey, probe };
              this.computed.set(key, dispatch);
              this.generated.add(helper);
              lowerer.liftedFns.push(helper);
              changed = true;
            }
            return { kind: "call", callee: dispatch.fn.name, args: computedRead ? [computedRead.value, computedRead.key] : (computedWrite ?? computedProbe)!.args, type: dispatch.fn.returnType, loc: expr.loc };
          }
          const read = expr.kind === "dynKeyGet" && expr.key.kind === "strLit" ? expr : null;
          const write = expr.kind === "libCall" && expr.fn === "dyn.keySet" && expr.args[1]?.kind === "strLit" ? expr : null;
          const name = read?.key.kind === "strLit" ? read.key.value : write?.args[1]?.kind === "strLit" ? write.args[1].value : null;
          if (name !== null) {
            const key = JSON.stringify([name, !!write, read?.optional ?? false]);
            let dispatch = this.properties.get(key);
            if (!dispatch) {
              const loc = expr.loc;
              const params = (write ? [0, 1] : [0]).map((i) => ({ localId: `p.${i}`, name: `p${i}`, type: DYN }));
              const bag: IrExpr = { kind: "call", callee: this.propertyBag!.name, args: [varRef("p.0", DYN, loc)], type: DYN, loc };
              const fallback: IrExpr = read
                ? { ...read, value: bag }
                : { ...write!, args: [bag, write!.args[1]!, varRef("p.1", DYN, loc)] };
              const helper: IrFunction = {
                name: `%dyn.class.property.${this.properties.size}`, params, returnType: write ? VOID : DYN,
                locals: params.map((p) => ({ id: p.localId, name: p.name, type: DYN, mutable: false })),
                body: write
                  ? [{ kind: "exprStmt", expr: fallback, loc }, { kind: "return", value: null, loc }]
                  : [{ kind: "return", value: fallback, loc }], loc,
              };
              if (!write && name === "toString" && lowerer.classes.has("%Error")) {
                const value = varRef("p.0", DYN, loc);
                helper.body.unshift({ kind: "if", cond: { kind: "dynTest", test: "error", value, type: BOOL, loc }, then: [
                  { kind: "return", value: errorToStringMethod(lowerer, { kind: "dynCheck", value, type: { kind: "object", className: "%Error" }, loc }), loc },
                ], else_: null, loc });
              }
              dispatch = { name, write: !!write, fn: helper, classes: new Set() };
              this.properties.set(key, dispatch);
              this.generated.add(helper);
              lowerer.liftedFns.push(helper);
              changed = true;
            }
            return { kind: "call", callee: dispatch.fn.name, args: read ? [read.value] : [write!.args[0]!, write!.args[2]!], type: dispatch.fn.returnType, loc: expr.loc };
          }
          const iterator = expr.kind === "libCall" && (expr.fn === "dyn.iterator" || expr.fn === "dyn.arrayFromIterator") ? expr : null;
          const invoke: Invoke | null = iterator
            ? { kind: "dynInvoke", recv: iterator.args[0]!, method: "sym:iterator", calleeName: "value[Symbol.iterator]", args: [], type: DYN, loc: iterator.loc }
            : expr.kind === "dynInvoke" ? expr : null;
          if (!invoke || candidates(invoke.method).length === 0 && !(invoke.method === "toString" && lowerer.classes.has("%Error"))) return expr;
          const key = JSON.stringify([invoke.method, invoke.calleeName, invoke.args.length, iterator?.fn, iterator?.args[1]]);
          let dispatch = this.dispatches.get(key);
          if (!dispatch) {
            const params = [invoke.recv, ...invoke.args].map((_, i) => ({ localId: `p.${i}`, name: `p${i}`, type: DYN }));
            params.splice(1, 0, { localId: "p.callback", name: "callback", type: DYN });
            const callback: IrFunction = {
              name: `%dyn.class.callback.${this.dispatches.size}`, params: [params[0]!], returnType: DYN,
              locals: [{ id: "p.0", name: "receiver", type: DYN, mutable: false }],
              body: [{ kind: "return", value: dynUndefinedExpr(expr.loc), loc: expr.loc }], loc: expr.loc,
            };
            const helper: IrFunction = {
              name: `%dyn.class.call.${this.dispatches.size}`, params, returnType: DYN,
              locals: params.map((p) => ({ id: p.localId, name: p.name, type: DYN, mutable: false })),
              body: [{ kind: "return", value: iterator
                ? { ...iterator, args: [varRef("p.0", DYN, expr.loc), ...iterator.args.slice(1)] }
                : { ...invoke, recv: varRef("p.0", DYN, expr.loc), args: invoke.args.map((_, i) => varRef(`p.${i + 1}`, DYN, expr.loc)) }, loc: expr.loc }],
              loc: expr.loc,
            };
            if (invoke.method === "toString" && lowerer.classes.has("%Error")) {
              const loc = expr.loc;
              const value = varRef("p.0", DYN, loc);
              helper.body.unshift({ kind: "if", cond: { kind: "dynTest", test: "error", value, type: BOOL, loc }, then: [
                { kind: "return", value: {
                  kind: "dynCall", callee: errorToStringMethod(lowerer, { kind: "dynCheck", value, type: { kind: "object", className: "%Error" }, loc }),
                  receiver: value, calleeName: invoke.calleeName, args: invoke.args.map((_, i) => varRef(`p.${i + 1}`, DYN, loc)), type: DYN, loc,
                }, loc },
              ], else_: null, loc });
            }
            dispatch = { source: invoke, fn: helper, callback, classes: new Set() };
            this.dispatches.set(key, dispatch);
            this.generated.add(helper);
            this.generated.add(callback);
            lowerer.liftedFns.push(helper, callback);
            changed = true;
          }
          // Resolve an own callback before argument effects can replace it.
          const local = { id: `%dispatch.receiver.${fn.locals.length}`, name: "receiver", type: DYN, mutable: false };
          fn.locals.push(local);
          const receiver = varRef(local.id, DYN, expr.loc);
          return { kind: "seqExpr", stmts: [{ kind: "varDecl", localId: local.id, init: invoke.recv, loc: expr.loc }], result: {
            kind: "call", callee: dispatch.fn.name, args: [receiver,
              { kind: "call", callee: dispatch.callback.name, args: [receiver], type: DYN, loc: expr.loc }, ...invoke.args], type: DYN, loc: expr.loc,
          }, type: DYN, loc: expr.loc };
        },
      });
    }
    for (const dispatch of this.dispatches.values()) {
      for (const info of candidates(dispatch.source.method)) {
        if (dispatch.classes.has(info.def.name)) continue;
        dispatch.classes.add(info.def.name);
        const loc = dispatch.source.loc;
        const type: IrType = { kind: "object", className: info.def.name };
        const receiver = varRef("p.0", DYN, loc);
        if (isClassCallback(lowerer, info, dispatch.source.method)) {
          const prototypeMethod = lowerer.prototypeMethodAccesses.has(dispatch.source.method);
          if (prototypeMethod) classPrototypeData(lowerer, info, loc);
          const bag: IrExpr = { kind: "call", callee: this.propertyBag!.name, args: [receiver], type: DYN, loc };
          dispatch.callback.body.unshift({ kind: "if", cond: {
            kind: "libCall", fn: "dyn.typedRefIs", args: [receiver, { kind: "strLit", value: typeKey(type), type: STRING, loc }], type: BOOL, loc,
          }, then: [{ kind: "return", value: { kind: "ternary", cond: prototypeMethod ? { kind: "boolLit", value: true, type: BOOL, loc } : { kind: "libCall", fn: "dyn.hasKey", args: [bag,
            { kind: "strLit", value: dispatch.source.method, type: STRING, loc }], type: BOOL, loc }, then: { kind: "dynObjLit", fields: [
              { key: { kind: "strLit", value: "value", type: STRING, loc }, value: { kind: "dynKeyGet", value: bag, key: { kind: "strLit", value: dispatch.source.method, type: STRING, loc }, type: DYN, loc } },
            ], type: DYN, loc }, else_: dynUndefinedExpr(loc), type: DYN, loc }, loc }], else_: null, loc });
        }
        const before = lowerer.diags.length;
        let branch: IrStmt[];
        try {
          branch = this.methodBody(lowerer, dispatch, info, { kind: "dynCheck", value: receiver, type, loc });
        } catch (error) {
          if (!(error instanceof PoisonError) || !info.decl) throw error;
          const fence = lowerer.deferToRuntimeFence(before, info.decl, { kind: "statement" });
          if (!fence) throw error;
          branch = [fence];
        }
        dispatch.fn.body.unshift({
          kind: "if", cond: {
            kind: "libCall", fn: "dyn.typedRefIs", args: [receiver, { kind: "strLit", value: typeKey(type), type: STRING, loc }], type: BOOL, loc,
          }, then: branch, else_: null, loc,
        });
        changed = true;
      }
    }
    for (const dispatch of this.properties.values()) {
      for (const plan of this.propertyReceivers(lowerer)) {
        const { info } = plan;
        if (!isClassOwnEnumerableFieldName(dispatch.name) ||
            !findMethodOn(lowerer, info, dispatch.name) && !findGenericMethodOn(lowerer, info, dispatch.name) && dispatch.name !== "constructor" && !info.fields.has(dispatch.name) && !findMethodOn(lowerer, info, `get:${dispatch.name}`) && !findMethodOn(lowerer, info, `set:${dispatch.name}`)) continue;
        if (dispatch.classes.has(plan.key)) continue;
        dispatch.classes.add(plan.key);
        const loc = dispatch.fn.loc;
        const { receiver, condition } = this.propertyReceiver(plan, loc);
        const before = lowerer.diags.length;
        let branch: IrStmt[];
        try {
          branch = this.propertyBody(lowerer, dispatch, info, receiver);
        } catch (error) {
          if (!(error instanceof PoisonError) || !info.decl) throw error;
          const fence = lowerer.deferToRuntimeFence(before, info.decl, { kind: "statement" });
          if (!fence) throw error;
          branch = [fence];
        }
        dispatch.fn.body.unshift({
          kind: "if", cond: condition, then: branch, else_: null, loc,
        });
        changed = true;
      }
    }
    for (const dispatch of this.computed.values()) {
      for (const plan of this.propertyReceivers(lowerer)) {
        if (dispatch.classes.has(plan.key)) continue;
        const { info } = plan;
        dispatch.classes.add(plan.key);
        const loc = dispatch.fn.loc;
        const { receiver, condition } = this.propertyReceiver(plan, loc);
        const memberBody = (name: string): IrStmt[] => {
          if (!dispatch.probe) return this.propertyBody(lowerer, { ...dispatch, name }, info, receiver);
          const prototypeMethod = lowerer.prototypeMethodAccesses.has(name);
          if (info.fields.has(name) || dispatch.probe === "in" && !prototypeMethod) {
            return [{ kind: "return", value: { kind: "boolLit", value: true, type: BOOL, loc }, loc }];
          }
          if (prototypeMethod) classPrototypeData(lowerer, info, loc, receiver);
          const bag: IrExpr = { kind: "call", callee: this.propertyBag!.name,
            args: [lowerer.coerceToExpected(receiver, DYN)], type: DYN, loc };
          const symbol = name.startsWith("sym:") || name.startsWith("%symbol:");
          const fn = dispatch.probe === "in" ? "dyn.hasKey" : dispatch.probe === "own" ? "dyn.hasOwn" : "dyn.propertyIsEnumerable";
          return [{ kind: "return", value: { kind: "libCall", fn: symbol ? `${fn}Computed` : fn,
            args: [bag, symbol ? varRef("p.key", DYN, loc) : { kind: "strLit", value: name, type: STRING, loc }], type: BOOL, loc }, loc }];
        };
        if (dispatch.dynamicKey) {
          const symbols = new Map<string, IrExpr>();
          const symbolEntries: [ts.Symbol, string][] = [];
          if (info.symbolFields) for (const [symbol, name] of info.symbolFields) symbolEntries.push([symbol, name]);
          if (info.symbolMethods) for (const [symbol, name] of info.symbolMethods) symbolEntries.push([symbol, name]);
          for (const [symbol, name] of symbolEntries) {
            const declaration = lowerer.checker.valueDeclarationOf(symbol);
            if (declaration && ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
              const global = lowerer.globalsBySymbol.get(symbol);
              if (global) symbols.set(name, lowerer.coerceToExpected(varRef(global.id, global.type, loc), DYN));
            }
          }
          for (let owner: ClassInfo | null = info; owner; owner = owner.base) {
            for (const name of [...owner.methods.keys()]) if (name.startsWith("sym:")) {
              symbols.set(name, { kind: "dynFrom", type: DYN, loc, value: {
                kind: "libCall", fn: "sym.wellKnown", args: [{ kind: "strLit", value: name.slice(4), type: STRING, loc }], type: SYMBOL_T, loc,
              } });
            }
          }
          const branches: IrStmt[] = [];
          for (const [name, symbol] of symbols) {
            const before = lowerer.diags.length;
            let then: IrStmt[];
            try { then = memberBody(name); }
            catch (error) {
              if (!(error instanceof PoisonError) || !info.decl) throw error;
              const fence = lowerer.deferToRuntimeFence(before, info.decl, { kind: "statement" });
              if (!fence) throw error;
              then = [fence];
            }
            branches.push({ kind: "if", cond: { kind: "dynScalarEq", left: varRef("p.key", DYN, loc), right: symbol, type: BOOL, loc }, then, else_: null, loc });
          }
          if (branches.length) {
            dispatch.fn.body.unshift({ kind: "if", cond: condition, then: [
              { kind: "if", cond: { kind: "dynTest", test: "symbol", value: varRef("p.key", DYN, loc), type: BOOL, loc }, then: branches, else_: null, loc },
            ], else_: null, loc });
            dispatch.branchIndex++;
          }
        }
        const names = new Set([...info.fields.keys()].filter(isClassOwnEnumerableFieldName));

        for (let owner: ClassInfo | null = info; owner; owner = owner.base) {
          const methodNames = [...owner.methods.keys()];
          if (owner.genericMethods) methodNames.push(...[...owner.genericMethods.keys()]);
          for (const method of methodNames) {
            const name = method.startsWith("get:") || method.startsWith("set:") ? method.slice(4) : method;
            if (isClassOwnEnumerableFieldName(name) && !name.startsWith("sym:")) names.add(name);
          }
        }
        const branch: IrStmt[] = [];
        for (const name of names) {
          const before = lowerer.diags.length;
          let body: IrStmt[];
          try {
            body = memberBody(name);
          } catch (error) {
            if (!(error instanceof PoisonError) || !info.decl) throw error;
            const fence = lowerer.deferToRuntimeFence(before, info.decl, { kind: "statement" });
            if (!fence) throw error;
            body = [fence];
          }
          branch.push({ kind: "if", cond: {
            kind: "strEq", left: varRef(dispatch.keyLocal, STRING, loc), right: { kind: "strLit", value: name, type: STRING, loc }, negated: false, type: BOOL, loc,
          }, then: body, else_: null, loc });
        }
        // Keep each class's key table in a separate function. A single
        // function containing every boxed class grows quadratically during
        // LLVM's control-flow optimization for large library workloads.
        const params = [...dispatch.fn.params];
        if (dispatch.keyLocal !== "p.key") params.push({ localId: dispatch.keyLocal, name: "key", type: STRING });
        const helper: IrFunction = {
          name: `%dyn.class.keys.${lowerer.liftedFns.length}`, params, returnType: dispatch.fn.returnType,
          locals: params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
          body: [...branch, ...dispatch.fn.body.slice(dispatch.write ? -2 : -1)], loc,
        };
        this.generated.add(helper);
        lowerer.liftedFns.push(helper);
        const call: IrExpr = { kind: "call", callee: helper.name,
          args: params.map((p) => varRef(p.localId, p.type, loc)), type: helper.returnType, loc };
        const then: IrStmt[] = dispatch.write
          ? [{ kind: "exprStmt", expr: call, loc }, { kind: "return", value: null, loc }]
          : [{ kind: "return", value: call, loc }];
        dispatch.fn.body.splice(dispatch.branchIndex, 0, { kind: "if", cond: condition, then, else_: null, loc });
        changed = true;
      }
    }
    if (this.constructDispatch) for (const [name, info] of this.constructors) {
      if (this.constructed.has(name)) continue;
      this.constructed.add(name);
      const loc = this.constructDispatch.loc;
      const callee = varRef("p.0", DYN, loc), input = varRef("p.1", DYN, loc);
      const args: IrExpr[] = [];
      let supported = true;
      for (let i = 0; i < info.ctorParams.length; i++) {
        const param = info.ctorParams[i]!;
        if (param.mode !== "required" && param.mode !== "omittable") { supported = false; break; }
        const value: IrExpr = { kind: "dynKeyGet", value: input, key: { kind: "strLit", value: String(i), type: STRING, loc }, type: DYN, loc };
        const arg = lowerer.coerceToExpected(value, param.type);
        if (!typeEquals(arg.type, param.type)) { supported = false; break; }
        args.push(arg);
      }
      if (!supported || !info.decl) continue;
      const cls = classValueRef(lowerer, info, info.decl);
      const result: IrExpr = { kind: "new", className: name, args, type: {kind: "object", className: name}, loc };
      this.constructDispatch.body.unshift({ kind: "if", cond: {kind: "dynScalarEq", left: callee,
        right: lowerer.coerceToExpected(cls, DYN), type: BOOL, loc}, then: [
          { kind: "return", value: lowerer.coerceToExpected(result, DYN), loc },
        ], else_: null, loc });
      changed = true;
    }
    return changed;
  }

  /** A known native class can access its shared bag directly. Keep the
   * receiver as an owned parameter so calls and temporary instances retain
   * their ordinary evaluation and lifetime rules without a boxed capsule. */
  private typedPropertyBag(lowerer: Lowerer, type: Extract<IrType, { kind: "object" }>, loc: SrcLoc): IrFunction | null {
    const existing = this.typedPropertyBags.get(type.className);
    if (existing) return existing;
    const initializers = this.bagInitializers.get(type.className);
    if (!initializers) return null;
    const receiver = varRef("p.0", type, loc);
    const bag: IrExpr = { kind: "fieldGet", obj: receiver, className: type.className, field: PROPERTY_BAG, type: DYN, loc };
    const initialize: Extract<IrStmt, { kind: "fieldSet" }> = { ...initializers[0]!, obj: receiver,
      value: transformExpr(initializers[0]!.value, { stmt: (stmt) => stmt, expr: (expr) =>
        expr.kind === "dynCheck" && expr.value.kind === "varRef" && expr.value.localId === "p.0" ? receiver : expr }), loc };
    const helper: IrFunction = {
      name: `%class.properties:${type.className}`, params: [{ localId: "p.0", name: "value", type }], returnType: DYN,
      locals: [{ id: "p.0", name: "value", type, mutable: false }], loc,
      body: [
        { kind: "if", cond: { kind: "dynTest", test: "undefined", value: bag, type: BOOL, loc }, then: [initialize], else_: null, loc },
        { kind: "return", value: bag, loc },
      ],
    };
    initializers.push(initialize);
    this.typedPropertyBags.set(type.className, helper);
    this.generated.add(helper);
    lowerer.liftedFns.push(helper);
    return helper;
  }

  /** The hidden bag is part of the native object layout, so every capsule
   * shares it and normal class tracing/disposal owns its values. Insert it
   * at the same prefix offset throughout a hierarchy, including classes
   * collected before this untyped crossing was discovered. */
  private ensurePropertyBag(info: ClassInfo): void {
    if (info.fields.has(PROPERTY_BAG)) return;
    let root = info;
    while (root.base && !root.base.def.runtime) root = root.base;
    const index = root.def.fields.length;
    const add = (current: ClassInfo): void => {
      if (!current.fields.has(PROPERTY_BAG)) {
        current.fields.set(PROPERTY_BAG, DYN);
        current.def.fields.splice(index, 0, { name: PROPERTY_BAG, type: DYN });
      }
      current.subclasses.forEach(add);
    };
    add(root);
  }

  /** A capsule retains its static type, while its object may be a subclass.
   * Preorder insertion lets later branches test the most derived layout first. */
  private propertyReceivers(lowerer: Lowerer): PropertyReceiver[] {
    const plans: PropertyReceiver[] = [];
    for (const name of this.boxed) {
      const capsule = lowerer.classes.get(name);
      if (!capsule || capsule.builtinEmitter || capsule.builtinStream || capsule.builtinError) continue;
      const visit = (info: ClassInfo): void => {
        plans.push({ info, capsule, key: JSON.stringify([name, info.def.name]) });
        for (const child of info.subclasses) visit(child);
      };
      visit(capsule);
    }
    return plans;
  }

  private propertyReceiver(plan: PropertyReceiver, loc: SrcLoc): { receiver: IrExpr; condition: IrExpr } {
    const value = varRef("p.0", DYN, loc);
    const type: IrType = { kind: "object", className: plan.capsule.def.name };
    const checked: IrExpr = { kind: "dynCheck", value, type, loc };
    const matches: IrExpr = { kind: "libCall", fn: "dyn.typedRefIs", args: [value,
      { kind: "strLit", value: typeKey(type), type: STRING, loc }], type: BOOL, loc };
    if (plan.info === plan.capsule) return { receiver: checked, condition: matches };
    return {
      receiver: { kind: "downcast", value: checked, type: { kind: "object", className: plan.info.def.name }, loc },
      condition: { kind: "ternary", cond: matches, then: { kind: "instanceOf", value: checked,
        className: plan.info.def.name, type: BOOL, loc }, else_: { kind: "boolLit", value: false, type: BOOL, loc }, type: BOOL, loc },
    };
  }

  private propertyBody(lowerer: Lowerer, dispatch: PropertyDispatch, info: ClassInfo, receiver: IrExpr): IrStmt[] {
    const { name, write } = dispatch;
    const loc = dispatch.fn.loc;
    const field = info.fields.get(name);
    const member = `${write ? "set" : "get"}:${name}`;
    const accessor = field ? null : findMethodOn(lowerer, info, member);
    const fence = (): IrStmt[] => [{ kind: "runtimeFence", code: "SC2020", message: `${write ? "writing" : "reading"} '${name}' on this native class through an untyped value is not supported yet`, loc }];
    const getRecord = (id: string) => lowerer.shapes.get(id);
    const getUnion = (id: string) => lowerer.unions.get(id);
    if (!write) {
      if (name === "constructor" && !field && !accessor && info.decl && !info.generic && !info.localClass && !info.classDecorators) {
        this.constructors.set(info.def.name, info);
        const cls = lowerer.coerceToExpected(classValueRef(lowerer, info, info.decl), DYN);
        const bag: IrExpr = { kind: "call", callee: this.propertyBag!.name, args: [lowerer.coerceToExpected(receiver, DYN)], type: DYN, loc };
        const key: IrExpr = { kind: "strLit", value: name, type: STRING, loc };
        return [{ kind: "return", value: { kind: "ternary", cond: { kind: "libCall", fn: "dyn.hasKey", args: [bag, key], type: BOOL, loc },
          then: { kind: "dynKeyGet", value: bag, key, type: DYN, loc }, else_: cls, type: DYN, loc }, loc }];
      }
      if (name === "toString" && findMethodOn(lowerer, info, name)?.declarer.builtinError) {
        return [{ kind: "return", value: errorToStringMethod(lowerer, receiver), loc }];
      }
      if (!field && !accessor && info.decl) {
        const declared = findMethodOn(lowerer, info, name);
        // Untyped dispatch considers native classes that may never reach
        // this lookup. Libraries cannot expose fibers or promises through
        // those speculative branches. Direct typed references still reach
        // the ordinary graph-wide async_free diagnostic.
        if (this.asyncFree && (declared?.sig.gen || declared?.sig.async)) {
          return [{ kind: "runtimeFence", code: "SC4005", message: `reading async or generator method '${name}' through an untyped library lookup is not supported`, loc }];
        }
        const generic = findGenericMethodOn(lowerer, info, name);
        // A computed lookup has branches for every visible name. Generic
        // methods need a concrete specialization before they can escape;
        // refuse only if this runtime branch is selected.
        if (generic && (!generic.info.implicitParams || !generic.declarer.decl ||
            lowerer.overrideBelow(info, name) || genericOverrideBelow(lowerer, info, name))) return fence();
        const method = classMethodValue(lowerer, info.decl, info, name, loc);
        if (method && canConvertToDyn(method.type, getRecord, getUnion)) {
          // A capsule may have the base ABI even when its native object is
          // a subclass (for example an inherited iterator returning this).
          // Select the method declaration at extraction, before detaching it.
          const overrides = [...lowerer.classes.values()].filter((candidate) =>
            candidate !== info && lowerer.isSubclassOf(candidate.def.name, info.def.name) &&
            (candidate.methods.has(name) || candidate.genericMethods?.has(name)));
          overrides.sort((a, b) => lowerer.isSubclassOf(a.def.name, b.def.name) ? -1 : lowerer.isSubclassOf(b.def.name, a.def.name) ? 1 : 0);
          const body: IrStmt[] = [];
          if (isClassOwnEnumerableFieldName(name) && !name.startsWith("sym:")) {
            const prototypeMethod = lowerer.prototypeMethodAccesses.has(name);
            if (prototypeMethod) classPrototypeData(lowerer, info, loc, receiver);
            const bag: IrExpr = { kind: "call", callee: this.propertyBag!.name,
              args: [lowerer.coerceToExpected(receiver, DYN)], type: DYN, loc };
            const key: IrExpr = { kind: "strLit", value: name, type: STRING, loc };
            body.push({ kind: "if", cond: { kind: "libCall", fn: "dyn.hasKey", args: [bag, key], type: BOOL, loc },
              then: [{ kind: "return", value: { kind: "dynKeyGet", value: bag, key, type: DYN, loc }, loc }], else_: null, loc });
            if (prototypeMethod) {
              body.push({ kind: "return", value: dynUndefinedExpr(loc), loc });
              return body;
            }
          }
          for (const candidate of overrides) {
            const selected = classMethodValue(lowerer, info.decl, candidate, name, loc);
            const branch: IrStmt[] = selected && canConvertToDyn(selected.type, getRecord, getUnion)
              ? [{ kind: "return", value: { kind: "dynFrom", value: selected, type: DYN, loc }, loc }]
              : fence();
            body.push({ kind: "if", cond: { kind: "instanceOf", value: receiver, className: candidate.def.name, type: BOOL, loc }, then: branch, else_: null, loc });
          }
          body.push({ kind: "return", value: { kind: "dynFrom", value: method, type: DYN, loc }, loc });
          return body;
        }
      }
      if (!field && !accessor) return [{ kind: "return", value: dynUndefinedExpr(loc), loc }];
      const type = field ?? accessor!.sig.ret;
      if (!canConvertToDyn(type, getRecord, getUnion)) return fence();
      const value: IrExpr = field
        ? { kind: "fieldGet", obj: receiver, className: info.def.name, field: name, type, loc }
        : accessorCall(lowerer, info.def.name, member, receiver, [], type, loc);
      const boxed = lowerer.coerceToExpected(value, DYN);
      const mutable = (t: IrType): boolean => streamTypedRefEligible(t) ||
        (t.kind === "union" && (getUnion(t.unionId)?.arms.some(mutable) ?? false));
      if (boxed.kind === "dynFrom" && mutable(boxed.value.type)) boxed.liveRef = true;
      return [{ kind: "return", value: boxed, loc }];
    }
    if (!field && !accessor && isClassOwnEnumerableFieldName(name) && !name.startsWith("sym:") && !findMethodOn(lowerer, info, `get:${name}`)) {
      const bag: IrExpr = { kind: "call", callee: this.propertyBag!.name,
        args: [lowerer.coerceToExpected(receiver, DYN)], type: DYN, loc };
      return [{ kind: "exprStmt", expr: { kind: "libCall", fn: "dyn.keySet", args: [bag,
        { kind: "strLit", value: name, type: STRING, loc }, varRef("p.1", DYN, loc)], type: VOID, loc }, loc },
      { kind: "return", value: null, loc }];
    }
    if (!field && !accessor) return [{ kind: "throw", value: {
      kind: "libCall", fn: "error.new", args: [{
        kind: "strLit", value: `Cannot set property ${name} of #<${info.def.jsName ?? info.def.name}> which has only a getter`, type: STRING, loc,
      }], type: { kind: "object", className: "%TypeError" }, loc,
    }, loc }];
    const type = field ?? accessor!.sig.params[0]!.type;
    const checkable = (t: IrType): boolean => isDynTypedRefType(t) || isUnitType(t) ||
      (t.kind === "union" ? getUnion(t.unionId)?.arms.every(checkable) ?? false : canDynCheckTo(t, getRecord, getUnion));
    if (!checkable(type)) return fence();
    const value = lowerer.coerceToExpected(varRef("p.1", DYN, loc), type);
    if (!typeEquals(value.type, type)) return fence();
    const store: IrStmt = field
      ? { kind: "fieldSet", obj: receiver, className: info.def.name, field: name, value, loc }
      : { kind: "exprStmt", expr: accessorCall(lowerer, info.def.name, member, receiver, [value], VOID, loc), loc };
    return [store, { kind: "return", value: null, loc }];
  }

  private methodBody(lowerer: Lowerer, dispatch: Dispatch, info: ClassInfo, receiver: IrExpr): IrStmt[] {
    const { method, loc } = dispatch.source;
    const fence = (): IrStmt[] => [{ kind: "runtimeFence", code: "SC2020", message: `calling '${method}' on this native class through an untyped value is not supported yet`, loc }];
    const methodInfo = findMethodOn(lowerer, info, method);
    if (this.asyncFree && (methodInfo?.sig.gen || methodInfo?.sig.async)) {
      return [{ kind: "runtimeFence", code: "SC4005", message: `calling async or generator method '${method}' through an untyped library value is not supported`, loc }];
    }
    if (methodInfo?.declarer.builtinError && method === "toString") {
      return [{ kind: "return", value: { kind: "dynFrom", value: errorToStringCall(lowerer, receiver), type: DYN, loc }, loc }];
    }
    const generic = methodInfo ? null : findGenericMethodOn(lowerer, info, method);
    let params: ParamShape[];
    let result: IrType;
    let callee: string;
    let virtual = false;
    let owner: ClassInfo;
    if (methodInfo) {
      owner = methodInfo.declarer;
      params = methodInfo.sig.params;
      result = methodInfo.sig.ret;
      callee = `%${owner.def.name}.${method}`;
      virtual = lowerer.overrideBelow(owner, method) || methodInfo.sig.abstract === true;
    } else if (generic?.info.implicitParams && generic.declarer.decl &&
        !lowerer.overrideBelow(info, method) && !genericOverrideBelow(lowerer, info, method)) {
      owner = generic.declarer;
      // A failed eager specialization leaves a signature in the instance
      // cache, but no body. Later dispatch arities must retain the fence
      // instead of turning that cached signature into an unresolved call.
      const instance = implicitDefaultInstance(lowerer, generic.declarer.decl, generic.info);
      if (!lowerer.implicitFns.some((fn) => fn.name === instance.name)) return fence();
      params = instance.params;
      result = instance.returnType;
      callee = instance.name;
    } else return fence();
    const incoming = dispatch.source.args.map((_, i) => varRef(`p.${i + 1}`, DYN, loc));
    const args: IrExpr[] = [];
    let index = 0;
    for (const param of params) {
      if ((param.mode === "dynRest" || param.mode === "arguments") && param.type.kind === "dyn") {
        args.push({ kind: "dynArrLit", elems: param.mode === "arguments" ? incoming : incoming.slice(index), type: DYN, loc });
        index = incoming.length;
        continue;
      }
      if (param.mode === "rest" && param.type.kind === "array") {
        const element = param.type.elem;
        const elems = incoming.slice(index).map((value) => lowerer.coerceToExpected(value, element));
        if (elems.some((value) => !typeEquals(value.type, element))) return fence();
        args.push({ kind: "arrayLit", elems, type: param.type, loc });
        index = incoming.length;
        continue;
      }
      if (param.mode !== "required" && param.mode !== "omittable") return fence();
      const value = incoming[index++] ?? param.callDefault ?? dynUndefinedExpr(loc);
      const converted = lowerer.coerceToExpected(value, param.type);
      if (!typeEquals(converted.type, param.type)) return fence();
      args.push(converted);
    }
    const call: IrExpr = virtual
      ? { kind: "virtualCall", className: owner.def.name, method, args: [upcastTo(lowerer, receiver, owner.def.name), ...args], type: result, loc }
      : { kind: "call", callee, args: [upcastTo(lowerer, receiver, owner.def.name), ...args], type: result, loc };
    let body: IrStmt[];
    if (result.kind === "void") body = [
      { kind: "exprStmt", expr: call, loc },
      { kind: "return", value: dynUndefinedExpr(loc), loc },
    ];
    else {
      const boxed = lowerer.coerceToExpected(call, DYN);
      if (boxed.type.kind !== "dyn") return fence();
      body = [{ kind: "return", value: boxed, loc }];
    }
    if (methodInfo) {
      if (virtual) lowerer.noteVirtualEdge(owner, method);
      else lowerer.noteEdge(callee);
    }
    if (isClassCallback(lowerer, info, method)) {
      const descriptor = varRef("p.callback", DYN, loc);
      body.unshift({ kind: "if", cond: { kind: "dynTest", test: "undefined", negated: true, value: descriptor, type: BOOL, loc }, then: [
        { kind: "return", value: { kind: "dynCall", callee: { kind: "dynKeyGet", value: descriptor,
          key: { kind: "strLit", value: "value", type: STRING, loc }, type: DYN, loc }, receiver: varRef("p.0", DYN, loc),
          args: incoming, calleeName: dispatch.source.calleeName, type: DYN, loc }, loc },
      ], else_: null, loc });
    }
    return body;
  }
}
