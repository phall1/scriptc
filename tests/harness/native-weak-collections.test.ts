import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const exec = promisify(execFile);

for (const backend of ["c", "llvm"] as const) {
  test(`weak collections keep engine identity in dynamic builds (${backend})`, async () => {
    const outDir = await mkdtemp(join(tmpdir(), "scriptc-weak-island-"));
    try {
      const entry = join(outDir, "main.ts");
      await writeFile(entry, `
const key: any = { value: 1 };
const other: any = { value: 1 };
const map = new WeakMap<object, number>();
const set = new WeakSet<object>([key]);
console.log(map.set(key, 3) === map, set.add(other) === set);
console.log(String(map.get(key)), String(map.get(other)), String(set.has(key)));
console.log(map instanceof WeakMap, set instanceof WeakSet, map instanceof WeakSet);
console.log(String(map.delete(key)), String(map.has(key)), String(set.delete(other)));
`);
      const result = await compile(entry, {
        backend, dynamic: true, sanitize: process.env["SCRIPTC_SAN"] === "1",
        outDir, outPath: join(outDir, "program"),
      });
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
      if (!result.ok) return;
      const [node, native] = await Promise.all([exec(process.execPath, [entry]), exec(result.binaryPath)]);
      expect(native.stdout).toBe(node.stdout);
      expect(native.stderr).toBe(node.stderr);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test(`weak collections refuse keys without native identity (${backend})`, async () => {
    const outDir = await mkdtemp(join(tmpdir(), "scriptc-weak-boundaries-"));
    try {
      const entry = join(outDir, "main.ts");
      await writeFile(entry, `
const map = new WeakMap<object, number>();
const set = new WeakSet<object>();
const record = { value: 1 };
const array = [1, 2];
const tuple: [string, number] = ["value", 1];
class Key { value: number; constructor() { this.value = 1; } }
const instance = new Key();
function check(value: any): void {
  try { map.set(value, 1); } catch (error) { if (error instanceof Error) console.log(error.message); else throw error; }
  try { set.add(value); } catch (error) { if (error instanceof Error) console.log(error.message); else throw error; }
}
check(record);
check(array);
check(tuple);
check(instance);
console.log("after");
`);
      const result = await compile(entry, {
        backend, dynamic: false, sanitize: process.env["SCRIPTC_SAN"] === "1",
        outDir, outPath: join(outDir, "program"),
      });
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
      if (!result.ok) return;
      const child = await exec(result.binaryPath);
      expect(child.stdout).toBe([
        ...Array(8).fill("Weak collection keys of this native reference type have no weak lifetime lowering"),
        "after", "",
      ].join("\n"));
      expect(child.stderr).toBe("");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
}
