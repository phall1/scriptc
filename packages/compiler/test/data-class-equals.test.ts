import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// Data.Class is a non-generic class expression. The type argument on
// `extends Data.Class<{ name: string }>` only types the constructor props
// and erases. Equal.equals then compares the assigned fields.
const dataClassSource = `import * as Data from "effect/Data"
import { Equal } from "effect"
class Person extends Data.Class<{ readonly name: string }> {}
const mike = new Person({ name: "Mike" })
const ada = new Person({ name: "Ada" })
console.log(JSON.stringify([
  Equal.equals(mike, new Person({ name: "Mike" })),
  Equal.equals(mike, ada),
  JSON.stringify(mike),
]))
`;

test("Data.Class copies constructor props and Equal.equals compares them", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-data-class-"));
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  mkdirSync(directory, { recursive: true });
  symlinkSync(
    join(import.meta.dirname, "../../../../effect-scriptc-compat/node_modules"),
    join(directory, "node_modules"),
    "dir",
  );
  writeFileSync(entry, dataClassSource);
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
    expect(run.stdout).toBe('[true,false,"{\\"name\\":\\"Mike\\"}"]\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
