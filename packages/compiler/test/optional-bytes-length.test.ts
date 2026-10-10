import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

test("an optional length read keeps a specialized Uint8Array", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-optlen-"));
  const entry = join(directory, "main.js");
  const binary = join(directory, "main");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    entry,
    `function len(value) {
  return value?.length ?? 0;
}
console.log(len(new Uint8Array([1, 2, 3])));
console.log(len("ab"));
console.log(len(undefined));
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
    expect(run.stdout).toBe("3\n2\n0\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
