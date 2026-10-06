import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

// Native arrays cannot store a changed prototype. Pin the explicit refusal,
// not a successful but incorrect answer from the materialized checked view.
const cases = [
  ["direct", "Object.setPrototypeOf(values, null);"],
  ["alias", "const alias = values; Object.setPrototypeOf(alias, null);"],
  ["custom", "Object.setPrototypeOf(values, { inherited: true });"],
  [
    "optional",
    "const optional: number[] | undefined = values; if (optional) Object.setPrototypeOf(optional, null);",
  ],
] as const;

test.each(cases)("native array prototype mutation refuses %s", async (_name, mutation) => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-array-prototype-"));
  try {
    const entry = join(directory, "main.ts");
    writeFileSync(entry, `const values: number[] = [1];\n${mutation}\nconsole.log("continued");\n`);
    const node = spawnSync(process.execPath, [entry], { encoding: "utf8" });
    expect(node.status).toBe(0);
    expect(node.stderr).toBe("");
    expect(node.stdout).toBe("continued\n");
    const result = await compile(entry, {
      backend: "llvm",
      outDir: directory,
      outPath: join(directory, "program"),
      sanitize: process.env["SCRIPTC_SAN"] === "1",
    });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const native = spawnSync(result.binaryPath, [], { encoding: "utf8", timeout: 30_000 });
    expect(native.error).toBeUndefined();
    expect(native.signal).toBeNull();
    expect(native.status).not.toBe(0);
    expect(native.stdout).toBe("");
    expect(native.stderr).toContain("SC1090");
    expect(native.stderr).toContain("Native array prototype mutation has no lowering");
    expect(native.stderr).not.toMatch(/ERROR: AddressSanitizer|runtime error:/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
