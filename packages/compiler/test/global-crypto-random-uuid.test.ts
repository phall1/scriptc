import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze, compile } from "../src/index.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("the global crypto.randomUUID call returns a v4 uuid", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-crypto-uuid-"));
  const entry = join(directory, "main.js");
  const binary = join(directory, "main");
  writeFileSync(
    entry,
    `const a = crypto.randomUUID();
const b = globalThis.crypto.randomUUID();
const cryptoLocal = { randomUUID() { return "shadow"; } };
console.log(JSON.stringify([a, b, cryptoLocal.randomUUID()]));
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
    const run = spawnSync(result.binaryPath, [], { encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout) as string[];
    expect(parsed[0]).toMatch(uuid);
    expect(parsed[1]).toMatch(uuid);
    expect(parsed[0]).not.toBe(parsed[1]);
    expect(parsed[2]).toBe("shadow");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an npm-static module calls the global crypto.randomUUID", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-crypto-uuid-pkg-"));
  const pkg = join(directory, "node_modules", "effect");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "effect", version: "0.0.0" }));
  writeFileSync(
    join(pkg, "probe.js"),
    `export function fresh() {
  return crypto.randomUUID();
}
`,
  );
  const entry = join(directory, "main.js");
  const binary = join(directory, "main");
  writeFileSync(
    entry,
    `import { fresh } from "effect/probe.js";
const a = fresh();
const b = fresh();
console.log(JSON.stringify([a, b, a !== b]));
`,
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
    const run = spawnSync(result.binaryPath, [], { encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout) as [string, string, boolean];
    expect(parsed[0]).toMatch(uuid);
    expect(parsed[1]).toMatch(uuid);
    expect(parsed[2]).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("globalThis.crypto.getRandomValues fills and returns the same Uint8Array", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-crypto-fill-"));
  const pkg = join(directory, "node_modules", "effect");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "effect", version: "0.0.0" }));
  writeFileSync(
    join(pkg, "probe.js"),
    `const hex = byte => byte.toString(16).padStart(2, "0");
export function fresh() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = bytes[6] & 0x0f | 0x40;
  bytes[8] = bytes[8] & 0x3f | 0x80;
  return Array.from(bytes, hex).join("");
}
`,
  );
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  writeFileSync(
    entry,
    `import { fresh } from "effect/probe.js";
const a = fresh();
const b = fresh();
console.log(JSON.stringify([a, b, a.length, a !== b]));
`,
  );
  try {
    const coverage = analyze(entry, { npmStatic: ["effect"] });
    const fences = [...coverage.coverage.diagnostics, ...(coverage.coverage.runtimeFences ?? [])];
    expect(fences, JSON.stringify(fences)).toEqual([]);
    const result = await compile(entry, {
      outDir: directory,
      outPath: binary,
      outputKind: "exe",
      optimization: "dev",
      npmStatic: ["effect"],
    });
    expect(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const run = spawnSync(result.binaryPath, [], { encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout) as [string, string, number, boolean];
    expect(parsed[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(parsed[1]).toMatch(/^[0-9a-f]{32}$/);
    expect(parsed[0]!.slice(12, 13)).toBe("4");
    expect("89ab".includes(parsed[0]!.slice(16, 17))).toBe(true);
    expect(parsed[2]).toBe(32);
    expect(parsed[3]).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
