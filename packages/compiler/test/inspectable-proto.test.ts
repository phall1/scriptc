import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// Inspectable.BaseProto is an object used as a prototype. Assigning it
// onto an ordinary function's prototype must store that object: the
// following constructor write and a later read see the same value.
const inspectableSource = `import * as Inspectable from "effect/Inspectable"
const myObject = Object.create(Inspectable.BaseProto)
myObject.name = "example"
myObject.value = 42
function MyClass(this: any, name: string) {
  this.name = name
}
MyClass.prototype = Object.create(Inspectable.BaseProto)
MyClass.prototype.constructor = MyClass
MyClass.prototype.tag = "proto"
console.log(JSON.stringify([myObject.toString(), MyClass.prototype.tag]))
`;

test("Inspectable.BaseProto survives a function prototype assignment", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-inspectable-proto-"));
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  mkdirSync(directory, { recursive: true });
  symlinkSync(
    join(import.meta.dirname, "../../../../effect-scriptc-compat/node_modules"),
    join(directory, "node_modules"),
    "dir",
  );
  writeFileSync(entry, inspectableSource);
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
    expect(run.stdout).toBe('["\\"[toJSON threw]\\"","proto"]\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
