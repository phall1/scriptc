import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadNativeToolchain, type NativeToolchainManifest } from "./toolchain.js";

test("native toolchain installation paths relocate with the manifest", () => {
  const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-native-tools-"));
  const path = join(root, "toolchain.json");
  const manifest: NativeToolchainManifest = {
    schema: "scriptc.native-toolchain.v1", compiler_version: "1.2.3", target: "macos-arm64",
    ts7: "typescript/tsc", llvm_package: "llvm", runtime_pack: "runtime", runtime_headers: "headers",
    c_compiler: "clang", c_compiler_args: [], linker: "tools/linker", linker_args: ["cc"], dsymutil: "dsymutil",
  };
  try {
    writeFileSync(path, JSON.stringify(manifest));
    const toolchain = loadNativeToolchain(path);
    expect(toolchain.ts7Executable).toBe(join(root, "typescript/tsc"));
    expect(toolchain.helperExecutable).toBe(join(root, "llvm/bin/scriptc-llvm-codegen"));
    expect(toolchain.runtimePackRoot).toBe(join(root, "runtime"));
    expect(toolchain.linker).toBe(join(root, "tools/linker"));
    expect(toolchain.cCompiler).toBe("clang");
    expect(toolchain.linkerArgs).toEqual(["cc"]);
    expect(toolchain.target.name).toBe("macos-arm64");
    for (const invalid of [null, [], {}, { ...manifest, schema: "other" }, { ...manifest, target: "other" },
      { ...manifest, ts7: "" }, { ...manifest, linker_args: [1] }]) {
      writeFileSync(path, JSON.stringify(invalid));
      expect(() => loadNativeToolchain(path)).toThrow();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
