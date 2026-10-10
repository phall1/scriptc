import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// The only `any` in Bag is the index signature's value type. A missing key
// is undefined, which a static record of the written fields cannot answer.
const program = `
type Bag = { [key: string]: any };

function take(bag: Bag, key: string): unknown {
  return bag[key];
}

const bag: Bag = { n: 1, label: "ok" };
console.log(JSON.stringify(take(bag, "n")));
console.log(JSON.stringify(take(bag, "missing")));
console.log(JSON.stringify(take(bag, "label")));
`;

test("an any-valued index signature reads present and missing keys", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-any-index-"));
  const entry = join(directory, "main.ts");
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
    const oracle = spawnSync(process.execPath, ["--experimental-strip-types", entry], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(oracle.status, oracle.stderr).toBe(0);
    expect(oracle.stdout).toBe('1\nundefined\n"ok"\n');
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(oracle.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
