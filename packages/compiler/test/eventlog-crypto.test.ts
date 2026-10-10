import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// makeEncryptionSubtle(globalThis.crypto) hashes through subtle.digest.
test("globalThis.crypto hashes through the native WebCrypto object", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-eventlog-crypto-"));
  const entry = join(
    import.meta.dirname,
    "../../../../effect-scriptc-compat/cases/remaining-core-eventlog--eventlogencryption.ts",
  );
  const binary = join(directory, "main");
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
    expect(oracle.stdout).toBe(
      '"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"\n',
    );
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(oracle.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
