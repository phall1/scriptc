import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// npm-static hides effect's .d.ts, so `Sharding.Sharding["Service"]` is an
// unresolved type. It prints as `any`, but it is the error type, not an
// authored `any`. The object still spreads the live service and the
// explicit method replaces the copied one. Node sees the declaration.
test("an unresolved Sharding service annotation spreads and overrides a method", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-service-spread-"));
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  symlinkSync(
    join(import.meta.dirname, "../../../../effect-scriptc-compat/node_modules"),
    join(directory, "node_modules"),
    "dir",
  );
  writeFileSync(
    entry,
    [
      'import { Effect, Layer } from "effect";',
      'import * as M from "effect/cluster/Singleton";',
      'import { TestRunner, Sharding } from "effect/cluster";',
      "const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {",
      "  const sharding = yield* Sharding.Sharding;",
      "  const registrations: Array<string> = [];",
      '  const spy: Sharding.Sharding["Service"] = {',
      "    ...sharding,",
      "    registerSingleton: (name, _run, options) =>",
      "      Effect.sync(() => {",
      '        registrations.push(name + ":" + options?.shardGroup);',
      "      }),",
      "  };",
      '  yield* Layer.build(M.make("fixture", Effect.void, { shardGroup: "default" })).pipe(',
      "    Effect.provideService(Sharding.Sharding, spy),",
      "  );",
      "  return registrations;",
      "})).pipe(Effect.provide(TestRunner.layer)));",
      "console.log(JSON.stringify(result));",
      "",
    ].join("\n"),
  );
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
    expect(oracle.stdout).toBe('["fixture:default"]\n');
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(oracle.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
