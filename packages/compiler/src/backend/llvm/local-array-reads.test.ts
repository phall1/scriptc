import { expect, test } from "vitest";
import { BOOL, F64, VOID, UNDEFINED_T, arrayOf, funcOf, type IrExpr, type IrFunction, type IrModule, type IrStmt, type IrType } from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { emitLlvmModule } from "./emitter.js";
import { findLocalArrayReads } from "./local-array-reads.js";

const loc = { file: "local-array.ts", start: 0, end: 0 };
const element: IrType = { kind: "record", shapeId: "cell" };
const optional: IrType = { kind: "union", unionId: "optional" };
const array = arrayOf(element);
const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const params = [{ localId: "a", name: "a", type: array }, { localId: "i", name: "i", type: F64 }];
const unionValue = ref("value", optional);
const narrow: IrExpr = { kind: "unionNarrow", unionId: "optional", tag: 0, value: unionValue, type: element, loc };

function fixture(): IrModule {
  const producer: IrFunction = {
    name: "read", params, returnType: optional, locals: params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })), loc,
    body: [{ kind: "return", loc, value: {
      kind: "ternary", type: optional, loc,
      cond: { kind: "bin", op: "===", left: { kind: "arrayState", arr: ref("a", array), index: ref("i", F64), type: F64, loc }, right: num(1), type: BOOL, loc },
      then: { kind: "unionWrap", unionId: "optional", tag: 0, value: { kind: "arrayGet", arr: ref("a", array), index: ref("i", F64), type: element, loc }, type: optional, loc },
      else_: { kind: "unionWrap", unionId: "optional", tag: 1, value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc }, type: optional, loc },
    } }],
  };
  const work: IrFunction = {
    name: "work", params, returnType: F64, loc,
    locals: [...producer.locals, { id: "value", name: "value", type: optional, mutable: false }],
    body: [
      { kind: "varDecl", localId: "value", init: { kind: "call", callee: "read", args: [ref("a", array), ref("i", F64)], type: optional, loc }, loc },
      { kind: "return", value: { kind: "recordGet", obj: narrow, shapeId: "cell", field: "x", type: F64, loc }, loc },
    ],
  };
  return { irVersion: 13, sourceFile: loc.file, entry: "main", records: [{ id: "cell", fields: [{ name: "x", type: F64 }] }], unions: [{ id: "optional", arms: [element, UNDEFINED_T] }],
    functions: [{ name: "main", params: [], returnType: VOID, locals: [], body: [], loc }, producer, work] };
}
function candidates(mod: IrModule) {
  return findLocalArrayReads(mod.functions[2]!, new Map(mod.functions.map((f) => [f.name, f])), new Map(mod.unions!.map((u) => [u.id, u])));
}
function workBody(mod: IrModule, pointerBits: 32 | 64 = 64) {
  return /^define internal [^\n]*@sc_f_work\([^]*?^}/m.exec(emitLlvmModule(mod, { pointerBits }))![0];
}

test("private optional array results use local tags and borrowed payloads on both ABIs", () => {
  const mod = fixture();
  expect(validateModule(mod)).toEqual([]);
  expect(candidates(mod).get("value")?.borrow).toBe(true);
  for (const pointerBits of [32, 64] as const) {
    const body = workBody(mod, pointerBits);
    expect(body).toContain("alloca %ScrUnion");
    expect(body).toContain("@scr_arr_peek_ref");
    expect(body).not.toContain("@sc_f_read(");
    expect(body).not.toContain("@scr_union_release");
    expect(body).not.toContain("@sc_rretain_");
    expect(body).not.toContain("@sc_rrelease_");
  }
});

test("array mutation preserves a separate payload owner and exceptional cleanup", () => {
  const mod = fixture();
  mod.functions[2]!.body.splice(1, 0, { kind: "arraySetLength", arr: ref("a", array), length: num(0), loc });
  expect(validateModule(mod)).toEqual([]);
  expect(candidates(mod).get("value")?.borrow).not.toBe(true);
  const body = workBody(mod);
  expect(body).toContain("@sc_rretain_");
  expect(body).toContain("@sc_rrelease_");
  expect(body).not.toContain("@scr_union_release");
});

test.each(["alias", "capture", "assign", "boxed", "tdz", "mutable", "duplicate", "async", "effectful producer"])("keeps %s optional boxes on the general path", (reason) => {
  const mod = fixture();
  const fn = mod.functions[2]!;
  const local = fn.locals[2]!;
  if (reason === "alias") fn.body.push({ kind: "return", value: unionValue, loc });
  if (reason === "capture") fn.body.push({ kind: "exprStmt", expr: { kind: "closure", fnName: "capture", captures: ["value"], type: funcOf([], F64), loc }, loc });
  if (reason === "assign") fn.body.push({ kind: "assign", localId: "value", value: unionValue, loc });
  if (reason === "boxed") local.boxed = true;
  if (reason === "tdz") local.tdz = true;
  if (reason === "mutable") local.mutable = true;
  if (reason === "duplicate") fn.body.push(fn.body[0]!);
  if (reason === "async") fn.async = true;
  if (reason === "effectful producer") mod.functions[1]!.body.unshift({ kind: "exprStmt", expr: num(1), loc });
  expect(candidates(mod).size).toBe(0);
});

test("unknown calls and reference stores disable array borrowing", () => {
  const effects: IrStmt[] = [
    { kind: "exprStmt", expr: { kind: "call", callee: "unknown", args: [], type: VOID, loc }, loc },
    { kind: "arraySet", arr: ref("a", array), index: num(0), value: narrow, loc },
    { kind: "assign", localId: "a", value: ref("a", array), loc },
  ];
  for (const effect of effects) {
    const mod = fixture();
    mod.functions[2]!.body.splice(1, 0, effect);
    expect(candidates(mod).get("value")?.borrow).not.toBe(true);
  }
});
