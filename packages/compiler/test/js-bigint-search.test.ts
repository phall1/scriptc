import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// Effect's BigDecimal divides untyped operands and then multiplies the
// quotient by a bigint. Effect's String.search passes an untyped pattern
// through to String.prototype.search. Both have to match Node.
const source = `const bigint0 = BigInt(0);
const bigint10 = BigInt(10);
function divideLike(num, den, scale, precision) {
  const numNegative = num < bigint0;
  num = numNegative ? -num : num;
  let quotient = num / den;
  let remainder = num % den;
  if (remainder === bigint0) return [String(quotient), scale];
  let count = \`\${quotient}\`.length;
  remainder *= bigint10;
  while (remainder !== bigint0 && count < precision) {
    const q = remainder / den;
    const r = remainder % den;
    quotient = quotient * bigint10 + q;
    remainder = r * bigint10;
    count++;
    scale++;
  }
  return [String(quotient), String(remainder), count, scale];
}
function pack(value, scale) {
  return [String(value), scale];
}
export function find(self, pattern) {
  return self.search(pattern);
}
export function divide(num, den, scale, precision) {
  return divideLike(num, den, scale, precision);
}
export function abs(n) {
  const bigint0 = BigInt(0);
  return n.value < bigint0 ? pack(-n.value, n.scale) : pack(n.value, n.scale);
}
`;

const entrySource = `import { abs, divide, find } from "widgets/ops.js";
const num: unknown = 10n;
const den: unknown = 3n;
const scale: unknown = 0;
const negative: unknown = -10n;
const pattern: unknown = "b";
const dotted: unknown = ".";
const missing: unknown = "d";
const expression: unknown = /abb/;
const negativeDecimal: unknown = { value: -5n, scale: 0 };
const positiveDecimal: unknown = { value: 5n, scale: 1 };
console.log(JSON.stringify([
  divide(num, den, scale, 5),
  divide(negative, den, scale, 4),
  find("ababb", pattern),
  find("ababb", expression),
  find("ababb", dotted),
  find("ababb", missing),
  abs(negativeDecimal),
  abs(positiveDecimal),
]));
`;

test("untyped JS bigint arithmetic and string search match Node", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-js-bigint-search-"));
  const pkg = join(directory, "node_modules", "widgets");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "widgets", version: "0.0.0" }));
  writeFileSync(join(pkg, "ops.js"), source);
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
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
