import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

test("numeric byte pipelines retain checked fallbacks and use field widths on both pointer sizes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-byte-numbers-"));
  try {
    const entry = join(import.meta.dirname, "../../../tests/corpus/byte-number-pipeline.ts");
    const outPath = join(dir, "main.ir.json");
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    const body = (ll: string, name: string): string => ll.match(new RegExp(`define internal [^\\n]+ @sc_(?:b)?f_${name}\\([^\\n]*\\) #0 \\{([\\s\\S]*?)\\n\\}`))![1]!;
    for (const pointerBits of [32, 64] as const) {
      const ll = emitLlvmModule(mod, { pointerBits, wasi: pointerBits === 32 });
      for (const name of ["bufferRecords", "viewRecords", "backwards"]) {
        const code = body(ll, name);
        expect(code).toContain("integer induction offset");
        expect(code).not.toContain("counted.slow");
        expect(code).not.toContain("@scr_bytes_retain");
        expect(code).toMatch(/load i32, ptr %\w+, align 1/);
        expect(code).toMatch(/store i32 %\w+, ptr %\w+, align 1/);
        expect(code).toContain("phi i32");
      }
      // All fields lie inside the extent established by these loop heads.
      for (const name of ["bufferRecords", "viewRecords"]) {
        expect(body(ll, name)).not.toContain("bytes.number.index");
        expect(body(ll, name)).not.toMatch(/icmp uge i(?:32|64)/);
      }
      for (const name of ["shortTarget", "replacedBound"]) expect(body(ll, name)).toMatch(/icmp uge i(?:32|64)/);
      const wide = body(ll, "wideFields");
      expect(wide).toMatch(/load i40, ptr %\w+, align 1/);
      expect(wide).toMatch(/load i48, ptr %\w+, align 1/);
      expect(wide).toContain("phi i64");
      expect(wide).toContain("@llvm.bswap.i64");
      const offsets = body(ll, "offsets");
      expect(offsets).toContain("@llvm.trunc.f64");
      expect(offsets).toContain("@scr_dataview_set");
      expect(offsets).toContain("@scr_dataview_get");
      expect(offsets).toMatch(/icmp ule i(?:32|64)/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
