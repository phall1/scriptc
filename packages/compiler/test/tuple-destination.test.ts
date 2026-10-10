import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// Effect's makeRunMain callback is compiled from JavaScript, so its teardown
// argument does not contextually type `code` as number. The Promise resolve
// slot still expects [Exit, number]. The fresh tuple has to be built for
// that slot.
const source = `const __compatObserved: unknown[] = []
import * as Runtime from "effect/Runtime"
import { Effect, Exit } from "effect"

const customTeardown: Runtime.Teardown = (exit, onExit) => {
  onExit(Exit.isSuccess(exit) ? 0 : 1)
}

const completed = new Promise<readonly [Exit.Exit<unknown, unknown>, number]>((resolve) => {
  const runMain = Runtime.makeRunMain(({ fiber, teardown }) => {
    fiber.addObserver((exit) => {
      teardown(exit, (code) => resolve([exit, code]))
    })
  })

  const program = Effect.succeed("Hello, World!")
  runMain(program, { teardown: customTeardown })
})

__compatObserved.push(await completed)
console.log(JSON.stringify(__compatObserved))
`;

test("a Promise tuple checks an unannotated teardown code as a number", async () => {
  const effectModules = join(
    import.meta.dirname,
    "../../../../effect-scriptc-compat/node_modules",
  );
  const directory = mkdtempSync(join(tmpdir(), "scriptc-tuple-dest-"));
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  mkdirSync(directory, { recursive: true });
  symlinkSync(effectModules, join(directory, "node_modules"), "dir");
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
    expect(run.stdout).toBe('[[{"_id":"Exit","_tag":"Success","value":"Hello, World!"},0]]\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
