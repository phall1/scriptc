import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// Effect's LinesIterator returns two object literals from next(). JavaScript
// infers that as a checked-dynamic result, then for-of reads done and value.
const source = `class Lines {
  constructor(s) {
    this.s = s;
    this.index = 0;
    this.length = s.length;
  }
  next() {
    if (this.index >= this.length) return { done: true, value: undefined };
    const start = this.index;
    while (this.index < this.length && this.s[this.index] !== "\\n") {
      this.index = this.index + 1;
    }
    let end = this.index;
    if (this.index < this.length) {
      this.index = this.index + 1;
      end = this.index;
    }
    return { done: false, value: this.s.substring(start, end) };
  }
  [Symbol.iterator]() {
    return new Lines(this.s);
  }
}
export function strip(self, marginChar) {
  let out = "";
  for (const line of new Lines(self)) {
    let index = 0;
    while (index < line.length && line.charAt(index) <= " ") index = index + 1;
    const stripped =
      index < line.length && line.charAt(index) === marginChar
        ? line.substring(index + 1)
        : line;
    out = out + stripped;
  }
  return out;
}
export function parts(self) {
  return [...new Lines(self)];
}
`;

const entrySource = `import { parts, strip } from "widgets/lines.js";
console.log(JSON.stringify([
  strip("  |hello\\n  |world", "|"),
  strip("", "|"),
  strip("plain", "|"),
  parts("a\\nb"),
]));
`;

test("a JS class iterator with two next() results matches Node", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-js-class-iterator-"));
  const pkg = join(directory, "node_modules", "widgets");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "widgets", version: "0.0.0" }));
  writeFileSync(join(pkg, "lines.js"), source);
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
    const oracle = spawnSync(process.execPath, [entry], { encoding: "utf8", timeout: 30_000 });
    expect(oracle.status, oracle.stderr).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(oracle.stdout);
    expect(run.stdout).toBe('["hello\\nworld","","plain",["a\\n","b"]]\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
