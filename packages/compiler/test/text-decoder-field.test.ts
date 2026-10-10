import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

test("a utf-8 TextDecoder reached through an untyped helper decodes bytes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-textdecoder-"));
  const entry = join(directory, "main.js");
  const binary = join(directory, "main");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    entry,
    `const utf8Decoder = new TextDecoder("utf-8");
function getDecoder(charset) {
  if (charset === "utf-8" || charset === "utf8" || charset === "") return utf8Decoder;
  try {
    return new TextDecoder(charset);
  } catch (error) {
    return utf8Decoder;
  }
}
function decodeField(info, value) {
  return getDecoder(info.contentTypeParameters.charset ?? "utf-8").decode(value);
}
function run(info, value) {
  console.log(decodeField(info, value));
}
run({ contentTypeParameters: {} }, new TextEncoder().encode("42"));
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
    expect(run.stdout).toBe("42\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
