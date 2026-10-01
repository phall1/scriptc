import * as ts from "../ts7/adapter.js";
import { BOOL, DYN, STRING, RUNTIME_ERROR_CLASSES, typeEquals, typeKey, type IrExpr, type IrFunction, type IrStmt, type IrType, type SrcLoc } from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import { everyStmtList, transformStmtList } from "../../ir/traverse.js";
import { isJsSourceFile, locOf } from "../program.js";
import { newFnCtx, type Lowerer } from "./lowerer.js";
import { classMemberNameOf, findGenericMethodOn, findMethodOn, genericOverrideBelow, type ClassInfo } from "./lower-classes.js";
import { funcTypeFromParamShapes, implicitDefaultInstance, type ParamShape } from "./lower-calls.js";
import { errorToStringMethod } from "./error-methods.js";
import { classCallbackValue, isClassCallback } from "./class-callbacks.js";

/** A method value retains its declaration's identity, not the receiver from
 * extraction. Its native thunk validates the receiver supplied at call time. */
export function lowerClassMethodValue(lowerer: Lowerer, expr: ts.PropertyAccessExpression, info: ClassInfo): IrExpr | null {
  const method = expr.name.text;
  if (method === "toString" && findMethodOn(lowerer, info, method)?.declarer.builtinError) {
    return errorToStringMethod(lowerer, lowerer.lowerExpr(expr.expression));
  }
  let value = methodValue(lowerer, expr, info);
  if (!value) return null;
  const loc = locOf(expr);
  const callback = isClassCallback(lowerer, info, method);
  const receiver = lowerer.lowerExpr(expr.expression);
  const local = callback ? lowerer.declareHiddenLocal("%callbackReceiver", receiver.type) : null;
  const reference = local ? varRef(local.id, receiver.type, loc) : receiver;
  const finish = (result: IrExpr): IrExpr => {
    if (!local) return result;
    const selected = classCallbackValue(lowerer, reference, method, result, loc);
    return { kind: "seqExpr", stmts: [{ kind: "varDecl", localId: local.id, init: receiver, loc }], result: selected, type: selected.type, loc };
  };
  const overrides = [...lowerer.classes.values()].filter((candidate) =>
    candidate !== info && lowerer.isSubclassOf(candidate.def.name, info.def.name) && candidate.methods.has(method));
  const checked = isJsSourceFile(expr.getSourceFile()) && lowerer.dynConvertible(value.type) && overrides.every((candidate) => {
    const selected = methodValue(lowerer, expr, candidate);
    return selected !== null && lowerer.dynConvertible(selected.type);
  });
  if (checked && overrides.length) value = lowerer.coerceToExpected(value, DYN);
  if (overrides.length === 0) {
    return finish({ kind: "seqExpr", stmts: [{ kind: "exprStmt", expr: reference, loc }], result: value, type: value.type, loc });
  }
  // Select the declaration when extracting the value. Calling the value
  // later must not redispatch the method name on a different receiver.
  const name = `%method.select:${info.def.name}.${method}`;
  const receiverType: IrType = { kind: "object", className: info.def.name };
  if (!lowerer.liftedFns.some((fn) => fn.name === name)) {
    const receiver = varRef("this.0", receiverType, loc);
    const body: IrStmt[] = [];
    overrides.sort((a, b) => lowerer.isSubclassOf(a.def.name, b.def.name) ? -1 : lowerer.isSubclassOf(b.def.name, a.def.name) ? 1 : 0);
    for (const candidate of overrides) {
      let selected = methodValue(lowerer, expr, candidate);
      if (selected && checked) selected = lowerer.coerceToExpected(selected, DYN);
      if (!selected || !typeEquals(selected.type, value.type)) {
        lowerer.unsupported("SC1090", expr, "method values with incompatible override signatures");
      }
      body.push({ kind: "if", cond: { kind: "instanceOf", value: receiver, className: candidate.def.name, type: BOOL, loc }, then: [{ kind: "return", value: selected, loc }], else_: null, loc });
    }
    body.push({ kind: "return", value, loc });
    lowerer.liftedFns.push({ name, params: [{ localId: "this.0", name: "this", type: receiverType }], returnType: value.type,
      locals: [{ id: "this.0", name: "this", type: receiverType, mutable: false }], body, loc });
  }
  return finish({ kind: "call", callee: name, args: [reference], type: value.type, loc });
}

function methodValue(lowerer: Lowerer, expr: ts.PropertyAccessExpression, info: ClassInfo): IrExpr | null {
  return classMethodValue(lowerer, expr, info, expr.name.text, locOf(expr));
}

export function classMethodValue(lowerer: Lowerer, blame: ts.Node, info: ClassInfo, method: string, loc: SrcLoc): IrExpr | null {
  const found = findMethodOn(lowerer, info, method);
  const generic = found ? null : findGenericMethodOn(lowerer, info, method);
  if (!found && !generic) return null;
  const declaration = found?.declarer ?? generic!.declarer;
  const reflected = declaration.prototypeMethodValues?.get(method);
  if (reflected) return reflected;
  const checkedMethod = reflectedClassMethodValue(lowerer, declaration, method);
  if (checkedMethod) return checkedMethod;
  let owner: ClassInfo;
  let params: ParamShape[];
  let ret: IrType;
  let callee: string;
  if (found) {
    owner = found.declarer;
    if (found.sig.abstract) lowerer.unsupported("SC1090", blame, "values of abstract method declarations");
    params = found.sig.params;
    ret = found.sig.ret;
    callee = `%${owner.def.name}.${method}`;
    if (!owner.builtinError) lowerer.noteEdge(callee);
  } else if (generic?.info.implicitParams && generic.declarer.decl &&
      !lowerer.overrideBelow(info, method) && !genericOverrideBelow(lowerer, info, method)) {
    owner = generic.declarer;
    const instance = implicitDefaultInstance(lowerer, owner.decl!, generic.info);
    params = instance.params;
    ret = instance.returnType;
    callee = instance.name;
  } else {
    lowerer.unsupported("SC1090", blame, "values of builtin or unspecialized generic methods");
  }
  const type = funcTypeFromParamShapes(params, ret);
  const name = `%method.value:${callee}`;
  if (!lowerer.liftedFns.some((fn) => fn.name === name)) {
    const thunkParams = params.map((param, i) => ({ localId: `p.${i}`, name: `p${i}`, type: param.type }));
    const receiverType: IrType = { kind: "object", className: owner.def.name };
    const receiverName = `%method.receiver:${owner.def.name}`;
    if (!lowerer.liftedFns.some((fn) => fn.name === receiverName)) {
      lowerer.liftedFns.push({ name: receiverName, params: [{ localId: "this.0", name: "this", type: DYN }], returnType: receiverType,
        locals: [{ id: "this.0", name: "this", type: DYN, mutable: false }],
        body: [{ kind: "return", value: { kind: "dynCheck", value: varRef("this.0", DYN, loc), type: receiverType, loc }, loc }], loc });
    }
    const receiver: IrExpr = { kind: "call", callee: receiverName,
      args: [{ kind: "libCall", fn: "dyn.this", args: [], type: DYN, loc }], type: receiverType, loc };
    const call: IrExpr = owner.builtinError ? {
      kind: "libCall", fn: "error.toString", args: [receiver], type: ret, loc,
    } : {
      kind: "call", callee, args: [receiver, ...thunkParams.map((p) => varRef(p.localId, p.type, loc))], type: ret, loc,
    };
    const fn: IrFunction = {
      name, params: thunkParams, returnType: ret,
      locals: thunkParams.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
      body: ret.kind === "void"
        ? [{ kind: "exprStmt", expr: call, loc }, { kind: "return", value: null, loc }]
        : [{ kind: "return", value: call, loc }], loc,
    };
    lowerer.liftedFns.push(fn);
  }
  return { kind: "closure", fnName: name, captures: [], type, loc };
}

/** Public JS prototype methods are ordinary callables over their actual
 * receiver, including descriptor-created copies of class instances. */
export function reflectedClassMethodValue(lowerer: Lowerer, info: ClassInfo, method: string): IrExpr | null {
  const existing = info.prototypeMethodValues?.get(method);
  if (existing) return existing;
  const declaration = info.decl;
  if (!declaration) return null;
  const member = declaration.members.find((member) => {
    if ((!ts.isMethodDeclaration(member) && !ts.isAccessor(member)) || !member.name ||
        ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)) return false;
    const name = classMemberNameOf(lowerer, member.name);
    return (ts.isMethodDeclaration(member) ? name : ts.isGetAccessor(member) ? `get:${name}` : ts.isSetAccessor(member) ? `set:${name}` : null) === method;
  });
  if (!member || (!ts.isMethodDeclaration(member) && !ts.isAccessor(member)) || !member.body) return null;
  let needsNativeReceiver = !isJsSourceFile(declaration.getSourceFile()) || info.localClass !== undefined ||
    lowerer.errorHierarchyClassOf(info.def.name);
  ts.walkPreorder(member, (node) => {
    if (ts.isPrivateIdentifier(node) || node.kind === ts.SyntaxKind.SuperKeyword) needsNativeReceiver = true;
  });
  if (needsNativeReceiver) return null;
  const context = newFnCtx(false, null, null, DYN);
  const previousClass = lowerer.currentClass;
  lowerer.currentClass = info;
  lowerer.fnStack.push(context);
  try {
    const value = lowerer.lowerLambda(member);
    if (value.kind === "closure" && value.captures.length === 0) {
      const body = lowerer.liftedFns.find((fn) => fn.name === value.fnName);
      if (body?.captures?.length === 0) delete body.captures;
    }
    (info.prototypeMethodValues ??= new Map()).set(method, value);
    return value;
  } finally {
    lowerer.fnStack.pop();
    lowerer.currentClass = previousClass;
  }
}

/** Complete adapters after all native class bodies and instantiations exist. */
export function finalizeClassMethodValues(lowerer: Lowerer, functions: IrFunction[]): void {
  const byName = new Map(functions.map((fn) => [fn.name, fn]));
  for (const fn of [...functions]) {
    if (fn.name.startsWith("%method.receiver:") && fn.returnType.kind === "object") {
      const owner = fn.returnType.className;
      const loc = fn.loc;
      const receiver = varRef("this.0", DYN, loc);
      const branches: IrStmt[] = [];
      if (lowerer.isSubclassOf(owner, "%Error")) {
        const base: IrExpr = { kind: "dynCheck", value: receiver, type: { kind: "object", className: "%Error" }, loc };
        branches.push({ kind: "if", cond: { kind: "dynTest", test: "error", value: receiver, type: BOOL, loc }, then: [
          { kind: "if", cond: { kind: "instanceOf", value: base, className: owner, type: BOOL, loc }, then: [
            { kind: "return", value: owner === "%Error" ? base : { kind: "downcast", value: base, type: fn.returnType, loc }, loc },
          ], else_: null, loc },
        ], else_: null, loc });
      }
      for (const info of lowerer.classes.values()) {
        const name = info.def.name;
        if (RUNTIME_ERROR_CLASSES.has(name)) continue;
        if (!lowerer.isSubclassOf(name, owner) && !lowerer.isSubclassOf(owner, name) && name !== owner) continue;
        const type: IrType = { kind: "object", className: name };
        const checked: IrExpr = { kind: "dynCheck", value: receiver, type, loc };
        const value: IrExpr = name === owner ? checked : lowerer.isSubclassOf(name, owner)
          ? { kind: "upcast", value: checked, type: fn.returnType, loc }
          : { kind: "downcast", value: checked, type: fn.returnType, loc };
        const returned: IrStmt = { kind: "return", value, loc };
        const then: IrStmt[] = name === owner || lowerer.isSubclassOf(name, owner) ? [returned] : [{
          kind: "if", cond: { kind: "instanceOf", value: checked, className: owner, type: BOOL, loc }, then: [returned], else_: null, loc,
        }];
        branches.push({ kind: "if", cond: { kind: "libCall", fn: "dyn.typedRefIs", args: [receiver, { kind: "strLit", value: typeKey(type), type: STRING, loc }], type: BOOL, loc }, then, else_: null, loc });
      }
      fn.body.unshift(...branches);
    }
    if (!fn.name.startsWith("%method.value:")) continue;
    const target = byName.get(fn.name.slice("%method.value:".length));
    const thisParam = target?.params[0];
    if (!target || !thisParam || target.async || target.generator) continue;
    const usesThis = !!target.classCaptures?.length || !everyStmtList(target.body, { stmt: () => true, expr: (expr) =>
      !(expr.kind === "varRef" && expr.localId === thisParam.localId) &&
      !(expr.kind === "closure" && expr.captures.includes(thisParam.localId)) });
    if (usesThis) continue;
    // A method that never uses this remains callable when detached.
    const name = `%method.receiverless:${target.name}`;
    functions.push({ ...target, name, params: target.params.slice(1), locals: target.locals.filter((local) => local.id !== thisParam.localId) });
    fn.body = transformStmtList(fn.body, { stmt: (stmt) => stmt, expr: (expr) =>
      expr.kind === "call" && expr.callee === target.name ? { ...expr, callee: name, args: expr.args.slice(1) } : expr });
  }
}
