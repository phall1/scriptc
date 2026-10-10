import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// Set<any> is a checked-dynamic set. Array.from of it must be one dyn
// array: default sort orders the strings, and JSON.stringify prints them
// beside a boolean. A static array of dyn has no default sort.
test("Array.from of a dynamic set sorts and stringifies", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-dyn-set-"));
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  writeFileSync(
    entry,
    [
      'const available = new Set<any>(["b", "a"]);',
      'const assigned = new Set<any>(["a"]);',
      "console.log(JSON.stringify([Array.from(available).sort(), Array.from(assigned).sort(), true]));",
      "",
    ].join("\n"),
  );
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
    const oracle = spawnSync(process.execPath, ["--experimental-strip-types", entry], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(oracle.status, oracle.stderr).toBe(0);
    expect(oracle.stdout).toBe('[["a","b"],["a"],true]\n');
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(oracle.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
