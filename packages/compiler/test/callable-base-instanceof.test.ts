import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// Schema.Class returns a fresh class and subclasses it through a static
// extend(). The derived instance stays an instance of the outer class.
const classesJs = `function factory(base, name) {
  const out = class extends base {
    constructor(value) {
      super(value);
      this.kind = name;
    }
    static extend(name2) {
      return factory(this, name2);
    }
  };
  return out;
}
class Root {
  constructor(value) {
    this.value = value;
  }
}
export function Class(name) {
  return factory(Root, name);
}
`;

const entrySource = `import { Class } from "widgets/classes.js";
class Animal extends Class("Animal") {}
class Dog extends Animal.extend("Dog") {}
const rex = new Dog("Rex");
const plain = new Animal("Ada");
console.log(JSON.stringify({
  dog: rex instanceof Dog,
  animal: rex instanceof Animal,
  plainDog: plain instanceof Dog,
  plainAnimal: plain instanceof Animal,
  kind: rex.kind,
  value: rex.value,
  plainKind: plain.kind,
}));
`;

test("a call-heritage subclass stays an instance of the outer class", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-callable-instanceof-"));
  const pkg = join(directory, "node_modules", "widgets");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "widgets", version: "0.0.0" }));
  writeFileSync(join(pkg, "classes.js"), classesJs);
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
    expect(run.stdout).toBe(
      '{"dog":true,"animal":true,"plainDog":false,"plainAnimal":true,"kind":"Dog","value":"Rex","plainKind":"Animal"}\n',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
