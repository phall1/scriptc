import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import { analyzeCallLifetimes } from "../src/backend/llvm/call-lifetimes.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import { type IrModule, type IrFunction } from "../src/ir/ir.js";

async function lower(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-call-lifetimes-"));
  try {
    const entry = join(dir, "main.ts"), outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir", dynamic: false });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    return mod;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fn(mod: IrModule, name: string): IrFunction {
  const found = mod.functions.find((item) => item.name === name);
  expect(found, name).toBeDefined();
  return found!;
}

function body(llvm: string, symbol: string): string {
  const found = new RegExp(`^define internal [^\\n]*@${symbol}\\([^]*?^}`, "m").exec(llvm);
  expect(found, symbol).not.toBeNull();
  return found![0];
}

test("ordinary source helper parameters admit local array boxes after serialization", async () => {
  const mod = await lower(`
class Item { value: number; constructor(value: number) { this.value = value; } }
function read(item: Item): number { return item.value; }
function relay(item: Item): number { return read(item); }
function work(items: Item[]): number {
  const item = items[0];
  return relay(item);
}
console.log(work([new Item(7)]));
`);
  const reader = fn(mod, "read");
  expect(reader.params[0]!.type.kind).toBe("union");
  expect(reader.locals.find((local) => local.id === reader.params[0]!.localId)?.mutable).toBe(true);
  const facts = analyzeCallLifetimes(new Map(mod.functions.map((item) => [item.name, item])));
  expect(facts.parameters.get("read")).toEqual(new Set([0]));
  expect(facts.parameters.get("relay")).toEqual(new Set([0]));
  const llvm = emitLlvmModule(mod);
  const work = body(llvm, "sc_f_work");
  expect(work).toContain("alloca %ScrUnion");
  expect(work).toContain("@sc_bf_relay");
  expect(work).not.toContain("@scr_union_release");
  expect(body(llvm, "sc_bf_relay")).not.toContain("@scr_union_retain");
});

test("source assignments prevent borrowed parameter lowering", async () => {
  const mod = await lower(`
class Item { value: number; constructor(value: number) { this.value = value; } }
function read(item: Item): number {
  item = new Item(9);
  return item.value;
}
function work(items: Item[]): number { const item = items[0]; return read(item); }
console.log(work([new Item(7)]));
`);
  const facts = analyzeCallLifetimes(new Map(mod.functions.map((item) => [item.name, item])));
  expect(facts.parameters.has("read")).toBe(false);
  expect(body(emitLlvmModule(mod), "sc_f_work")).not.toContain("alloca %ScrUnion");
});

test("virtual families share promoted parameter representations without affecting unrelated methods", async () => {
  const mod = await lower(`
class Item { value = 7; }
class Base { read(item: Item): number { return item.value; } }
class Child extends Base { read(item: Item): number { return item.value + 1; } }
class Grandchild extends Child { read(item: Item): number { return item.value + 2; } }
class Other { read(item: Item): number { return item.value + 3; } }
function invoke(reader: Base, items: Item[]): number { const item = items[0]; return reader.read(item); }
console.log(invoke(new Base(), [new Item()]), invoke(new Child(), [new Item()]));
console.log(invoke(new Grandchild(), [new Item()]), new Other().read(new Item()));
`);
  const base = fn(mod, "%Base.read").params[1]!.type;
  expect(base.kind).toBe("union");
  expect(fn(mod, "%Child.read").params[1]!.type).toEqual(base);
  expect(fn(mod, "%Grandchild.read").params[1]!.type).toEqual(base);
  expect(fn(mod, "%Other.read").params[1]!.type.kind).toBe("object");
});

test("promotion reaches downstream helpers and returned values in every override", async () => {
  const mod = await lower(`
class Item { value = 11; }
function first(item: Item): Item { return item; }
function second(item: Item): Item { return item; }
class Base { keep(item: Item): Item { return first(item); } }
class Child extends Base { keep(item: Item): Item { return second(item); } }
function invoke(reader: Base, items: Item[]): Item { const item = items[0]; return reader.keep(item); }
console.log(invoke(new Base(), [new Item()]).value, invoke(new Child(), [new Item()]).value);
`);
  const base = fn(mod, "%Base.keep");
  const child = fn(mod, "%Child.keep");
  expect(base.params[1]!.type.kind).toBe("union");
  expect(child.params[1]!.type).toEqual(base.params[1]!.type);
  expect(child.returnType).toEqual(base.returnType);
  expect(fn(mod, "first").params[0]!.type).toEqual(fn(mod, "second").params[0]!.type);
  expect(fn(mod, "first").returnType).toEqual(fn(mod, "second").returnType);
});

test("promotion follows individual positions through abstract and concrete implementations", async () => {
  const mod = await lower(`
class Item { value = 13; }
abstract class Base { abstract read(left: Item, right: Item): number; }
class First extends Base { read(left: Item, right: Item): number { return left.value + right.value; } }
class Second extends Base { read(left: Item, right: Item): number { return left.value - right.value; } }
function invoke(reader: Base, items: Item[]): number { const item = items[0]; return reader.read(item, new Item()); }
console.log(invoke(new First(), [new Item()]), invoke(new Second(), [new Item()]));
`);
  const first = fn(mod, "%First.read"), second = fn(mod, "%Second.read");
  expect(first.params[1]!.type.kind).toBe("union");
  expect(second.params[1]!.type).toEqual(first.params[1]!.type);
  expect(first.params[2]!.type.kind).toBe("object");
  expect(second.params[2]!.type).toEqual(first.params[2]!.type);
});
