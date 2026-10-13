import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

const source = `const date = new Date("2024-01-01T12:00:00Z");
console.log(JSON.stringify([
  date.toJSON(),
  date.toISOString(),
  "ababb".search("b"),
  "ababb".search("."),
  "ababb".search("d"),
  "ababb".search(/abb/),
]));
`;

test("string search accepts a pattern and Date.toJSON matches toISOString", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-search-json-"));
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
    expect(run.stdout).toBe('["2024-01-01T12:00:00.000Z","2024-01-01T12:00:00.000Z",1,0,-1,2]\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);

const unionSource = `function searchIndex(self: string, pattern: string | RegExp): number {
  return self.search(pattern);
}
console.log(JSON.stringify([
  searchIndex("ababb", "b"),
  searchIndex("ababb", /abb/),
  searchIndex("ababb", "."),
  searchIndex("ababb", "d"),
]));
`;

test("string search accepts a string | RegExp pattern", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-search-union-"));
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  writeFileSync(entry, unionSource);
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
    expect(run.stdout).toBe("[1,2,0,-1]\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
