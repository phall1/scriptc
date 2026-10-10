import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// urlBuilder starts from `{}` and writes group and endpoint keys onto that
// same object. The caller then reads `builder.items`.
const clientSource = `import { Schema } from "effect";
import * as M from "effect/http-api/HttpApiClient";
import { HttpApi, HttpApiGroup, HttpApiEndpoint } from "effect/http-api";
const api = HttpApi.make("Fixture").add(HttpApiGroup.make("items").add(HttpApiEndpoint.get("read", "/items/:id", { params: { id: Schema.String }, query: { q: Schema.String } })));
const builder = M.urlBuilder(api, { baseUrl: "https://example.invalid" });
console.log(JSON.stringify(builder.items.read({ params: { id: "a b" }, query: { q: "x y" } })));
`;

async function compileAndMatch(source: string, expected: string): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-url-builder-"));
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

test("urlBuilder keeps group keys written onto the empty object", async () => {
  await compileAndMatch(clientSource, '"https://example.invalid/items/a%20b?q=x+y"\n');
}, 180_000);
