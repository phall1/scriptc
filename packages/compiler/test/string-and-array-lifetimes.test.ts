import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, serializeModule, validateModule } from "../src/index.js";
import { analyzeCallLifetimes } from "../src/backend/llvm/call-lifetimes.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import { type IrModule } from "../src/ir/ir.js";

async function lower(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-input-lifetimes-"));
  try {
    const entry = join(dir, "main.ts"), output = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath: output, outputKind: "ir", dynamic: false });
    if (!result.ok) throw new Error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
    const module = deserializeModule(await readFile(output, "utf8"));
    expect(validateModule(module)).toEqual([]);
    return module;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
function body(llvm: string, symbol: string): string {
  const found = new RegExp(`^define internal [^\\n]*@${symbol}\\([^]*?^}`, "m").exec(llvm);
  expect(found, symbol).not.toBeNull();
  return found![0];
}

test("source string helpers preserve borrowing after the serialized IR boundary", async () => {
  const module = await lower(`
function score(text: string, prefix: string): number {
  return text.startsWith(prefix) ? text.length + text.charCodeAt(0) : 0;
}
function relay(text: string, prefix: string): number { return score(text, prefix); }
console.log(relay("ready", "re"));
`);
  const facts = analyzeCallLifetimes(new Map(module.functions.map((fn) => [fn.name, fn])));
  expect(facts.parameters.get("score")).toEqual(new Set([0, 1]));
  expect(facts.parameters.get("relay")).toEqual(new Set([0, 1]));
  const llvm = emitLlvmModule(module);
  expect(body(llvm, "sc_bf_score")).toContain("@scr_str_starts_with");
  expect(body(llvm, "sc_bf_score")).not.toContain("@scr_str_retain_v");
  expect(body(llvm, "sc_bf_relay")).not.toContain("@scr_str_retain_v");
  expect(body(llvm, "sc_f_score").match(/@scr_str_release/g)).toHaveLength(2);
  expect(emitLlvmModule(deserializeModule(serializeModule(module)))).toBe(llvm);
});

test("direct source array arguments use stack tags without changing the helper ABI", async () => {
  const module = await lower(`
class Item { value: number; constructor(value: number) { this.value = value; } }
function value(item: Item): number { return item.value; }
function work(items: Item[], index: number): number { return value(items[index]); }
console.log(work([new Item(7)], 0));
`);
  const value = module.functions.find((fn) => fn.name === "value")!;
  expect(value.params[0]!.type.kind).toBe("union");
  const llvm = emitLlvmModule(module);
  const work = body(llvm, "sc_f_work");
  expect(work).toContain("alloca %ScrUnion");
  expect(work).toContain("@sc_bf_value");
  expect(work).not.toContain("@scr_union_new_ref");
  expect(work).not.toContain("@scr_union_release");
  expect(work).not.toContain("@sc_retain_Item");
  expect(body(llvm, "sc_f_value")).toContain("@scr_union_release");
});

test("a source array mutation during later argument evaluation retains the earlier payload", async () => {
  const module = await lower(`
class Item { value: number; constructor(value: number) { this.value = value; } }
function value(item: Item, ignored: number): number { return item.value + ignored; }
function clear(items: Item[]): number { items.length = 0; return 1; }
function work(items: Item[]): number { return value(items[0], clear(items)); }
console.log(work([new Item(7)]));
`);
  const llvm = emitLlvmModule(module);
  const work = body(llvm, "sc_f_work");
  expect(work).toContain("alloca %ScrUnion");
  expect(work).toContain("@sc_retain_Item");
  expect(work).toContain("@sc_release_Item");
  expect(work.indexOf("@sc_retain_Item")).toBeLessThan(work.indexOf("@sc_f_clear"));
  expect(work).not.toContain("@scr_union_release");
});

test("source helpers that return their input retain a heap representation", async () => {
  const module = await lower(`
class Item { value = 7; }
function identity(item: Item): Item { return item; }
function work(items: Item[]): Item { return identity(items[0]); }
console.log(work([new Item()]).value);
`);
  const facts = analyzeCallLifetimes(new Map(module.functions.map((fn) => [fn.name, fn])));
  expect(facts.parameters.has("identity")).toBe(false);
  expect(body(emitLlvmModule(module), "sc_f_work")).not.toContain("alloca %ScrUnion");
});

test("a helper's string projection retains an escaping result independently of the array", async () => {
  const module = await lower(`
class Item { label: string; constructor(label: string) { this.label = label; } }
function label(item: Item): string { return item.label; }
function work(items: Item[]): string { return label(items[0]); }
console.log(work([new Item("kept")]));
`);
  const llvm = emitLlvmModule(module);
  expect(body(llvm, "sc_f_work")).toContain("alloca %ScrUnion");
  expect(body(llvm, "sc_bf_label")).toContain("@scr_str_retain_v");
  expect(body(llvm, "sc_bf_label")).not.toContain("@scr_union_retain_v");
});

test("source-level helper aliases retain their owned adapter", async () => {
  const module = await lower(`
function size(value: string): number { return value.length; }
function invoke(callback: (value: string) => number, value: string): number { return callback(value); }
console.log(invoke(size, "indirect"));
`);
  const llvm = emitLlvmModule(module);
  expect(body(llvm, "sc_bf_size")).not.toContain("@scr_str_release");
  expect(body(llvm, "sc_f_size")).toContain("@scr_str_release");
  expect(body(llvm, "sc_f_invoke")).toContain("@scr_str_retain_v");
});

test("many source call sites share one helper recognition without sharing stack storage", async () => {
  const module = await lower(`
class Item { value = 7; }
function pair(left: Item, right: Item): number { return left.value + right.value; }
function work(items: Item[]): number { return pair(items[0], items[1]) + pair(items[1], items[0]); }
console.log(work([new Item(), new Item()]));
`);
  const work = body(emitLlvmModule(module), "sc_f_work");
  expect(work.match(/alloca %ScrUnion/g)).toHaveLength(4);
  expect(work.match(/@sc_bf_pair/g)).toHaveLength(2);
  expect(work).not.toContain("@scr_union_new_ref");
  expect(work).not.toContain("@scr_union_release");
});

test("a throwing later source argument releases the retained snapshot on its exception edge", async () => {
  const module = await lower(`
class Item { value = 7; }
function read(item: Item, ignored: number): number { return item.value + ignored; }
function fail(): number { throw new Error("failed"); }
function work(items: Item[]): number { return read(items[0], fail()); }
try { console.log(work([new Item()])); } catch {}
`);
  const work = body(emitLlvmModule(module), "sc_f_work");
  const failure = work.indexOf("@sc_f_fail");
  expect(failure).toBeGreaterThan(0);
  expect(work.slice(failure)).toContain("@scr_exc_pending");
  expect(work.slice(failure)).toContain("@sc_release_Item");
  expect(work).not.toContain("@scr_union_release");
});

test("pure string helpers preserve the array owner of an immediate optional string", async () => {
  const module = await lower(`
function size(text: string): number { return text.length + text.charCodeAt(0); }
function work(words: string[], index: number): number { return size(words[index]); }
console.log(work(["first"], 0));
`);
  const work = body(emitLlvmModule(module), "sc_f_work");
  expect(work).toContain("alloca %ScrUnion");
  expect(work).toContain("@sc_bf_size");
  expect(work).not.toContain("@scr_str_retain_v");
  expect(work).not.toContain("@scr_str_release");
  expect(work).not.toContain("@scr_union_release");
});

test("string-producing helpers return an owner while borrowing their array input", async () => {
  const module = await lower(`
function trim(text: string): string { return text.trim(); }
function work(words: string[]): string { return trim(words[0]); }
console.log(work([" first "]));
`);
  const llvm = emitLlvmModule(module);
  const work = body(llvm, "sc_f_work");
  expect(work).toContain("alloca %ScrUnion");
  expect(work).not.toContain("@scr_str_retain_v");
  expect(body(llvm, "sc_bf_trim")).toContain("@scr_str_trim");
  expect(body(llvm, "sc_f_trim")).toContain("@scr_union_release");
});

test("string method arguments that mutate an array keep the earlier optional payload owned", async () => {
  const module = await lower(`
function prefix(text: string, start: string): boolean { return text.startsWith(start); }
function clear(words: string[]): string { words.length = 0; return "f"; }
function work(words: string[]): boolean { return prefix(words[0], clear(words)); }
console.log(work(["first"]));
`);
  const work = body(emitLlvmModule(module), "sc_f_work");
  expect(work).toContain("alloca %ScrUnion");
  expect(work).toContain("@scr_str_retain_v");
  expect(work).toContain("@scr_str_release");
  expect(work).not.toContain("@scr_union_release");
});

test("whole-union string comparisons keep their established owned representation", async () => {
  const module = await lower(`
function size(text: string): number { return text.length + (text === "" ? 1 : 0); }
function work(words: string[], index: number): number { return size(words[index]); }
console.log(work([""], 0));
`);
  const facts = analyzeCallLifetimes(new Map(module.functions.map((fn) => [fn.name, fn])));
  expect(facts.parameters.has("size")).toBe(false);
  const work = body(emitLlvmModule(module), "sc_f_work");
  expect(work).not.toContain("alloca %ScrUnion");
  expect(work).toContain("@sc_f_size");
});
