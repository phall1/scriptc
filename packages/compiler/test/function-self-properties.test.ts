import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

const source = `
const LifetimeProto = {
  mount(atom) {
    return "mount:" + atom;
  },
};
function makeLifetime(node) {
  function get(atom) {
    if (get.disposed || get.isFn) return node;
    return atom + ":" + String(get.node);
  }
  Object.setPrototypeOf(get, LifetimeProto);
  get.isFn = false;
  get.disposed = false;
  get.node = node;
  return get;
}
const g = makeLifetime("N");
const first = g("a");
g.disposed = true;
const second = g("b");
console.log(JSON.stringify([first, second, g.mount("c"), g.isFn, g.node]));
`;

test("a nested function reads properties stored on itself", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-fnself-"));
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
    expect(run.stdout).toBe('["a:N","N","mount:c",false,"N"]\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
