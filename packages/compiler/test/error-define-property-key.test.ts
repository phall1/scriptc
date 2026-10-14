import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function compileIr(source: string): Promise<unknown> {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-define-property-"));
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

test("defineProperty on an Error with an any key uses the dynamic property table", async () => {
  const ir = await compileIr(`
class Boom extends Error {}
function assign(self: Boom, key: any, value: any): void {
  Object.defineProperty(self, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
const boom = new Boom("x");
assign(boom, "__proto__", { marker: true });
console.log(boom.message);
`);
  expect(libFns(ir).filter((fn) => fn === "dyn.defineProperty").length).toBeGreaterThan(0);
});

test("defineProperty on a class constructor stores a dynamic static", async () => {
  const ir = await compileIr(`
class Item {
  static tag = "item";
}
function add(name: string): void {
  Object.defineProperty(Item, name, { value: 1 });
}
add("insert");
console.log(Item.tag);
`);
  expect(libFns(ir).filter((fn) => fn === "dyn.defineProperty").length).toBeGreaterThan(0);
});
