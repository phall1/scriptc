import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

test("unmapped JavaScript string indexes lower instead of fencing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-string-index-"));
  const cases = [
    "/Users/phall/workspace/effect-scriptc-compat/cases/documented-schemaissue.ts",
    "/Users/phall/workspace/effect-scriptc-compat/cases/namespace-net.ts",
    "/Users/phall/workspace/effect-scriptc-compat/cases/namespace-encoding-base64.ts",
    "/Users/phall/workspace/effect-scriptc-compat/cases/namespace-encoding-base64url.ts",
  ];
  try {
    for (const entry of cases) {
      const outPath = join(directory, "program.ir");
      const result = await compile(entry, {
        outDir: directory,
        outPath,
        outputKind: "ir",
        npmStatic: ["effect"],
      });
      expect(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics)).toBe(true);
      const ir = readFileSync(outPath, "utf8");
      expect(ir.includes("string indexing with this index/result shape")).toBe(false);
      expect(ir.includes("element access on non-array values")).toBe(false);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
