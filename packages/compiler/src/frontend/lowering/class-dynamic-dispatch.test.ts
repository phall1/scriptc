import { expect, test } from "vitest";
import { DYN, F64, STRING, VOID, type IrExpr, type IrFunction, type IrStmt } from "../../ir/ir.js";
import { ClassDynamicDispatch } from "./class-dynamic-dispatch.js";
import type { Lowerer } from "./lowerer.js";

const loc = { file: "dispatch.ts", start: 0, end: 1 };
const variable = (localId: string): IrExpr => ({ kind: "varRef", localId, type: DYN, loc });
const literal = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
const statement = (expr: IrExpr): IrStmt => ({ kind: "exprStmt", expr, loc });
const fn = (name: string, body: IrStmt[]): IrFunction => ({ name, params: [], returnType: VOID, locals: [], body, loc });
function context() {
  const liftedFns: IrFunction[] = [];
  const lowerer = { shapes: new Map(), unions: new Map(), classes: new Map(), liftedFns } as unknown as Lowerer;
  const boxed = fn("box", [statement({ kind: "dynFrom", value: { kind: "varRef", localId: "instance", type: { kind: "object", className: "Widget" }, loc }, type: DYN, loc })]);
  return { lowerer, liftedFns, boxed };
}

test("preserves typed function bodies when other functions box classes", () => {
  const { lowerer, boxed } = context();
  const body: IrStmt[] = [{ kind: "block", body: [statement({ kind: "numLit", value: 1, type: F64, loc })], loc }];
  const typed = fn("typed", body);
  const boxBody = boxed.body;
  const dispatch = new ClassDynamicDispatch();
  expect(dispatch.process(lowerer, [boxed, typed])).toBe(true);
  expect(typed.body).toBe(body);
  expect(boxed.body).toBe(boxBody);
  expect(dispatch.process(lowerer, [boxed, typed])).toBe(false);
  expect(typed.body).toBe(body);
});

test.each(["named read", "computed read", "named write", "computed string write", "computed dynamic write"])("rewrites a nested %s", (kind) => {
  const { lowerer, boxed, liftedFns } = context();
  const read = kind.endsWith("read");
  const computed = kind.startsWith("computed");
  const dynamicKey = kind === "computed dynamic write";
  const key = computed ? { kind: "varRef" as const, localId: "key", type: dynamicKey ? DYN : STRING, loc } : literal("name");
  const operation: IrExpr = read
    ? { kind: "dynKeyGet", value: variable("receiver"), key, type: DYN, loc }
    : { kind: "libCall", fn: dynamicKey ? "dyn.keySetComputed" : "dyn.keySet", args: [variable("receiver"), key, variable("stored")], type: VOID, loc };
  const target = fn("target", [{ kind: "block", body: [statement(operation)], loc }]);
  const dispatch = new ClassDynamicDispatch();
  dispatch.process(lowerer, [boxed, target]);
  const block = target.body[0]!;
  if (block.kind !== "block" || block.body[0]?.kind !== "exprStmt") throw new Error("missing test body");
  expect(block.body[0].expr).toMatchObject({ kind: "call", callee: expect.stringMatching(/^%dyn\.class\.(property|computed)\./) });
  expect(liftedFns).toHaveLength(2);
  const transformed = target.body;
  expect(dispatch.process(lowerer, [boxed, target, ...liftedFns])).toBe(false);
  expect(target.body).toBe(transformed);
});

test("discovers dispatch sites added during a later reachability pass", () => {
  const { lowerer, boxed } = context();
  const target = fn("target", []);
  const dispatch = new ClassDynamicDispatch();
  dispatch.process(lowerer, [boxed, target]);
  target.body.push(statement({ kind: "dynKeyGet", value: variable("receiver"), key: literal("name"), type: DYN, loc }));
  expect(dispatch.process(lowerer, [boxed, target])).toBe(true);
  expect(target.body[0]).toMatchObject({ kind: "exprStmt", expr: { kind: "call" } });
});
