import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// Base64.decode's `stripped[length - 1]` shape: the checker type of the
// index does not map, and the receiver lowers to a string. That read is a
// character, not an element-access fence.
const probe = `
export function last(text) {
  const length = text.length;
  return text[length - 1];
}
export function at(text, index) {
  return text[index];
}
`;

const program = `
import { at, last } from "string-index-fixture/probe.js";

const text = "abcd";
console.log(last(text));
console.log(at(text, 0));
console.log(at(text, text.length));
`;

test("unmapped JavaScript string indexes lower instead of fencing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-string-index-"));
  const pkg = join(directory, "node_modules", "string-index-fixture");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "string-index-fixture", version: "0.0.0", type: "module" }),
  );
  writeFileSync(join(pkg, "probe.js"), probe);
  const entry = join(directory, "main.ts");
  const outPath = join(directory, "program.ir");
  writeFileSync(entry, program);
  try {
    const result = await compile(entry, {
      outDir: directory,
      outPath,
      outputKind: "ir",
      npmStatic: ["string-index-fixture"],
    });
    expect(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const ir = readFileSync(outPath, "utf8");
    expect(ir.includes("string indexing with this index/result shape")).toBe(false);
    expect(ir.includes("element access on non-array values")).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
