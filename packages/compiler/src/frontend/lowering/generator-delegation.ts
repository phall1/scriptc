import * as ts from "../ts7/adapter.js";
import { BOOL, DYN, F64, STRING, canConvertToDyn, type IrExpr, type IrStmt } from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import { locOf } from "../program.js";
import { dynUndefinedExpr, type Lowerer } from "./lowerer.js";

/** The synchronous IteratorRecord protocol, including completion forwarding.
 * Native class methods enter through the checked-value dispatcher; every
 * step and every user method still executes as compiled code. */
export function lowerCheckedDelegation(lowerer: Lowerer, expr: ts.YieldExpression, source: IrExpr): IrExpr {
  const loc = locOf(expr);
  const gen = lowerer.ctx.generator!;
  const returnType = lowerer.ctx.returnType;
  for (const type of [gen.nextT, returnType]) {
    if (type.kind !== "void" && type.kind !== "undefinedT" &&
        !canConvertToDyn(type, (id) => lowerer.shapes.get(id), (id) => lowerer.unions.get(id))) {
      lowerer.unsupported("SC1071", expr, "delegation with a channel that cannot cross a checked iterator method");
    }
  }
  const slot = (name: string, mutable = false) => {
    const local = lowerer.declareHiddenLocal(name, DYN);
    local.mutable = mutable;
    return { local, ref: varRef(local.id, DYN, loc) };
  };
  const iterator = slot("%delegate");
  const next = slot("%delegateNext");
  const step = slot("%delegateStep", true);
  const resume = slot("%delegateResume");
  const returned = slot("%delegateReturn");
  const thrown = slot("%delegateThrow");
  const close = slot("%delegateClose");
  const get = (value: IrExpr, key: string): IrExpr => ({
    kind: "dynKeyGet", value, key: { kind: "strLit", value: key, type: STRING, loc }, type: DYN, loc,
  });
  const check = (value: IrExpr): IrExpr => ({ kind: "libCall", fn: "dyn.iteratorResult", args: [value], type: DYN, loc });
  const call = (callee: IrExpr, args: IrExpr[]): IrExpr => check({
    kind: "dynCall", callee, receiver: iterator.ref, calleeName: "iterator method", args, type: DYN, loc,
  });
  const done = (): IrExpr => ({ kind: "dynTest", test: "truthy", value: get(step.ref, "done"), type: BOOL, loc });
  const absent = (value: IrExpr): IrExpr => ({ kind: "dynTest", test: "nullish", value, type: BOOL, loc });
  const sent = get(resume.ref, "value");
  const mode = (value: number): IrExpr => ({
    kind: "bin", op: "===", left: { kind: "dynCheck", value: get(resume.ref, "kind"), type: F64, loc },
    right: { kind: "numLit", value, type: F64, loc }, type: BOOL, loc,
  });
  const assign = (value: IrExpr): IrStmt => ({ kind: "assign", localId: step.local.id, value, loc });
  const declare = (target: typeof next, init: IrExpr): IrStmt => ({ kind: "varDecl", localId: target.local.id, init, loc });
  const finish = (value: IrExpr): IrStmt[] => returnType.kind === "void" ? [
    { kind: "if", cond: { kind: "unary", op: "!", operand: { kind: "dynTest", test: "undefined", value, type: BOOL, loc }, type: BOOL, loc }, then: [
      { kind: "runtimeFence", code: "SC1071", message: "returning a value through a void native generator channel is not supported yet", loc },
    ], else_: null, loc },
    { kind: "return", value: null, loc },
  ] : [{ kind: "return", value: lowerer.coerceToExpected(value, returnType), loc }];
  const stmts: IrStmt[] = [
    declare(iterator, check({ kind: "libCall", fn: "dyn.iterator", args: [lowerer.coerceInto(expr.expression!, source, DYN), { kind: "strLit", value: "", type: STRING, loc }], type: DYN, loc })),
    declare(next, get(iterator.ref, "next")),
    declare(step, call(next.ref, [dynUndefinedExpr(loc)])),
    { kind: "while", cond: { kind: "unary", op: "!", operand: done(), type: BOOL, loc }, body: [
      declare(resume, { kind: "yieldExpr", value: lowerer.coerceToExpected(get(step.ref, "value"), gen.yieldT), captureCompletion: { returnType }, type: DYN, loc }),
      { kind: "if", cond: mode(0), then: [assign(call(next.ref, [sent]))], else_: [
        { kind: "if", cond: mode(1), then: [
          declare(returned, get(iterator.ref, "return")),
          { kind: "if", cond: absent(returned.ref), then: finish(sent), else_: [
            assign(call(returned.ref, [sent])),
            { kind: "if", cond: done(), then: finish(get(step.ref, "value")), else_: null, loc },
          ], loc },
        ], else_: [
          declare(thrown, get(iterator.ref, "throw")),
          { kind: "if", cond: absent(thrown.ref), then: [
            declare(close, get(iterator.ref, "return")),
            { kind: "if", cond: { kind: "unary", op: "!", operand: absent(close.ref), type: BOOL, loc }, then: [
              { kind: "exprStmt", expr: call(close.ref, []), loc },
            ], else_: null, loc },
            { kind: "throw", value: { kind: "libCall", fn: "error.new", args: [
              { kind: "strLit", value: "The iterator does not provide a 'throw' method.", type: STRING, loc },
            ], type: { kind: "object", className: "%TypeError" }, loc }, loc },
          ], else_: [assign(call(thrown.ref, [sent]))], loc },
        ], loc },
      ], loc },
    ], loc },
  ];
  const expected = lowerer.mapTypeOf(lowerer.typeOf(expr));
  const result = expected && expected.kind !== "void" ? lowerer.coerceToExpected(get(step.ref, "value"), expected) : get(step.ref, "value");
  return { kind: "seqExpr", stmts, result, generatorDelegate: true, type: result.type, loc };
}
