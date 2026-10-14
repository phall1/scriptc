import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// Console.assert's test double spreads `readonly unknown[]` into
// `Array<unknown>.push`. Only the failing assertion is recorded.
const consoleAssertSource = `import * as Console from "effect/Console"
import { Effect } from "effect"
const errors: Array<unknown> = []
const testConsole: Console.Console = Object.assign(Object.create(console), {
  assert: (condition: boolean, ...args: ReadonlyArray<unknown>) => {
    if (!condition) errors.push(...args)
  }
})
const program = Effect.gen(function*() {
  yield* Console.assert(2 + 2 === 4, "Math is working correctly")
  yield* Console.assert(2 + 2 === 5, "This will be logged as an error")
})
Effect.runSync(Effect.provideService(program, Console.Console, testConsole))
console.log(JSON.stringify(errors))
`;

test("Console.assert records only the failing message", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-console-assert-"));
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  mkdirSync(directory, { recursive: true });
  symlinkSync(
    join(import.meta.dirname, "../../../../effect-scriptc-compat/node_modules"),
    join(directory, "node_modules"),
    "dir",
  );
  writeFileSync(entry, consoleAssertSource);
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
    expect(run.stdout).toBe('["This will be logged as an error"]\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
