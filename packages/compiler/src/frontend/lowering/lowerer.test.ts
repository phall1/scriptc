import { expect, test } from "vitest";
import { BOOL, F64, JSVAL, type IrExpr, type IrStmt } from "../../ir/ir.js";
import { stmtUsesIsland } from "./lowerer.js";

const loc = { file: "island.ts", start: 0, end: 1 };
const island: IrExpr = { kind: "jsOp", op: "undefLit", args: [], type: JSVAL, loc };
const statement: IrStmt = { kind: "exprStmt", expr: island, loc };

test("accounts only the expressions owned by the current source statement", () => {
  expect(stmtUsesIsland(statement)).toBe(true);
  expect(stmtUsesIsland([statement])).toBe(true);
  expect(stmtUsesIsland({ kind: "block", body: [statement], loc })).toBe(false);
  expect(stmtUsesIsland({ kind: "if", cond: { kind: "boolLit", value: true, type: BOOL, loc }, then: [statement], else_: null, loc })).toBe(false);
  expect(stmtUsesIsland({ kind: "if", cond: { kind: "jsExit", value: island, type: BOOL, loc }, then: [], else_: null, loc })).toBe(true);
});

test("inspects expression results without recounting embedded statement lists", () => {
  const expr: IrExpr = { kind: "seqExpr", stmts: [statement], result: { kind: "numLit", value: 0, type: F64, loc }, type: F64, loc };
  expect(stmtUsesIsland({ kind: "exprStmt", expr, loc })).toBe(false);
  expr.result = { kind: "jsExit", value: island, type: F64, loc };
  expect(stmtUsesIsland({ kind: "exprStmt", expr, loc })).toBe(true);
});

test("retains accounting for island library calls and generated loop conditions", () => {
  const call: IrExpr = { kind: "libCall", fn: "island.eval", args: [], type: JSVAL, loc };
  const loop: IrStmt = { kind: "for", init: null, cond: { kind: "jsExit", value: call, type: BOOL, loc }, update: null, body: [], loc };
  expect(stmtUsesIsland({ kind: "block", body: [loop], loc })).toBe(true);
  expect(stmtUsesIsland({ kind: "exprStmt", expr: { kind: "numLit", value: 1, type: F64, loc }, loc })).toBe(false);
});
