import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function compileIr(source: string): Promise<unknown> {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-global-uri-"));
  const entry = join(directory, "main.ts");
  writeFileSync(entry, source);
  try {
    const result = await compile(entry, {
      outDir: directory,
      outPath: join(directory, "program.ir"),
      outputKind: "ir",
    });
    expect(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics)).toBe(true);
    return JSON.parse(readFileSync(join(directory, "program.ir"), "utf8"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function collect(root: unknown, kind: string): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record["kind"] === kind) found.push(record);
    for (const value of Object.values(record)) walk(value);
  };
  walk(root);
  return found;
}

test("globalThis URI calls use the same intrinsics as the bare names", async () => {
  const ir = await compileIr(`
console.log(decodeURIComponent("a%20b"));
console.log(globalThis.decodeURIComponent("a%20b"));
console.log(encodeURIComponent("a b"));
console.log(globalThis.encodeURIComponent("a b"));
console.log(decodeURI("a%20b"));
console.log(globalThis.decodeURI("a%20b"));
console.log(encodeURI("a b"));
console.log(globalThis.encodeURI("a b"));
`);
  const fns = collect(ir, "libCall").map((call) => call["fn"]);
  expect(fns.filter((fn) => fn === "str.decodeUriComponent")).toHaveLength(2);
  expect(fns.filter((fn) => fn === "str.encodeUriComponent")).toHaveLength(2);
  expect(fns.filter((fn) => fn === "str.decodeUri")).toHaveLength(2);
  expect(fns.filter((fn) => fn === "str.encodeUri")).toHaveLength(2);
});
