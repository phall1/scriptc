import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze, compile } from "../src/index.js";

// Implicit-any monomorphization specializes hash per argument. A string
// call must not keep the Date arm's getTime fence, and an array call must
// not keep the number arm's bitwise compare. The folded tests still run
// their operands: id() prints before instanceof decides.
const probe = `
function id(value) {
  console.log("id");
  return value;
}
export function hash(self) {
  if (id(self) instanceof Date) return "date:" + self.getTime();
  switch (typeof self) {
    case "number":
      return (self | 0) === self ? "int" : "float";
    case "bigint":
      return "big:" + self.toString(10);
    case "string":
      return "str:" + self.length;
    case "function":
    case "object":
      if (self instanceof Date) return "date2";
      if (self instanceof RegExp) return "re:" + self.toString();
      return "len:" + self.length;
  }
  return "other";
}
`;

const program = `
import { hash } from "typeof-switch-fixture/probe.js";

console.log(hash("hi"));
console.log(hash(3));
console.log(hash(3.5));
console.log(hash([1, 2, 3]));
`;

const nullableProbe = `
export function head(stack, message) {
  const lines = (stack.startsWith(message) ? stack.slice(message.length) : stack).split("\\n");
  return lines[0];
}
`;

const nullableProgram = `
import { head } from "nullable-string-fixture/probe.js";

function maybe(flag: boolean): string | undefined {
  return flag ? "hello\\nworld" : undefined;
}

console.log(head(maybe(true), "hello"));
try {
  console.log(head(maybe(false), "hello"));
} catch (error) {
  if (error instanceof Error) console.log(error.name + ":" + error.message);
}
`;

test("string methods on string | undefined throw the nullish TypeError", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-nullable-string-"));
  const pkg = join(directory, "node_modules", "nullable-string-fixture");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "nullable-string-fixture", version: "0.0.0", type: "module" }),
  );
  writeFileSync(join(pkg, "probe.js"), nullableProbe);
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  writeFileSync(entry, nullableProgram);
  try {
    const coverage = analyze(entry, { npmStatic: ["nullable-string-fixture"] });
    const fences = [...coverage.coverage.diagnostics, ...(coverage.coverage.runtimeFences ?? [])];
    expect(fences, JSON.stringify(fences)).toEqual([]);
    const result = await compile(entry, {
      outDir: directory,
      outPath: binary,
      outputKind: "exe",
      optimization: "dev",
      npmStatic: ["nullable-string-fixture"],
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

test("a typeof switch drops unreachable arms for each specialization", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-typeof-switch-"));
  const pkg = join(directory, "node_modules", "typeof-switch-fixture");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "typeof-switch-fixture", version: "0.0.0", type: "module" }),
  );
  writeFileSync(join(pkg, "probe.js"), probe);
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  writeFileSync(entry, program);
  try {
    const coverage = analyze(entry, { npmStatic: ["typeof-switch-fixture"] });
    const fences = [...coverage.coverage.diagnostics, ...(coverage.coverage.runtimeFences ?? [])];
    expect(fences, JSON.stringify(fences)).toEqual([]);
    const result = await compile(entry, {
      outDir: directory,
      outPath: binary,
      outputKind: "exe",
      optimization: "dev",
      npmStatic: ["typeof-switch-fixture"],
    });
    expect(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const run = spawnSync(result.binaryPath, [], { encoding: "utf8", timeout: 30_000 });
    const oracle = spawnSync(process.execPath, ["--experimental-strip-types", entry], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(oracle.status, oracle.stderr).toBe(0);
    expect(oracle.stdout).toBe("id\nstr:2\nid\nint\nid\nfloat\nid\nlen:3\n");
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(oracle.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
