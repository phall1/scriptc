import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// Object.defineProperties copies enumerable symbol keys. String-key
// enumeration does not see them, and the stored value stays the symbol's.
const program = `
const shown = Symbol.for("shown");
const target = {};
Object.defineProperties(target, {
  [shown]: { value: "yes", enumerable: true, writable: true, configurable: true },
});
const descriptor = Object.getOwnPropertyDescriptor(target, shown);
console.log(target[shown]);
console.log(descriptor.enumerable);
console.log(descriptor.value);
console.log(Object.keys(target).length);
`;

test("defineProperties copies an enumerable symbol key", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-define-symbol-"));
  const entry = join(directory, "main.js");
  const binary = join(directory, "main");
  writeFileSync(entry, program);
  try {
    const result = await compile(entry, {
      outDir: directory,
      outPath: binary,
      outputKind: "exe",
      optimization: "dev",
    });
    expect(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const run = spawnSync(result.binaryPath, [], { encoding: "utf8", timeout: 30_000 });
    const oracle = spawnSync(process.execPath, [entry], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(oracle.status, oracle.stderr).toBe(0);
    expect(oracle.stdout).toBe("yes\ntrue\nyes\n0\n");
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(oracle.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
