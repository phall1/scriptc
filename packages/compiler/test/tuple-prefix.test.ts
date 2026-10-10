import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// npm-static types the loader result as any, so `([id, name])` is inferred
// as a two-element tuple. Each migration row is longer. Destructuring
// keeps the id and the name.
const migratorSource = `import { Effect } from "effect";
import * as M from "effect/sql/Migrator";
const loader = M.fromRecord({ "002_second": Effect.void, "001_first": Effect.void });
console.log(JSON.stringify(Effect.runSync(loader).map(([id, name]) => [id, name])));
`;

async function compileAndMatch(source: string, expected: string): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-tuple-prefix-"));
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  mkdirSync(directory, { recursive: true });
  symlinkSync(
    join(import.meta.dirname, "../../../../effect-scriptc-compat/node_modules"),
    join(directory, "node_modules"),
    "dir",
  );
  writeFileSync(entry, source);
  try {
    const result = await compile(entry, {
      outDir: directory,
      outPath: binary,
      outputKind: "exe",
      optimization: "dev",
      npmStatic: ["effect"],
    });
    expect(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const run = spawnSync(result.binaryPath, [], { encoding: "utf8", timeout: 30_000 });
    const oracle = spawnSync(process.execPath, ["--experimental-strip-types", entry], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(oracle.status, oracle.stderr).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(oracle.stdout);
    expect(run.stdout).toBe(expected);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("migration rows destructure id and name from the loader tuple", async () => {
  await compileAndMatch(migratorSource, '[[1,"first"],[2,"second"]]\n');
}, 180_000);
