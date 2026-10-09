import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function compileIr(source: string): Promise<unknown> {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-num-tostring-"));
  const entry = join(directory, "main.ts");
  writeFileSync(entry, source);
  try {
    const result = await compile(entry, {
      outDir: directory,
      outPath: join(directory, "program.ir"),
      outputKind: "ir",
    });
    expect(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics)).toBe(true);
    return JSON.parse(readFileSync(join(directory, "program.ir"), "utf8"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function collect(root: unknown, kind: string): Array<Record<string, unknown>> {
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

test("number toString formats the receiver, including an explicit radix", async () => {
  const ir = await compileIr(`
const n = 79;
console.log((79).toString(16));
console.log(n.toString(16));
console.log(n.toString());
console.log(String(n));
`);
  const radixCalls = collect(ir, "libCall").filter((call) => call["fn"] === "num.toStringRadix");
  expect(radixCalls).toHaveLength(2);
  const receivers = radixCalls.map((call) => (call["args"] as Array<Record<string, unknown>>)[0]);
  expect(receivers.map((receiver) => receiver?.["kind"])).toEqual(["numLit", "varRef"]);
  expect(receivers[0]?.["value"]).toBe(79);

  const decimal = collect(ir, "toString");
  expect(decimal.length).toBeGreaterThan(0);
  for (const conversion of decimal) {
    const operand = conversion["operand"] as Record<string, unknown>;
    expect(operand["kind"]).not.toBe("numLit");
  }
});
