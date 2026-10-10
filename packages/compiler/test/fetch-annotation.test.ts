import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// `typeof globalThis.fetch` is an @types/node signature. The const still
// holds the arrow, and Effect's fetch client calls that arrow.
test("a fetch annotation keeps the function passed to FetchHttpClient", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-fetch-annotation-"));
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
      'import { Effect } from "effect";',
      'import * as M from "effect/http/FetchHttpClient";',
      'import { HttpClient } from "effect/http";',
      "const fakeFetch: typeof globalThis.fetch = async () => new Response('{\"value\":7}', { status: 200, headers: { \"content-type\": \"application/json\" } });",
      "const program = Effect.gen(function* () {",
      "  const client = yield* HttpClient.HttpClient;",
      '  const response = yield* client.get("https://example.invalid/fixture");',
      "  return yield* response.json;",
      "}).pipe(Effect.provide(M.layer), Effect.provideService(M.Fetch, fakeFetch));",
      "console.log(JSON.stringify(await Effect.runPromise(program)));",
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
    expect(oracle.stdout).toBe('{"value":7}\n');
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(oracle.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
