import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// Effect's Result.toJSON embeds a native Set. Node stringifies Set, Map,
// WeakSet, WeakMap, and ArrayBuffer as "{}" because they have no
// enumerable own properties. The array stays `any` so stringify takes the
// dynamic walk instead of the static JSON fence.
const source = `const value: any = new Set([1]);
const box = { toJSON: () => ({ _id: "Result", _tag: "Success", value }) };
const observed: any[] = [
  new Set([1]),
  new Map([["a", 1]]),
  new WeakSet(),
  new WeakMap(),
  new ArrayBuffer(4),
  box,
];
console.log(JSON.stringify(observed));
`;

test("empty native collections stringify as empty objects", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-json-empty-handles-"));
  const entry = join(directory, "main.ts");
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
    const run = spawnSync(result.binaryPath, [], { encoding: "utf8", timeout: 30_000 });
    const oracle = spawnSync(process.execPath, [entry], { encoding: "utf8", timeout: 30_000 });
    expect(oracle.status, oracle.stderr).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(oracle.stdout);
    expect(run.stdout).toBe('[{},{},{},{},{},{"_id":"Result","_tag":"Success","value":{}}]\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
