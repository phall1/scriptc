import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

interface IrFunction {
  name: string;
  body: unknown;
}

async function compileIr(source: string): Promise<{ functions: IrFunction[] }> {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-expanded-record-"));
  const entry = join(directory, "main.js");
  writeFileSync(entry, source);
  try {
    const result = await compile(entry, {
      outDir: directory,
      outPath: join(directory, "program.ir"),
      outputKind: "ir",
    });
    expect(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics)).toBe(true);
    return JSON.parse(readFileSync(join(directory, "program.ir"), "utf8")) as {
      functions: IrFunction[];
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function kinds(root: unknown, kind: string): number {
  let count = 0;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record["kind"] === kind) count += 1;
    for (const value of Object.values(record)) walk(value);
  };
  walk(root);
  return count;
}

function collects(root: unknown, kind: string): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record["kind"] === kind) found.push(record);
    for (const value of Object.values(record)) walk(value);
  };
  walk(root);
  return found;
}

function storesOpenBinding(body: unknown): boolean {
  return collects(body, "dynArrLit").some((array) => {
    const elems = array["elems"];
    return (
      Array.isArray(elems) &&
      elems.some((elem) => {
        const record = elem as Record<string, unknown>;
        const type = record["type"] as Record<string, unknown> | undefined;
        return record["kind"] === "varRef" && type?.["kind"] === "dyn";
      })
    );
  });
}

test("a JavaScript array keeps a record binding that gained a key after its literal", async () => {
  const ir = await compileIr(`
function closed() {
  const point = { a: 1, b: "x" };
  return { items: [point] };
}
function opened() {
  const dataPoint = { attributes: [], startTimeUnixNano: "0", timeUnixNano: "0" };
  dataPoint.asDouble = 2;
  return { sum: { dataPoints: [dataPoint] } };
}
function parenthesized() {
  const dataPoint = { attributes: [], startTimeUnixNano: "0", timeUnixNano: "0" };
  dataPoint.asInt = "2";
  return { sum: { dataPoints: [(dataPoint)] } };
}
console.log(closed(), opened(), parenthesized());
`);
  const closed = ir.functions.find((fn) => fn.name === "closed");
  const opened = ir.functions.find((fn) => fn.name === "opened");
  const parenthesized = ir.functions.find((fn) => fn.name === "parenthesized");
  expect(closed, ir.functions.map((fn) => fn.name).join(",")).toBeDefined();
  expect(opened).toBeDefined();
  expect(parenthesized).toBeDefined();
  expect(kinds(closed!.body, "arrayLit")).toBeGreaterThan(0);
  expect(kinds(closed!.body, "dynArrLit")).toBe(0);
  expect(storesOpenBinding(opened!.body)).toBe(true);
  expect(kinds(opened!.body, "dynCheck")).toBe(0);
  expect(storesOpenBinding(parenthesized!.body)).toBe(true);
  expect(kinds(parenthesized!.body, "dynCheck")).toBe(0);
});
