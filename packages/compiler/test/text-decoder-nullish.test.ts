import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// A captured `let decoder` in JavaScript is an evolving any. `??=` must
// store the real TextDecoder, and a later byte chunk must stream through
// it. A string chunk never constructs the decoder.
const source = `
function makeDecoder() {
  let decoder;
  return {
    decode(bytes) {
      return typeof bytes === "string"
        ? bytes
        : (decoder ??= new TextDecoder()).decode(bytes, { stream: true });
    },
  };
}
const decoder = makeDecoder();
const chunk = new Uint8Array([97, 98, 99]);
console.log(JSON.stringify([decoder.decode("hi"), decoder.decode(chunk), decoder.decode(chunk)]));
`;

test("a captured JavaScript TextDecoder survives ??= and streams bytes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-text-decoder-"));
  const entry = join(directory, "main.js");
  const binary = join(directory, "main");
  writeFileSync(entry, source);
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
    const oracle = spawnSync(process.execPath, [entry], { encoding: "utf8", timeout: 30_000 });
    expect(oracle.status, oracle.stderr).toBe(0);
    expect(oracle.stdout).toBe('["hi","abc","abc"]\n');
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(oracle.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
