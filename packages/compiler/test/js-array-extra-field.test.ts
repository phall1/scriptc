import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// Effect's SQL statement builder pushes an untyped helper onto a record
// array (`returningIdentifier` is not on the literal's shape) and spreads
// an unknown fragment. Both have to match Node.
const segmentsJs = `export function build(extra) {
  const segments = [{ _tag: "Literal", value: "a" }];
  const helper = Object.assign(Object.create(null), {
    _tag: "Helper",
    value: extra,
    returningIdentifier: "*",
  });
  segments.push(helper);
  return segments.map((segment) => [segment._tag, segment.value, segment.returningIdentifier]);
}

export function spreadTyped(value) {
  /** @type {{ _tag: string, value: string }[]} */
  const parts = [{ _tag: "Literal", value: "a" }];
  parts.push(...value);
  return parts.map((part) => [part._tag, part.value]);
}
`;

const entrySource = `import { build, spreadTyped } from "widgets/segments.js";
const incoming: unknown = [{ _tag: "Param", value: "b", extra: 1 }];
console.log(JSON.stringify([build("x"), spreadTyped(incoming)]));
`;

test("a package-JS record array keeps a pushed object's extra field", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-js-array-extra-"));
  const pkg = join(directory, "node_modules", "widgets");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "widgets", version: "0.0.0" }));
  writeFileSync(join(pkg, "segments.js"), segmentsJs);
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  writeFileSync(entry, entrySource);
  try {
    const result = await compile(entry, {
      outDir: directory,
      outPath: binary,
      outputKind: "exe",
      optimization: "dev",
      npmStatic: ["widgets"],
    });
    expect(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const run = spawnSync(result.binaryPath, [], { encoding: "utf8", timeout: 30_000 });
    const oracle = spawnSync(process.execPath, [entry], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(oracle.status, oracle.stderr).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(oracle.stdout);
    expect(run.stdout).toBe('[[["Literal","a",null],["Helper","x","*"]],[["Literal","a"],["Param","b"]]]\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
