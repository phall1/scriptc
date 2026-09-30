import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze, compile } from "../src/index.js";

function fixture(source: string) {
  const dir = mkdtempSync("/tmp/scriptc-class-descriptors-");
  const entry = join(dir, "main.js");
  writeFileSync(entry, source);
  return { dir, entry };
}

test.each([
  "Object.defineProperty(value, 'x', {value: 2, writable: false});",
  "Object.defineProperties(value, {x: {value: 2}});",
  "Object.defineProperty(value, 'data', {get() { return this.x; }});",
  "Object.defineProperties(value, {data: {get() { return this.x; }}});",
  "Object.defineProperty(value, String('data'), {value: 2});",
])("keeps unsafe native descriptor changes fenced: %s", (operation) => {
  const { dir, entry } = fixture(`class Value { constructor() { this.x = 1; } } const value = new Value(); ${operation}`);
  try {
    const { coverage } = analyze(entry, { dynamic: false });
    expect([...coverage.diagnostics, ...(coverage.runtimeFences ?? [])].some((d) => d.code === "SC2020" && d.message.includes("Object.define"))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("incompatible JS overrides throw at entry without executing the body", async () => {
  const { dir, entry } = fixture(`
class Base { copy(value = 1) { return value; } }
class Child extends Base { copy(value) { console.log('must not execute'); return value; } }
const child = new Child();
try { child.copy(2); } catch (error) { console.log(error.message.includes("overriding method 'copy' with a different signature")); }
console.log(new Base().copy());
`);
  try {
    const result = await compile(entry, { dynamic: false, outDir: dir, outPath: join(dir, "program"), sanitize: process.env["SCRIPTC_SAN"] === "1" });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const run = spawnSync(result.binaryPath, { encoding: "utf8", timeout: 30_000 });
    expect(run.error).toBeUndefined();
    expect({ status: run.status, signal: run.signal, stdout: run.stdout, stderr: run.stderr }).toEqual({ status: 0, signal: null, stdout: "true\n1\n", stderr: "" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
