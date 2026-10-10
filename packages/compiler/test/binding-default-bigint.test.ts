import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

test("a numeric destructure default still accepts a present bigint", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-binddefault-"));
  const entry = join(directory, "main.js");
  const binary = join(directory, "main");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    entry,
    `function make({ maxFieldSize: maxFieldSizeInput = 1024 * 1024 }) {
  const toLimit = (input) => input === Infinity ? Infinity : Number(input);
  return toLimit(maxFieldSizeInput);
}
console.log(String(make({ maxFieldSize: 10n })));
console.log(String(make({})));
`,
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
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("10\n1048576\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
