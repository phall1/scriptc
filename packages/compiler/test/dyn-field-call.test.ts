import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// A record field the checker only types as `any` is still the function
// stored on the object. Calling it has to run that function.
test("a call through an any-typed record field runs the stored function", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-dyn-field-"));
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  writeFileSync(
    entry,
    [
      "const seen: string[] = [];",
      "function make(run: (name: string) => void): { tag: string; run: any } {",
      '  return { tag: "Action", run };',
      "}",
      "const action = make((name) => {",
      "  seen.push(name);",
      "});",
      'action.run("fixture");',
      "console.log(JSON.stringify([action.tag, seen]));",
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
    expect(oracle.stdout).toBe('["Action",["fixture"]]\n');
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(oracle.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
