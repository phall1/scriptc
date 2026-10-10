import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function compileProbe(file: string, expected: string): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-multipart-"));
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  mkdirSync(directory, { recursive: true });
  symlinkSync(
    join(import.meta.dirname, "../../../../effect-scriptc-compat/node_modules"),
    join(directory, "node_modules"),
    "dir",
  );
  writeFileSync(
    entry,
    readFileSync(join(import.meta.dirname, "../../../../effect-scriptc-compat/cases", file), "utf8"),
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
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(oracle.stdout);
    expect(run.stdout).toBe(expected);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("MultipartParser collects a form field", async () => {
  await compileProbe("module-http--multipartparser.ts", '["answer:42","done"]\n');
}, 180_000);

test("the internal multipart parser collects a form field", async () => {
  await compileProbe(
    "module-http--multipartparser--internal--multipart.ts",
    '["answer:42","done"]\n',
  );
}, 180_000);

test("Multipart.makeChannel collects a form field", async () => {
  await compileProbe("module-http--multipart.ts", '[["answer","42"]]\n');
}, 180_000);
