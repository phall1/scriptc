import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze, compile } from "../src/index.js";

const dateProgram = `
console.log(new Date(0).toJSON("ignored"));
console.log(new Date(NaN).toJSON());
`;

const optionsProbe = `
export function build(options) {
  let n = 0;
  if (options.until) n += options.until(1);
  if (options.while) n += options.while(1);
  return n;
}
`;

const optionsProgram = `
import { build } from "options-fixture/probe.js";

console.log(build({ while: (value: number) => value + 2 }));
console.log(build({ schedule: 1 }));
`;

const errorProbe = `
export function described() {
  const error = new Error("boom");
  error.extra = "x";
  const current = error instanceof Error ? { ...error, name: error.name, message: error.message } : error;
  return Object.keys(error).sort().join(",") + "\\n" + Object.keys(current).sort().join(",") + ":" + current.name + ":" + current.message + ":" + current.extra;
}
`;

const errorProgram = `
import { described } from "error-spread-fixture/probe.js";

console.log(described());
`;

async function matchesNode(name: string, probe: string, program: string): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), `scriptc-${name}-`));
  const pkg = join(directory, "node_modules", name);
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name, version: "0.0.0", type: "module" }),
  );
  writeFileSync(join(pkg, "probe.js"), probe);
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  writeFileSync(entry, program);
  try {
    const coverage = analyze(entry, { npmStatic: [name] });
    const fences = [...coverage.coverage.diagnostics, ...(coverage.coverage.runtimeFences ?? [])];
    expect(fences, JSON.stringify(fences)).toEqual([]);
    const result = await compile(entry, {
      outDir: directory,
      outPath: binary,
      outputKind: "exe",
      optimization: "dev",
      npmStatic: [name],
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
}

test("Date toJSON matches Node for valid and invalid dates", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-date-json-"));
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  writeFileSync(entry, dateProgram);
  try {
    const coverage = analyze(entry);
    const fences = [...coverage.coverage.diagnostics, ...(coverage.coverage.runtimeFences ?? [])];
    expect(fences, JSON.stringify(fences)).toEqual([]);
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
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(oracle.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a missing option method is not called", async () => {
  await matchesNode("options-fixture", optionsProbe, optionsProgram);
});

test("Object.keys and object spread of Error match Node", async () => {
  await matchesNode("error-spread-fixture", errorProbe, errorProgram);
});

const wrapperProbe = `
export function kind(value) {
  for (const valueOf of [Number.prototype.valueOf, Boolean.prototype.valueOf, String.prototype.valueOf]) {
    try {
      Reflect.apply(valueOf, value, []);
      return "yes";
    } catch {
      continue;
    }
  }
  return "no";
}
`;

const wrapperProgram = `
import { kind } from "primitive-wrapper-fixture/probe.js";

console.log(kind({ a: 1 }));
console.log(kind(true));
console.log(kind(1));
console.log(kind("ab"));
`;

test("boxed primitive valueOf probes match Node", async () => {
  await matchesNode("primitive-wrapper-fixture", wrapperProbe, wrapperProgram);
});

const callbackProbe = `
export function joined(transform) {
  return ["a", "b"].map(transform).join(",");
}
export function kept(predicate) {
  return [1, 2, 3, 4].filter(predicate).join(",");
}
export function visited(visit) {
  ["x", "y"].forEach(visit);
}
`;

const callbackProgram = `
import { joined, kept, visited } from "array-callback-fixture/probe.js";

const seen: string[] = [];
visited((part: string) => {
  seen.push(part);
});
console.log(joined((part: string) => part.toUpperCase()));
console.log(kept((value: number) => value % 2 === 0));
console.log(seen.join(","));
`;

test("unknown array callbacks match Node", async () => {
  await matchesNode("array-callback-fixture", callbackProbe, callbackProgram);
});
