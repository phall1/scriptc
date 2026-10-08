import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

// Implicit specialization belongs to opted-in package JavaScript; user JS
// deliberately retains its checked ABI. Exercise that real package boundary.
const factory = `
export function instanceOf(constructor, annotations) {
  return { test: (value) => value instanceof constructor, annotations, constructor };
}
export function forward(constructor, annotations) {
  return instanceOf(constructor, annotations);
}
export function aliasPredicate(C) {
  const Alias = C;
  return value => value instanceof Alias;
}
function defaultTDZ(value, flag = value instanceof C, C) { return flag; }
function initializedDefault(C, value, flag = value instanceof C) { return flag; }
function effectfulDefault(value, flag = (console.log("lhs"), value) instanceof C, C) { return flag; }
function localAliasTDZ(C) {
  try {
    console.log("local-lhs");
    console.log("local", {} instanceof Alias);
    const Alias = C;
  } catch (error) { console.log("local", error.name); }
}
export function tdzChecks() {
  try { console.log("tdz", defaultTDZ({}, undefined, globalThis.URL)); }
  catch (error) { console.log("tdz", error.name); }
  console.log("provided", defaultTDZ({}, false, globalThis.URL));
  console.log("initialized", initializedDefault(globalThis.URL, new globalThis.URL("https://example.com")));
  try { console.log("effect", effectfulDefault({}, undefined, globalThis.URL)); }
  catch (error) { console.log("effect", error.name); }
  localAliasTDZ(globalThis.URL);
}
`;

const program = `
export function run() {
const annotations = { id: "effect/schema/URL", payload: null, expected: "globalThis.URL" };
const urlSchema = instanceOf(globalThis.URL, annotations);
const regexSchema = instanceOf(globalThis.RegExp, annotations);
const paramsSchema = instanceOf(globalThis.URLSearchParams, annotations);
const Alias = globalThis.URL;
const aliased = forward(Alias, annotations);
const reverseRegex = forward(globalThis.RegExp, annotations);
const reverseUrl = forward(globalThis.URL, annotations);
const url = new URL("https://example.com/?q=1");
function check(value) {
  console.log(urlSchema.test(value), regexSchema.test(value), paramsSchema.test(value), aliased.test(value), reverseRegex.test(value), reverseUrl.test(value));
}
check(url);
check(/q/);
check(new URLSearchParams("q=1"));
check({});
check(null);
check(undefined);
check(42);
check("[builtin URL]");
console.log(JSON.stringify(urlSchema.annotations));
console.log("ctor-types", typeof urlSchema.constructor, typeof regexSchema.constructor, typeof paramsSchema.constructor);
console.log("ctor-identity", urlSchema.constructor === Alias, regexSchema.constructor === globalThis.RegExp, paramsSchema.constructor === globalThis.URLSearchParams, urlSchema.constructor === "[builtin URL]");
console.log("ctor-names", urlSchema.constructor.name, regexSchema.constructor.name, paramsSchema.constructor.name);
console.log("ctor-lengths", urlSchema.constructor.length, regexSchema.constructor.length, paramsSchema.constructor.length);
console.log("ctor-json", JSON.stringify({ constructor: urlSchema.constructor, payload: null }));
console.log("predicate-alias", aliasPredicate(globalThis.URL)(url));
tdzChecks();
function shadowed() {
  class URL {}
  const schema = instanceOf(URL, annotations);
  console.log("shadow", schema.test(new URL()), schema.test({}));
}
shadowed();
}
`;

test.each(["URL", "URLSearchParams", "RegExp"])(
  "%s snapshot explicitly refuses Proxy operands instead of dropping traps",
  async (constructor) => {
    const directory = mkdtempSync(join(tmpdir(), "scriptc-constructor-proxy-"));
    try {
      const packageRoot = join(directory, "node_modules", "constructor-fixture");
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(join(directory, "package.json"), '{"type":"module"}\n');
      writeFileSync(
        join(packageRoot, "package.json"),
        '{"name":"constructor-fixture","type":"module","exports":"./index.js"}\n',
      );
      writeFileSync(
        join(packageRoot, "index.js"),
        `${factory}
        export function run() {
          const test = aliasPredicate(globalThis.${constructor});
          const value = new Proxy({}, { getPrototypeOf() { console.log("trap"); return null; } });
          console.log("result", test(value));
        }
      `,
      );
      const entry = join(directory, "main.ts");
      writeFileSync(entry, 'import { run } from "constructor-fixture"; run();\n');
      const node = spawnSync(process.execPath, [entry], { timeout: 30_000 });
      expect(node.status).toBe(0);
      expect(node.stdout.toString()).toBe("trap\nresult false\n");
      expect(node.stderr.length).toBe(0);
      const result = await compile(entry, {
        backend: "llvm",
        npmStatic: ["constructor-fixture"],
        outDir: directory,
        outPath: join(directory, "program"),
        sanitize: process.env["SCRIPTC_SAN"] === "1",
      });
      if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
      const native = spawnSync(result.binaryPath, [], { timeout: 30_000 });
      expect(native.error).toBeUndefined();
      expect(native.signal).toBeNull();
      expect(native.status).not.toBe(0);
      expect(native.stdout.length).toBe(0);
      expect(native.stderr.toString()).toContain(
        "Native builtin instanceof on a Proxy has no lowering [SC1090]",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test.each([
  "C();",
  "Object.defineProperty(C, 'x', { value: 1 });",
  "Object.defineProperty(C, Symbol.hasInstance, { value: () => true });",
  "Object.setPrototypeOf(C, null);",
  "console.log(!!C.prototype);",
  "console.log(typeof C.canParse);",
  "console.log(typeof C[Symbol.hasInstance]);",
  "console.log(Symbol.hasInstance in C);",
  "delete C[Symbol.hasInstance];",
  "Reflect.get(C, 'prototype');",
  "Reflect.set(C, 'x', 1);",
  "Reflect.set({}, 'x', 1, C);",
  "structuredClone(C);",
  "atob(C);",
  "btoa(C);",
  "new DOMException('m', C);",
  "new DOMException(C);",
  "new C('https://example.com');",
  "String(C);",
  "console.log(typeof new Proxy(C, {}).canParse);",
  "console.log(!!new Proxy(C, {}).prototype);",
  "Reflect.get(new Proxy(C, {}), 'prototype');",
])("constructor value keeps an explicit boundary for %s", async (operation) => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-constructor-boundary-"));
  try {
    const root = join(directory, "node_modules", "constructor-fixture");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(directory, "package.json"), '{"type":"module"}\n');
    writeFileSync(
      join(root, "package.json"),
      '{"name":"constructor-fixture","type":"module","exports":"./index.js"}\n',
    );
    writeFileSync(
      join(root, "index.js"),
      `function boundary(C) { ${operation} console.log("done"); } export function run() { boundary(globalThis.URL); }`,
    );
    const entry = join(directory, "main.ts");
    writeFileSync(entry, 'import { run } from "constructor-fixture"; run();\n');
    const result = await compile(entry, {
      backend: "llvm",
      npmStatic: ["constructor-fixture"],
      outDir: directory,
      outPath: join(directory, "program"),
      sanitize: process.env["SCRIPTC_SAN"] === "1",
    });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const native = spawnSync(result.binaryPath, [], { timeout: 30_000 });
    expect(native.error).toBeUndefined();
    expect(native.signal).toBeNull();
    expect(native.status).not.toBe(0);
    expect(native.stdout.length).toBe(0);
    expect(native.stderr.toString()).toContain("SC1090");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("immutable package constructor snapshots preserve native brands and metadata", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-constructor-snapshots-"));
  try {
    const packageRoot = join(directory, "node_modules", "constructor-fixture");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(directory, "package.json"), '{"type":"module"}\n');
    writeFileSync(
      join(packageRoot, "package.json"),
      '{"name":"constructor-fixture","type":"module","exports":"./index.js"}\n',
    );
    writeFileSync(join(packageRoot, "index.js"), factory + program);
    const entry = join(directory, "main.ts");
    writeFileSync(entry, 'import { run } from "constructor-fixture"; run();\n');
    const node = spawnSync(process.execPath, [entry], { timeout: 30_000 });
    expect(node.error).toBeUndefined();
    expect(node.status).toBe(0);
    expect(node.stderr.length).toBe(0);
    const result = await compile(entry, {
      backend: "llvm",
      npmStatic: ["constructor-fixture"],
      outDir: directory,
      outPath: join(directory, "program"),
      sanitize: process.env["SCRIPTC_SAN"] === "1",
    });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const native = spawnSync(result.binaryPath, [], { timeout: 30_000 });
    expect(native.error).toBeUndefined();
    expect(native.signal).toBeNull();
    expect(native.stdout.toString()).toBe(node.stdout.toString());
    expect(native.stderr.toString()).toBe(node.stderr.toString());
    expect(native.status).toBe(node.status);
    expect(native.stdout.equals(node.stdout)).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
