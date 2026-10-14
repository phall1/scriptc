import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// npm-static monomorphization of string[string | number | symbol].
// "length" stays a number, 1.5 is not a character, and a symbol is not
// stringified into "Symbol(...)".
const probe = `
export function read(text, key) {
  return text[key];
}
`;

const program = `
import { read } from "property-key-fixture/probe.js";

const text = "ab";
const keys: Array<string | number | symbol> = ["length", 0, 1.5, Symbol.iterator];
for (const key of keys) {
  const value = read(text, key);
  const kind = typeof value;
  const shown = kind === "function" || kind === "undefined" ? kind : JSON.stringify(value);
  console.log(kind + ":" + shown);
}
`;

test("a property-key union indexes a string the way JavaScript does", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-property-key-"));
  const pkg = join(directory, "node_modules", "property-key-fixture");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "property-key-fixture", version: "0.0.0", type: "module" }),
  );
  writeFileSync(join(pkg, "probe.js"), probe);
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  writeFileSync(entry, program);
  try {
    const result = await compile(entry, {
      outDir: directory,
      outPath: binary,
      outputKind: "exe",
      optimization: "dev",
      npmStatic: ["property-key-fixture"],
    });
    expect(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const run = spawnSync(result.binaryPath, [], { encoding: "utf8", timeout: 30_000 });
    const oracle = spawnSync(process.execPath, ["--experimental-strip-types", entry], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(oracle.status, oracle.stderr).toBe(0);
    expect(oracle.stdout).toBe('number:2\nstring:"a"\nundefined:undefined\nfunction:function\n');
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(oracle.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
