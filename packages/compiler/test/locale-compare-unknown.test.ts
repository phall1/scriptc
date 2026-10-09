import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function compileIr(source: string): Promise<unknown> {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-locale-compare-"));
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

function libFns(root: unknown): unknown[] {
  const found: unknown[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record["kind"] === "libCall") found.push(record["fn"]);
    for (const value of Object.values(record)) walk(value);
  };
  walk(root);
  return found;
}

test("a string localeCompare stays the root-collation intrinsic", async () => {
  const ir = await compileIr(`console.log("a".localeCompare("b"));`);
  expect(libFns(ir).filter((fn) => fn === "str.localeCompare")).toHaveLength(1);
});

test("any HashMap keys localeCompare as checked strings", async () => {
  const ir = await compileIr(`
function cmp(a: any, b: any): number {
  return a.localeCompare(b);
}
console.log(cmp("a", "b"));
`);
  expect(libFns(ir).filter((fn) => fn === "str.localeCompare")).toHaveLength(1);
});
