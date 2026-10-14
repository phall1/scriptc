import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

const source = `
function family(f) {
  const atoms = new Map();
  const registry = new FinalizationRegistry((arg) => {
    const entry = atoms.get(arg);
    if (entry && entry.deref() === undefined) atoms.delete(arg);
  });
  return function (arg) {
    const ref = atoms.get(arg);
    const atom = ref && ref.deref();
    if (atom !== undefined) return atom;
    const created = f(arg);
    atoms.set(arg, new WeakRef(created));
    registry.register(created, arg);
    return created;
  };
}
const make = family((n) => ({ n: n, tag: "atom" }));
const first = make(1);
const second = make(1);
const other = make(2);
console.log(JSON.stringify([first.n, second.n, first === second, other.n, first === other]));
`;

test("a live WeakRef deref returns the target and the registry callback stays uncalled", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-weakref-"));
  const entry = join(directory, "main.js");
  const binary = join(directory, "main");
  writeFileSync(entry, source);
  try {
    const result = await compile(entry, {
      outDir: directory,
      outPath: binary,
      outputKind: "exe",
      optimization: "dev",
    });
    expect(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const run = spawnSync(result.binaryPath, [], { encoding: "utf8", timeout: 30_000 });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("[1,1,true,2,false]\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
