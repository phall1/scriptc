import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

const source = `
function entriesOf(input) {
  const entries = typeof input[Symbol.iterator] === "function" ? Array.from(input) : Object.entries(input);
  return entries;
}
console.log(JSON.stringify(entriesOf({ q: "a b", page: "1" })));
console.log(typeof ({ q: "a" })[Symbol.iterator]);
console.log(JSON.stringify(entriesOf(new URLSearchParams("a=1&a=2"))));
`;

test("symbol reads follow whether the value is iterable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-record-symbol-"));
  const entry = join(directory, "main.js");
  const binary = join(directory, "main");
  writeFileSync(entry, source);
  try {
    const result = await compile(entry, {
      outDir: directory,
      outPath: binary,
      outputKind: "exe",
      optimization: "dev",
    });
    expect(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const run = spawnSync(result.binaryPath, [], { encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('[["q","a b"],["page","1"]]\nundefined\n[["a","1"],["a","2"]]\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
