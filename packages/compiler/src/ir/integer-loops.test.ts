import { expect, test } from "vitest";
import { BOOL, F64, arrayOf, type IrExpr, type IrLocal, type IrStmt } from "./ir.js";
import { matchIntegerArrayForLoop } from "./integer-loops.js";

const loc = { file: "integer-array-loop.ts", start: 0, end: 0 };
const number = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const ref = (localId: string): IrExpr => ({ kind: "varRef", localId, type: F64, loc });
const locals = new Map<string, IrLocal>([
  ["i", { id: "i", name: "i", type: F64, mutable: true }],
  ["a", { id: "a", name: "a", type: arrayOf(F64), mutable: false }],
]);
function loop(start = number(0)): IrStmt & { kind: "for" } {
  return {
    kind: "for", loc, init: { kind: "varDecl", localId: "i", init: start, loc },
    cond: { kind: "bin", op: "<", left: ref("i"), right: {
      kind: "arrIntrinsic", method: "length", receiver: { kind: "varRef", localId: "a", type: arrayOf(F64), loc }, args: [], type: F64, loc,
    }, type: BOOL, loc },
    update: { kind: "assign", localId: "i", value: { kind: "bin", op: "+", left: ref("i"), right: number(1), type: F64, loc }, loc }, body: [],
  };
}

test("array length loops and active outer-array induction have exact integer bounds", () => {
  expect(matchIntegerArrayForLoop(loop(), locals, new Set())?.localId).toBe("i");
  const nested = loop({ kind: "bin", op: "+", left: ref("outer"), right: number(1), type: F64, loc });
  expect(matchIntegerArrayForLoop(nested, locals, new Set(["outer"]))?.localId).toBe("i");
  expect(matchIntegerArrayForLoop(nested, locals, new Set())).toBeNull();
});

test("negative zero, unknown starts, captured counters and body writes stay floating point", () => {
  for (const start of [number(-0), number(0.5), number(-1), ref("unknown")]) expect(matchIntegerArrayForLoop(loop(start), locals, new Set())).toBeNull();
  const captured = new Map(locals);
  captured.set("i", { ...locals.get("i")!, boxed: true });
  expect(matchIntegerArrayForLoop(loop(), captured, new Set())).toBeNull();
  const changed = loop();
  changed.body.push({ kind: "exprStmt", expr: { kind: "assignExpr", localId: "i", value: number(0.5), type: F64, loc }, loc });
  expect(matchIntegerArrayForLoop(changed, locals, new Set())).toBeNull();
});

test("changing the array length does not invalidate integer induction", () => {
  const changed = loop();
  changed.body.push({ kind: "arraySetLength", arr: { kind: "varRef", localId: "a", type: arrayOf(F64), loc }, length: number(0), loc });
  expect(matchIntegerArrayForLoop(changed, locals, new Set())?.localId).toBe("i");
});
