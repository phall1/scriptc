import { BOOL, DYN, DYN_CLASS_PROPERTIES as PROPERTY_BAG, STRING, VOID, canConvertToDyn, canDynCheckTo, isClassOwnEnumerableFieldName, isDynTypedRefType, isUnitType, typeEquals, typeKey, type IrExpr, type IrFunction, type IrStmt, type IrType, type SrcLoc } from "../../ir/ir.js";
import { streamTypedRefEligible } from "../../ir/analysis.js";
import { varRef } from "../../ir/build.js";
import { everyStmtList, transformStmtList } from "../../ir/traverse.js";
import { dynUndefinedExpr, PoisonError, type Lowerer } from "./lowerer.js";
import { implicitDefaultInstance, type ParamShape } from "./lower-calls.js";
import { accessorCall, findGenericMethodOn, findMethodOn, genericOverrideBelow, upcastTo, type ClassInfo } from "./lower-classes.js";
import { classPrototypeData, hasClassPrototypeData } from "./class-prototypes.js";
import { isClassCallback } from "./class-callbacks.js";

type Invoke = Extract<IrExpr, { kind: "dynInvoke" }>;
interface Dispatch {
  source: Invoke;
  fn: IrFunction;
  callback: IrFunction;
  classes: Set<string>;
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
  private readonly boxed = new Set<string>();
  private readonly dispatches = new Map<string, Dispatch>();
  private readonly properties = new Map<string, PropertyDispatch>();
  private readonly computed = new Map<string, Omit<PropertyDispatch, "name"> & { keyLocal: string; branchIndex: number }>();
  private propertyBag: IrFunction | null = null;
  private readonly bagClasses = new Set<string>();
  private readonly bagInitializers = new Map<string, Extract<IrStmt, { kind: "fieldSet" }>>();
  private readonly generated = new Set<IrFunction>();
  private readonly instanceTests = new Map<string, Set<string>>();

  process(lowerer: Lowerer, functions: readonly IrFunction[]): boolean {
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
          case "dynKeyGet":
          case "dynInvoke":
            rewrite.add(fn);
            break;
          case "libCall":
            if (expr.fn === "dyn.keySet" || expr.fn === "dyn.keySetComputed") rewrite.add(fn);
            break;
        }
        return true;
      },
    });
    if (this.boxed.size === 0) return false;
    let changed = false;
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
      const existingInit = this.bagInitializers.get(className);
      if (existingInit && existingInit.value.kind === "dynObjLit" && hasClassPrototypeData(info)) {
        const prototype = classPrototypeData(lowerer, info, existingInit.loc);
        if (prototype) {
          existingInit.value = { kind: "libCall", fn: "dyn.objCreate", args: [prototype], type: DYN, loc: existingInit.loc };
          changed = true;
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
      const prototype = hasClassPrototypeData(info) ? classPrototypeData(lowerer, info, loc) : null;
      const initialize: Extract<IrStmt, { kind: "fieldSet" }> = {
        kind: "fieldSet", obj: receiver, className, field: PROPERTY_BAG, value: prototype
          ? { kind: "libCall", fn: "dyn.objCreate", args: [prototype], type: DYN, loc }
          : { kind: "dynObjLit", fields: [], type: DYN, loc }, loc,
      };
      this.bagInitializers.set(className, initialize);
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
          const computedRead = expr.kind === "dynKeyGet" && expr.key.kind !== "strLit" ? expr : null;
          const computedWrite = expr.kind === "libCall" && (expr.fn === "dyn.keySetComputed" || expr.fn === "dyn.keySet" && expr.args[1]?.kind !== "strLit") ? expr : null;
          if (computedRead || computedWrite) {
            const dynamicKey = computedWrite?.fn === "dyn.keySetComputed";
            const key = JSON.stringify([!!computedWrite, computedRead?.optional ?? false, dynamicKey]);
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
              const fallback: IrExpr = computedRead
                ? { ...computedRead, value: bag, key: varRef("p.key", STRING, loc) }
                : { ...computedWrite!, fn: "dyn.keySet", args: [bag, varRef(keyLocal, STRING, loc), varRef("p.1", DYN, loc)] };
              const helper: IrFunction = {
                name: `%dyn.class.computed.${this.computed.size}`, params, returnType: computedWrite ? VOID : DYN,
                locals: [...params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })), ...(dynamicKey ? [{ id: keyLocal, name: "key", type: STRING, mutable: false }] : [])],
                body: computedWrite
                  ? [{ kind: "exprStmt", expr: fallback, loc }, { kind: "return", value: null, loc }]
                  : [{ kind: "return", value: fallback, loc }], loc,
              };
              if (dynamicKey) helper.body.unshift(
                { kind: "if", cond: { kind: "dynTest", test: "nullish", value: varRef("p.0", DYN, loc), type: BOOL, loc }, then: [
                  { kind: "exprStmt", expr: { ...computedWrite!, args: [varRef("p.0", DYN, loc), varRef("p.key", DYN, loc), varRef("p.1", DYN, loc)] }, loc },
                  { kind: "return", value: null, loc },
                ], else_: null, loc },
                { kind: "varDecl", localId: keyLocal, init: { kind: "libCall", fn: "dyn.toStringCoerce", args: [varRef("p.key", DYN, loc)], type: STRING, loc }, loc },
              );
              dispatch = { write: !!computedWrite, fn: helper, classes: new Set(), keyLocal, branchIndex: dynamicKey ? 2 : 0 };
              this.computed.set(key, dispatch);
              this.generated.add(helper);
              lowerer.liftedFns.push(helper);
              changed = true;
            }
            return { kind: "call", callee: dispatch.fn.name, args: computedRead ? [computedRead.value, computedRead.key] : computedWrite!.args, type: dispatch.fn.returnType, loc: expr.loc };
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
              dispatch = { name, write: !!write, fn: helper, classes: new Set() };
              this.properties.set(key, dispatch);
              this.generated.add(helper);
              lowerer.liftedFns.push(helper);
              changed = true;
            }
            return { kind: "call", callee: dispatch.fn.name, args: read ? [read.value] : [write!.args[0]!, write!.args[2]!], type: dispatch.fn.returnType, loc: expr.loc };
          }
          if (expr.kind !== "dynInvoke" || candidates(expr.method).length === 0) return expr;
          const key = JSON.stringify([expr.method, expr.calleeName, expr.args.length]);
          let dispatch = this.dispatches.get(key);
          if (!dispatch) {
            const params = [expr.recv, ...expr.args].map((_, i) => ({ localId: `p.${i}`, name: `p${i}`, type: DYN }));
            params.splice(1, 0, { localId: "p.callback", name: "callback", type: DYN });
            const callback: IrFunction = {
              name: `%dyn.class.callback.${this.dispatches.size}`, params: [params[0]!], returnType: DYN,
              locals: [{ id: "p.0", name: "receiver", type: DYN, mutable: false }],
              body: [{ kind: "return", value: dynUndefinedExpr(expr.loc), loc: expr.loc }], loc: expr.loc,
            };
            const helper: IrFunction = {
              name: `%dyn.class.call.${this.dispatches.size}`, params, returnType: DYN,
              locals: params.map((p) => ({ id: p.localId, name: p.name, type: DYN, mutable: false })),
              body: [{ kind: "return", value: { ...expr, recv: varRef("p.0", DYN, expr.loc), args: expr.args.map((_, i) => varRef(`p.${i + 1}`, DYN, expr.loc)) }, loc: expr.loc }],
              loc: expr.loc,
            };
            dispatch = { source: expr, fn: helper, callback, classes: new Set() };
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
          return { kind: "seqExpr", stmts: [{ kind: "varDecl", localId: local.id, init: expr.recv, loc: expr.loc }], result: {
            kind: "call", callee: dispatch.fn.name, args: [receiver,
              { kind: "call", callee: dispatch.callback.name, args: [receiver], type: DYN, loc: expr.loc }, ...expr.args], type: DYN, loc: expr.loc,
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
          const bag: IrExpr = { kind: "call", callee: this.propertyBag!.name, args: [receiver], type: DYN, loc };
          dispatch.callback.body.unshift({ kind: "if", cond: {
            kind: "libCall", fn: "dyn.typedRefIs", args: [receiver, { kind: "strLit", value: typeKey(type), type: STRING, loc }], type: BOOL, loc,
          }, then: [{ kind: "return", value: { kind: "libCall", fn: "dyn.getOwnPropertyDescriptor", args: [bag,
            lowerer.coerceToExpected({ kind: "strLit", value: dispatch.source.method, type: STRING, loc }, DYN)], type: DYN, loc }, loc }], else_: null, loc });
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
      for (const info of this.propertyCandidates(lowerer, dispatch.name)) {
        if (dispatch.classes.has(info.def.name)) continue;
        dispatch.classes.add(info.def.name);
        const loc = dispatch.fn.loc;
        const type: IrType = { kind: "object", className: info.def.name };
        const receiver = varRef("p.0", DYN, loc);
        const before = lowerer.diags.length;
        let branch: IrStmt[];
        try {
          branch = this.propertyBody(lowerer, dispatch, info, { kind: "dynCheck", value: receiver, type, loc });
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
    for (const dispatch of this.computed.values()) {
      for (const className of this.boxed) {
        if (dispatch.classes.has(className)) continue;
        const info = lowerer.classes.get(className);
        if (!info || info.builtinEmitter || info.builtinStream || info.builtinError) continue;
        dispatch.classes.add(className);
        const loc = dispatch.fn.loc;
        const type: IrType = { kind: "object", className };
        const value = varRef("p.0", DYN, loc);
        const receiver: IrExpr = { kind: "dynCheck", value, type, loc };
        const names = new Set([...info.fields.keys()].filter(isClassOwnEnumerableFieldName));
        for (let owner: ClassInfo | null = info; owner; owner = owner.base) {
          for (const method of owner.methods.keys()) {
            if ((method.startsWith("get:") || method.startsWith("set:")) && isClassOwnEnumerableFieldName(method.slice(4))) names.add(method.slice(4));
          }
        }
        const branch: IrStmt[] = [];
        for (const name of names) {
          const before = lowerer.diags.length;
          let body: IrStmt[];
          try {
            body = this.propertyBody(lowerer, { ...dispatch, name }, info, receiver);
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
        dispatch.fn.body.splice(dispatch.branchIndex, 0, { kind: "if", cond: {
          kind: "libCall", fn: "dyn.typedRefIs", args: [value, { kind: "strLit", value: typeKey(type), type: STRING, loc }], type: BOOL, loc,
        }, then: branch, else_: null, loc });
        changed = true;
      }
    }
    return changed;
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

  private propertyCandidates(lowerer: Lowerer, name: string): ClassInfo[] {
    if (!isClassOwnEnumerableFieldName(name)) return [];
    return [...this.boxed].flatMap((className) => {
      const info = lowerer.classes.get(className);
      if (!info || info.builtinEmitter || info.builtinStream || info.builtinError) return [];
      return info.fields.has(name) || findMethodOn(lowerer, info, `get:${name}`) || findMethodOn(lowerer, info, `set:${name}`) ? [info] : [];
    });
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
    } else if (generic?.info.implicitParams && generic.declarer.decl && !genericOverrideBelow(lowerer, info, method)) {
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
