import { dynUndefinedExpr, strLit, varRef } from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { BOOL, DYN, type IrExpr, type IrStmt, type SrcLoc } from "../../../ir/ir.js";

export function lowerUtilTypeCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
  name: string,
): IrExpr {
  if (expr.arguments.some(ts.isSpreadElement))
    lowerer.noLowering(`${name} with spread arguments`, expr);
  const input = expr.arguments[0]
    ? lowerer.lowerExprExpecting(expr.arguments[0], DYN)
    : dynUndefinedExpr(loc);
  const saved = lowerer.declareHiddenLocal("%utilTypeInput", DYN);
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: saved.id, init: input, loc },
      ...expr.arguments
        .slice(1)
        .map((arg): IrStmt => ({ kind: "exprStmt", expr: lowerer.lowerExpr(arg), loc })),
    ],
    result: {
      kind: "libCall",
      fn: "util.typeIs",
      args: [varRef(saved.id, DYN, loc), strLit(bi.member, loc)],
      type: BOOL,
      loc,
    },
    type: BOOL,
    loc,
  };
}
