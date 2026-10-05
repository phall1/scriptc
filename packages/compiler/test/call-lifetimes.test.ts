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
    const entry = join(dir, "main.ts"),
      outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir", dynamic: false });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
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
  const work = body(llvm, "sc_bf_work");
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
  expect(body(emitLlvmModule(mod), "sc_bf_work")).not.toContain("alloca %ScrUnion");
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
  const first = fn(mod, "%First.read"),
    second = fn(mod, "%Second.read");
  expect(first.params[1]!.type.kind).toBe("union");
  expect(second.params[1]!.type).toEqual(first.params[1]!.type);
  expect(first.params[2]!.type.kind).toBe("object");
  expect(second.params[2]!.type).toEqual(first.params[2]!.type);
});

test("heap borrowing preserves owned returns and independently retained stored values", async () => {
  const mod = await lower(`
class Item { value = 13; }
function keep(item: Item, items: Item[]): Item { items.push(item); return item; }
function relay(item: Item, items: Item[]): Item { return keep(item, items); }
function work(): number { let item = new Item(); let items: Item[] = []; const result = relay(item, items); return result.value + items.length; }
console.log(work());
`);
  const facts = analyzeCallLifetimes(new Map(mod.functions.map((item) => [item.name, item])));
  expect(facts.borrowed.get("keep")).toEqual(new Set([0, 1]));
  expect(facts.borrowed.get("relay")).toEqual(new Set([0, 1]));
  expect(facts.parameters.has("keep")).toBe(false);
  const llvm = emitLlvmModule(mod);
  const keep = body(llvm, "sc_bf_keep");
  expect(keep.match(/@sc_retain_Item/g)).toHaveLength(2);
  expect(keep).not.toContain("@scr_arr_retain_v");
  expect(keep).not.toContain("@scr_arr_release");
  const relay = body(llvm, "sc_bf_relay");
  expect(relay).toContain("@sc_bf_keep");
  expect(relay).not.toContain("@sc_retain_Item");
  expect(relay).not.toContain("@scr_arr_retain_v");
  const owned = body(llvm, "sc_f_keep");
  expect(owned).toContain("@sc_release_Item");
  expect(owned).toContain("@scr_arr_release");
});

test("stable collection operands borrow roots while insertion still transfers payload owners", async () => {
  const mod = await lower(`
class Item { value = 3; }
function work(items: Item[], map: Map<string, Item>, keys: Set<string>, bytes: Uint8Array, item: Item, key: string): number {
  items.push(item);
  items[0] = item;
  map.set(key, item);
  keys.add(key);
  bytes.fill(7);
  const copied = bytes.subarray(0, 1);
  return items.length + map.size + keys.size + copied[0];
}
console.log(work([], new Map<string, Item>(), new Set<string>(), new Uint8Array(2), new Item(), "one"));
`);
  for (const pointerBits of [32, 64] as const) {
    const ir = body(emitLlvmModule(mod, { pointerBits }), "sc_bf_work");
    expect(ir).not.toMatch(/@scr_(arr|map|bytes|str)_retain_v/);
    expect(ir.match(/@sc_retain_Item/g)).toHaveLength(3);
    expect(ir).toContain("@scr_bytes_subarray");
    expect(ir).toContain("@scr_bytes_release");
  }
});

test("lexical aliases borrow stable owners while returned aliases retain independently", async () => {
  const mod = await lower(`
class Item { value = 5; }
function alias(item: Item): Item { const first = item; const second = first; return second; }
function snapshot(item: Item): Item { const saved = item; item = new Item(); return saved; }
console.log(alias(new Item()).value, snapshot(new Item()).value);
`);
  const llvm = emitLlvmModule(mod);
  const alias = body(llvm, "sc_bf_alias");
  expect(alias.match(/@sc_retain_Item/g)).toHaveLength(1);
  expect(alias).not.toContain("@sc_release_Item");
  const snapshot = body(llvm, "sc_f_snapshot");
  expect(snapshot.match(/@sc_retain_Item/g)).toHaveLength(3);
  expect(snapshot).toContain("@sc_release_Item");
});
