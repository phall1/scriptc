import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function compileSource(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-primitive-ctor-"));
  const entry = join(directory, "main.ts");
  writeFileSync(entry, source);
  try {
    return await compile(entry, {
      outDir: directory,
      outPath: join(directory, "program.ir"),
      outputKind: "ir",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("re-exported Boolean, Number and String constructors coerce like the globals", async () => {
  const result = await compileSource(`
declare const Boolean: BooleanConstructor;
declare const Number: NumberConstructor;
declare const String: StringConstructor;
console.log(Boolean(1), Boolean(0), Boolean("false"), Number(true), String(7));
const coerce = Boolean;
console.log(coerce(1));
`);
  expect(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics)).toBe(true);
});
