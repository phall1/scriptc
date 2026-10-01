import * as ts from "../ts7/adapter.js";
import { BOOL, DYN, STRING, VOID, type IrExpr, type IrStmt } from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import { classValueRef, upcastTo, type ClassInfo } from "./lower-classes.js";
import { classPropertiesHelper } from "./class-dynamic-dispatch.js";

/** Select the instance's concrete class before evaluating constructor
 * arguments. Each branch completes arguments against its own constructor,
 * including subclasses with different defaults or parameter counts. */
export function lowerInstanceConstructorNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  let access = expr.expression;
  while (ts.isParenthesizedExpression(access)) access = access.expression;
  if (!ts.isPropertyAccessExpression(access) || access.name.text !== "constructor" || access.questionDotToken) return null;
  let receiver = lowerer.lowerExpr(access.expression);
  const declared = receiver.type.kind === "dyn" ? lowerer.mapTypeOf(lowerer.typeOf(access.expression)) : null;
  if (declared?.kind === "object") receiver = lowerer.coerceToExpected(receiver, declared);
  if (receiver.type.kind !== "object") return null;
  const info = lowerer.classes.get(receiver.type.className);
  if (!info || info.def.runtime) return null;
  const loc = locOf(expr);
  const local = lowerer.declareHiddenLocal("%constructorReceiver", receiver.type);
  const value = varRef(local.id, receiver.type, loc);
  const construct = (current: ClassInfo): IrExpr => {
    if (current.fields.has("constructor") || current.generic || current.localClass || current.classDecorators) {
      lowerer.unsupported("SC1090", expr, "instance constructors on generic, local, decorated, or constructor-shadowing classes");
    }
    classValueRef(lowerer, current, expr);
    const result: IrExpr = {
      kind: "new", className: current.def.name,
      args: lowerer.completeArgs(expr.arguments ?? [], current.ctorParams, loc, expr),
      type: { kind: "object", className: current.def.name }, loc,
    };
    return upcastTo(lowerer, result, info.def.name);
  };
  const visit = (current: ClassInfo): IrExpr => {
    let result = construct(current);
    for (const child of current.subclasses) result = {
      kind: "ternary", cond: { kind: "instanceOf", value, className: child.def.name, type: BOOL, loc },
      then: visit(child), else_: result, type: receiver.type, loc,
    };
    return result;
  };
  const bag: IrExpr = { kind: "call", callee: classPropertiesHelper(lowerer, loc).name,
    args: [lowerer.coerceToExpected(value, DYN)], type: DYN, loc };
  const check = "%class.constructor.check";
  if (!lowerer.liftedFns.some((fn) => fn.name === check)) lowerer.liftedFns.push({
    name: check, params: [{ localId: "bag", name: "bag", type: DYN }], returnType: VOID,
    locals: [{ id: "bag", name: "bag", type: DYN, mutable: false }], loc,
    body: [{ kind: "if", cond: { kind: "libCall", fn: "dyn.hasOwn", args: [varRef("bag", DYN, loc),
      { kind: "strLit", value: "constructor", type: STRING, loc }], type: BOOL, loc }, then: [
      { kind: "runtimeFence", code: "SC1090", message: "construction through a replaced instance constructor is not supported yet", loc },
    ], else_: null, loc }, { kind: "return", value: null, loc }],
  });
  const stmts: IrStmt[] = [
    { kind: "varDecl", localId: local.id, init: receiver, loc },
    { kind: "exprStmt", expr: { kind: "call", callee: check, args: [bag], type: VOID, loc }, loc },
  ];
  return { kind: "seqExpr", stmts, result: visit(info), type: receiver.type, loc };
}
