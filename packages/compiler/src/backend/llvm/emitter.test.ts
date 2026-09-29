import { expect, test } from "vitest";
import { F64, STRING, VOID, type IrFunction, type IrModule, type IrStmt } from "../../ir/ir.js";
import { emitLlvmModule } from "./emitter.js";

const loc = { file: "exception-cleanup.ts", start: 0, end: 0 };
const call = (): IrStmt => ({ kind: "exprStmt", expr: { kind: "call", callee: "throws", args: [], type: VOID, loc }, loc });
const literal = (value: string) => ({ kind: "strLit" as const, value, type: STRING, loc });
function moduleFor(body: IrStmt[], options: { boxed?: boolean; numberReturn?: boolean } = {}): IrModule {
  const params = ["first", "second", "third"].map((name) => ({ name, localId: name, type: STRING }));
  const work: IrFunction = {
    name: "work", params, returnType: options.numberReturn ? F64 : VOID,
    locals: [...params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false, ...(options.boxed ? { boxed: true as const } : {}) })),
      { id: "later", name: "later", type: STRING, mutable: true }],
    body: [...body, ...(options.numberReturn ? [{ kind: "return" as const, value: { kind: "numLit" as const, value: 7, type: F64, loc }, loc }] : [])], loc,
  };
  return {
    irVersion: 13, sourceFile: loc.file, entry: "main", functions: [
      { name: "main", params: [], returnType: VOID, locals: [], body: [], loc }, work,
      { name: "throws", params: [], returnType: VOID, locals: [], body: [{ kind: "throw", value: literal("oops"), loc }], loc },
    ],
  };
}
function cleanupBlocks(module: IrModule): string[] {
  const llvm = emitLlvmModule(module);
  return [...llvm.matchAll(/^exc\.cleanup\d+:\n(?:  [^\n]*\n)+/gm)].map((match) => match[0]!);
}

test("throwing-call count does not multiply identical scope cleanup", () => {
  for (const boxed of [false, true]) {
    const small = emitLlvmModule(moduleFor(Array.from({ length: 4 }, call), { boxed }));
    const large = emitLlvmModule(moduleFor(Array.from({ length: 64 }, call), { boxed }));
    const release = boxed ? /call void @scr_box_release\(ptr/g : /call void @scr_str_release\(ptr/g;
    expect(small.match(release)?.length).toBeGreaterThan(0);
    expect(large.match(release)?.length).toBe(small.match(release)?.length);
  }
});

test("cleanup snapshots keep locals declared after an earlier throw separate", () => {
  const module = moduleFor([call(), { kind: "varDecl", localId: "later", init: literal("created"), loc }, call()]);
  const blocks = cleanupBlocks(module);
  expect(blocks).toHaveLength(2);
  expect(blocks.filter((block) => block.includes("%sc_l_later"))).toHaveLength(1);
});

test("equivalent slots with different catch destinations remain separate", () => {
  const module = moduleFor([
    { kind: "tryCatch", tryBody: [{ kind: "varDecl", localId: "later", init: literal("one"), loc }, call(), call()], catchBody: [], catchLocalId: null, finallyBody: null, loc },
    { kind: "tryCatch", tryBody: [{ kind: "varDecl", localId: "later", init: literal("two"), loc }, call(), call()], catchBody: [], catchLocalId: null, finallyBody: null, loc },
  ]);
  const blocks = cleanupBlocks(module).filter((block) => block.includes("%sc_l_later"));
  expect(blocks).toHaveLength(2);
  const targets = blocks.map((block) => /br label %([^\n]+)/.exec(block)?.[1]);
  expect(targets.every(Boolean)).toBe(true);
  expect(new Set(targets).size).toBe(2);
});

test("shared exceptional exits preserve the function's scalar return ABI", () => {
  const blocks = cleanupBlocks(moduleFor([call(), call()], { numberReturn: true }));
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toContain("ret double 0x0000000000000000");
});
