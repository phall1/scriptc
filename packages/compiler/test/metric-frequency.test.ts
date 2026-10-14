import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

const mostFrequent = `function most(occurrences: ReadonlyMap<string, number>): [string, number] {
  let maxKey = ""
  let maxCount = 0
  for (const [key, count] of occurrences) {
    if (count > maxCount) {
      maxKey = key
      maxCount = count
    }
  }
  return [maxKey, maxCount]
}
`;

function dynNumberMap(body: string): string {
  return `${mostFrequent}
function load(): unknown {
  const occurrences = new Map<unknown, unknown>()
  ${body}
  return occurrences
}
console.log(JSON.stringify(most(load() as ReadonlyMap<string, number>)))
`;
}

async function compileNative(
  source: string,
  label: string,
  npmStatic: boolean,
): Promise<{ status: number | null; stdout: string; stderr: string; diagnostics: string }> {
  const directory = mkdtempSync(join(tmpdir(), `scriptc-${label}-`));
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  mkdirSync(directory, { recursive: true });
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
      ...(npmStatic ? { npmStatic: ["effect"] } : {}),
    });
    if (!result.ok) {
      return { status: null, stdout: "", stderr: "", diagnostics: JSON.stringify(result.diagnostics) };
    }
    const run = spawnSync(result.binaryPath, [], { encoding: "utf8", timeout: 30_000 });
    if (npmStatic) {
      const oracle = spawnSync(process.execPath, ["--experimental-strip-types", entry], {
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(oracle.status, oracle.stderr).toBe(0);
      expect(run.stdout).toBe(oracle.stdout);
    }
    return { status: run.status, stdout: run.stdout, stderr: run.stderr, diagnostics: "" };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("a dyn map of string keys and number values checks as ReadonlyMap<string, number>", async () => {
  const run = await compileNative(
    dynNumberMap(`occurrences.set("200", 3)\noccurrences.set("404", 1)`),
    "dyn-map-numbers",
    false,
  );
  expect(run.diagnostics).toBe("");
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  expect(run.stdout).toBe('["200",3]\n');
}, 120_000);

test("a dyn map with a string value does not check as ReadonlyMap<string, number>", async () => {
  const run = await compileNative(
    dynNumberMap(`occurrences.set("a", "x")`),
    "dyn-map-strings",
    false,
  );
  expect(run.diagnostics).toBe("");
  expect(run.status).not.toBe(0);
  expect(run.stderr).toContain("expected map<string,f64>");
}, 120_000);

test("a Map<string, string> does not check as ReadonlyMap<string, number>", async () => {
  const source = `${mostFrequent}
function load(): unknown {
  const occurrences = new Map<string, string>()
  occurrences.set("a", "x")
  return occurrences
}
console.log(JSON.stringify(most(load() as ReadonlyMap<string, number>)))
`;
  const run = await compileNative(source, "typed-string-map", false);
  expect(run.diagnostics).toBe("");
  expect(run.status).not.toBe(0);
  expect(run.stderr).toContain("expected map<string,f64>");
}, 120_000);

test("Metric.frequency reports the most common keys", async () => {
  const source = readFileSync(
    join(import.meta.dirname, "../../../../effect-scriptc-compat/cases/documented-metric.ts"),
    "utf8",
  );
  const run = await compileNative(source, "metric-frequency", true);
  expect(run.diagnostics).toBe("");
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  expect(run.stdout).toBe('[[["200",3],["click",3]]]\n');
}, 180_000);
