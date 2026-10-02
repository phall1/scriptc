import { expect, test, vi } from "vitest";
import { BOOL, F64, JSVAL, NULL_T, STRING, UNDEFINED_T, VOID, type IrExpr, type IrFunction, type IrStmt, type IrType } from "../../ir/ir.js";
import type { Node, Program, SourceFile, Type } from "../ts7/adapter.js";
import { Lowerer, stmtUsesIsland } from "./lowerer.js";
import { classMethodValue } from "./class-method-values.js";

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

const record = (shapeId: string): IrType => ({ kind: "record", shapeId });
const context = () => new Lowerer({ getTypeChecker: () => ({}) } as Program, { fileName: loc.file } as SourceFile, [], false);

test("reuses complete copy routes without repeating discriminator planning", () => {
  const lowerer = context();
  const shape = record(lowerer.shapes.intern([{ name: "kind", type: STRING }]));
  const discriminant = { field: "kind", cases: [{ tag: 0, values: ["value"] }] };
  const from = lowerer.unions.intern([shape, UNDEFINED_T], discriminant);
  const to = lowerer.unions.intern([shape, NULL_T], discriminant);
  const plan = vi.spyOn(lowerer, "widthLiftPlan");
  const helper = lowerer.unionRetagHelper(from, to, loc);
  expect(helper).not.toBeNull();
  expect(plan).toHaveBeenCalled();
  plan.mockClear();
  for (let i = 0; i < 20; i++) expect(lowerer.unionRetagHelper(from, to, loc)).toBe(helper);
  expect(plan).not.toHaveBeenCalled();
  expect(lowerer.liftedFns.filter((fn) => fn.name === helper)).toHaveLength(1);
  const recursive = {} as Type;
  lowerer.shapes.recursiveRef(recursive);
  lowerer.shapes.finalizeRecursive(recursive, [{ name: "kind", type: STRING }]);
  expect(lowerer.unionRetagHelper(from, to, loc)).toBe(helper);
  expect(plan).toHaveBeenCalled();
});

test("keeps narrowing evidence local to each conversion request", () => {
  const lowerer = context();
  const from = lowerer.unions.intern([F64, STRING, UNDEFINED_T]);
  const to = lowerer.unions.intern([F64, NULL_T]);
  const helper = lowerer.unionRetagHelper(from, to, loc, new Set([1]));
  expect(helper).not.toBeNull();
  expect(lowerer.unionRetagHelper(from, to, loc)).toBeNull();
  expect(lowerer.unionRetagHelper(from, to, loc, new Set([0]))).toBeNull();
  expect(lowerer.unionRetagHelper(from, to, loc, new Set([1]))).toBe(helper);
  expect(lowerer.unionRetagHelper(from, to, loc, new Set([1, 0]))).toBe(helper);
});

test("replans after a recursive union gains its final arms", () => {
  const lowerer = context();
  const recursive = {} as Type;
  const from = lowerer.unions.intern([UNDEFINED_T, NULL_T]);
  const to = lowerer.unions.recursiveRef(recursive);
  const trapped = lowerer.unionRetagHelper(from, to, loc);
  expect(trapped).not.toBeNull();
  lowerer.unions.finalizeRecursive(recursive, [UNDEFINED_T]);
  const completed = lowerer.unionRetagHelper(from, to, loc);
  expect(completed).not.toBeNull();
  expect(completed).not.toBe(trapped);
  expect(lowerer.liftedFns.find((fn) => fn.name === completed)?.body).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "if", then: expect.arrayContaining([expect.objectContaining({ kind: "return" })]) }),
  ]));
});

test("rechecks width conversions after recursive record definitions settle", () => {
  const lowerer = context();
  const recursive = {} as Type;
  const source = record(lowerer.shapes.intern([{ name: "value", type: F64 }]));
  const target = record(lowerer.shapes.recursiveRef(recursive));
  const from = lowerer.unions.intern([source, UNDEFINED_T]);
  const to = lowerer.unions.intern([target, NULL_T]);
  expect(lowerer.unionRetagHelper(from, to, loc)).not.toBeNull();
  lowerer.shapes.finalizeRecursive(recursive, [{ name: "value", type: STRING }]);
  expect(lowerer.unionRetagHelper(from, to, loc)).toBeNull();
});

test("method adapter interning does not inspect unrelated lifted functions", () => {
  const lowerer = context();
  let nameReads = 0;
  for (let i = 0; i < 100; i++) {
    const fn: IrFunction = { name: `unrelated.${i}`, params: [], returnType: VOID, locals: [], body: [], loc };
    Object.defineProperty(fn, "name", { get() { nameReads++; return `unrelated.${i}`; } });
    lowerer.liftedFns.push(fn);
  }
  const owner = lowerer.classes.get("%Error")!;
  const inherited = lowerer.classes.get("%TypeError")!;
  const first = classMethodValue(lowerer, {} as Node, owner, "toString", loc);
  expect(first).toMatchObject({ kind: "closure" });
  for (let i = 0; i < 20; i++) {
    expect(classMethodValue(lowerer, {} as Node, inherited, "toString", loc)).toEqual(first);
  }
  expect(nameReads).toBe(0);
  expect(lowerer.liftedFns.slice(100)).toHaveLength(2);
});
