import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// Equal.equals takes unknown. A typed Date must cross as a Date handle:
// the same instant is equal, a different instant is not, and a number
// with the same milliseconds is not a Date.
const equalDateSource = `import * as Equal from "effect/Equal"
const seen: unknown[] = []
seen.push(Equal.equals(1, 1))
seen.push(Equal.equals(NaN, NaN))
seen.push(Equal.equals("a", "b"))
seen.push(Equal.equals({ a: 1, b: 2 }, { a: 1, b: 2 }))
seen.push(Equal.equals([1, [2, 3]], [1, [2, 3]]))
seen.push(Equal.equals(new Date("2024-01-01"), new Date("2024-01-01")))
seen.push(Equal.equals(new Date("2024-01-01"), new Date("2024-01-02")))
seen.push(Equal.equals(new Date("2024-01-01"), Date.parse("2024-01-01")))
const m1 = new Map([["a", 1], ["b", 2]])
const m2 = new Map([["b", 2], ["a", 1]])
seen.push(Equal.equals(m1, m2))
const is5 = Equal.equals(5)
seen.push(is5(5))
seen.push(is5(3))
console.log(JSON.stringify(seen))
`;

test("Equal.equals treats a typed Date as a Date", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-equal-date-"));
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  mkdirSync(directory, { recursive: true });
  symlinkSync(
    join(import.meta.dirname, "../../../../effect-scriptc-compat/node_modules"),
    join(directory, "node_modules"),
    "dir",
  );
  writeFileSync(entry, equalDateSource);
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
      "[true,true,false,true,true,true,false,false,true,true,false]\n",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
