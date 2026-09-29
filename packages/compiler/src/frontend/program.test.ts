import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { checkPreflight, loadProgram, makeCycleAdmission, type CycleEdge } from "./program-node.js";
import * as ts from "./ts7/ast.js";

function requireOrderDiagnostics(source: string, dependency = "exports.value = 'ready';\n") {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-require-order-"));
  const entry = join(dir, "main.cjs");
  writeFileSync(entry, source);
  writeFileSync(join(dir, "dep.cjs"), dependency);
  const load = loadProgram(entry);
  try {
    return checkPreflight(load);
  } finally {
    load.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

test.for([
  "exports.read = read;",
  "module.exports.renamed = read;",
  "module.exports = read;",
])("a hoisted function export before require is safe: %s", (publish) => {
  expect(requireOrderDiagnostics(`
'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
${publish}
const dep = require('./dep.cjs');
function read() { return helper(); }
function helper() { return dep.value; }
`)).toEqual([]);
});

test.for([
  "exports.a = exports.b = void 0;",
  "exports.a = undefined; exports.b = 'literal'; exports.c = 1;",
  "exports.first = exports.second = read;",
])("literal and chained export prologues do not invoke functions: %s", (prefix) => {
  expect(requireOrderDiagnostics(`
Object.defineProperty(exports, '__esModule', { value: true });
${prefix}
exports.read = read;
const dep = require('./dep.cjs');
function read() { return dep.value; }
`)).toEqual([]);
});

test.for([
  ["direct call", "read();"],
  ["transitive call", "helper(); function helper() { return read(); }"],
  ["callback escape", "[1].map(read);"],
  ["export call", "exports.read();"],
  ["export alias call", "const alias = exports; alias.read();"],
  ["computed export name", "exports[read()] = read;"],
  ["export initializer call", "exports.value = read();"],
  ["class static initializer", "class Early { static value = read(); }"],
  ["extra descriptor effect", "Object.defineProperty(exports, '__esModule', { value: true, enumerable: read() });"],
  ["void initializer call", "exports.value = void read();"],
  ["prototype mutation", "exports.__proto__ = read;"],
  ["read-only marker", "Object.defineProperty(exports, '__esModule', { value: true }); exports.__esModule = read;"],
  ["replacement export property", "module.exports = read; module.exports.name = read;"],
  ["non-export assignment chain", "const box = {}; exports.alias = box.read = read;"],
])("require still refuses an early read through %s", ([, early]) => {
  const diagnostics = requireOrderDiagnostics(`
exports.read = read;
${early}
const dep = require('./dep.cjs');
function read() { return dep.value; }
`);
  expect(diagnostics.some((diag) => diag.code === "SC1013" && diag.message.includes("binding 'dep'")))
    .toBe(true);
});

test("publishing a require binding itself still reads it before initialization", () => {
  const diagnostics = requireOrderDiagnostics(`
exports.read = read;
const { read } = require('./dep.cjs');
`);
  expect(diagnostics.some((diag) => diag.code === "SC1013" && diag.message.includes("binding 'read'")))
    .toBe(true);
});

test.for([
  "var Object = null; Object.defineProperty(exports, '__esModule', { value: true }); exports.read = read;",
  "var exports = null; exports.read = read;",
  "var module = null; module.exports = read;",
])("source bindings cannot masquerade as a CommonJS prologue: %s", (prefix) => {
  const diagnostics = requireOrderDiagnostics(`
${prefix}
const dep = require('./dep.cjs');
function read() { return dep.value; }
`);
  expect(diagnostics.some((diag) => diag.code === "SC1013" && diag.message.includes("binding 'dep'")))
    .toBe(true);
});

test("an earlier declarator can call an export before the require initializes", () => {
  const diagnostics = requireOrderDiagnostics(`
exports.read = read;
const before = read(), dep = require('./dep.cjs');
function read() { return dep.value; }
`);
  expect(diagnostics.some((diag) => diag.code === "SC1013" && diag.message.includes("binding 'dep'")))
    .toBe(true);
});

test("a later declarator can call an export after the require initializes", () => {
  expect(requireOrderDiagnostics(`
exports.read = read;
const dep = require('./dep.cjs'), after = read();
function read() { return dep.value; }
`)).toEqual([]);
});

test("function publication does not admit CommonJS cycles", () => {
  const diagnostics = requireOrderDiagnostics(`
exports.read = read;
const dep = require('./dep.cjs');
function read() { return dep.value; }
`, "const main = require('./main.cjs'); exports.value = main.read();\n");
  expect(diagnostics.some((diag) => diag.code === "SC1016")).toBe(true);
});

test.for([
  ['export function read() { return first + alias; }', null],
  ['export { first, alias }; export function read() { return 1; }', null],
  ['type Value = typeof alias; export function read(first: number = 1) { return first; }', null],
  ['class Box { value = alias; } export function read(value = first) { return value; }', null],
  ['const value = alias; export function read() { return value; }', "alias"],
  ['class Box { static value = first; } export function read() { return 1; }', "first"],
  ['class Box { [alias] = 1; } export function read() { return 1; }', "alias"],
])("cycle binding indexes preserve initialization safety: %s", ([body, refused]) => {
  const directory = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-cycle-bindings-"));
  const entry = join(directory, "main.ts");
  writeFileSync(entry, 'import { read } from "./peer.ts"; export const first = 1; export const second = 2; export function run() { return read(); }');
  writeFileSync(join(directory, "peer.ts"), 'import { first, second as alias } from "./main.ts";\n' + body);
  const load = loadProgram(entry);
  try {
    const cycles = checkPreflight(load).filter((diagnostic) => diagnostic.code === "SC1016");
    if (refused === null) expect(cycles).toEqual([]);
    else {
      expect(cycles).toHaveLength(1);
      expect(cycles[0]!.message).toContain(`binding '${refused}' is read`);
    }
  } finally {
    load.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("repeated cycle edges reuse a file's binding index", () => {
  const directory = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-cycle-index-"));
  const entry = join(directory, "main.ts");
  writeFileSync(entry, 'import { read } from "./peer.ts"; export const first = 1; export const second = 2; export function run() { return read(); }');
  writeFileSync(join(directory, "peer.ts"), 'import { first } from "./main.ts"; import { second } from "./main.ts"; export function read() { return first + second; }');
  const load = loadProgram(entry);
  try {
    const main = load.entry;
    const peer = load.program.getSourceFile(join(directory, "peer.ts"))!;
    const mainImports = main.statements.filter(ts.isImportDeclaration);
    const peerImports = peer.statements.filter(ts.isImportDeclaration);
    const edges = new Map<ts.SourceFile, CycleEdge[]>([
      [main, mainImports.map((stmt) => ({ dep: peer, stmt }))],
      [peer, peerImports.map((stmt) => ({ dep: main, stmt }))],
    ]);
    const admit = makeCycleAdmission(load.program, (file) => edges.get(file) ?? []);
    expect(admit(peer, edges.get(peer)![0]!)).toBeNull();
    // The first edge may materialize/check the file. A later binding must
    // inspect its indexed references without another full-file walk.
    const walk = vi.spyOn(peer, "forEachChild");
    try {
      expect(admit(peer, edges.get(peer)![1]!)).toBeNull();
      expect(walk).not.toHaveBeenCalled();
    } finally { walk.mockRestore(); }
  } finally {
    load.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
