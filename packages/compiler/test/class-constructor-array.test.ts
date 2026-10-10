import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// MailboxFull and AlreadyProcessingMessage are different classes whose
// checker types collapse to one constructor. The array must keep every
// class object so an element check does not reject the missing one.
const source = `
import { AlreadyProcessingMessage, EntityNotAssignedToRunner, MailboxFull, PersistenceError } from "effect/cluster/ClusterError";
const clientErrors = [MailboxFull, AlreadyProcessingMessage, PersistenceError];
const requestErrors = [...clientErrors, EntityNotAssignedToRunner];
console.log(JSON.stringify([clientErrors.length, requestErrors.length]));
`;

test("an array of structurally similar class constructors keeps each class", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-class-ctors-"));
  const entry = join(directory, "main.js");
  const binary = join(directory, "main");
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
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);

test("entity proxy reports rpc and http names for a counter entity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-entity-proxy-"));
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  symlinkSync(
    join(import.meta.dirname, "../../../../effect-scriptc-compat/node_modules"),
    join(directory, "node_modules"),
    "dir",
  );
  writeFileSync(
    entry,
    readFileSync(
      join(
        import.meta.dirname,
        "../../../../effect-scriptc-compat/cases/namespace-cluster-entityproxy.ts",
      ),
    ),
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
    expect(run.stdout).toBe(
      '[["Counter.Get","Counter.GetDiscard"],"counters",["Get","GetDiscard"]]\n',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
