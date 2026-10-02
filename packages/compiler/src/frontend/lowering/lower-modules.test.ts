import { expect, test } from "vitest";
import { F64, UNDEFINED_T, type IrFunction, type IrType } from "../../ir/ir.js";
import type { Program, SourceFile } from "../ts7/adapter.js";
import { Lowerer } from "./lowerer.js";
import { moduleArtifacts } from "./lower-modules.js";

test("retains dependencies from function storage, captures, generator channels and globals", () => {
  const loc = { file: "artifacts.ts", start: 0, end: 1 };
  const lowerer = new Lowerer({ getTypeChecker: () => ({}) } as Program, { fileName: loc.file } as SourceFile, [], false);
  const record = (name: string, type: IrType = F64): IrType & { kind: "record" } => ({
    kind: "record", shapeId: lowerer.shapes.intern([{ name, type }]),
  });
  const param = record("parameter");
  const result = record("return");
  const local = record("local");
  const capture = record("capture");
  const classCapture = record("classCapture");
  const yielded = record("yielded");
  const sent = record("sent");
  const completed = record("completed");
  const body = record("body");
  const global = record("global", record("nested"));
  const wanted = lowerer.shapes.shapes.map((shape) => shape.id);
  record("unused");
  const unionId = lowerer.unions.intern([body, UNDEFINED_T]);
  const unusedUnion = lowerer.unions.intern([F64, UNDEFINED_T]);
  const fn: IrFunction = {
    name: "entry", params: [{ localId: "p", name: "p", type: param }], returnType: result,
    locals: [{ id: "l", name: "l", type: local, mutable: false }],
    captures: [{ localId: "c", name: "c", type: capture }],
    classCaptures: [{ localId: "cc", name: "cc", type: classCapture, slot: 0 }],
    generator: { yieldT: yielded, nextT: sent, resultType: completed },
    body: [{ kind: "return", value: { kind: "varRef", localId: "v", type: { kind: "union", unionId }, loc }, loc }], loc,
  };
  lowerer.globalsList.push({ id: "g", name: "g", type: global, mutable: false });
  const artifacts = moduleArtifacts(lowerer, [fn]);
  expect(artifacts.records.map((shape) => shape.id)).toEqual(wanted);
  expect(artifacts.unions.map((union) => union.id)).toEqual([unionId]);
  expect(artifacts.unions.some((union) => union.id === unusedUnion)).toBe(false);
});
