import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

const source = `
function PipeableBase() {}
const DataClass = class extends PipeableBase {
  constructor(props) {
    super();
    if (props) Object.assign(this, props);
  }
};
function makeClass() {
  return class extends DataClass {
    constructor(input) {
      super(input);
    }
  };
}
function variantClass() {
  class Base extends makeClass() {}
  return Base;
}
class Item extends variantClass() {}
const item = new Item({ id: 1, name: "fixture" });
function FnBase(props) {
  this.kind = "fn";
  Object.assign(this, props);
}
class Child extends FnBase {}
const child = new Child({ n: 2 });
console.log(item.id + ":" + item.name + ":" + child.kind + ":" + child.n);
`;

test("super() into a returned class copies the constructed properties", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-class-super-"));
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
    const run = spawnSync(result.binaryPath, [], { encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("1:fixture:fn:2\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
