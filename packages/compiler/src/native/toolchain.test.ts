import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadNativeToolchain, type NativeToolchainManifest } from "./toolchain.js";

test("native toolchain installation paths relocate with the manifest", () => {
  const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-native-tools-"));
  const path = join(root, "toolchain.json");
  const manifest: NativeToolchainManifest = {
    schema: "scriptc.native-toolchain.v1", compiler_version: "1.2.3", target: "macos-arm64",
    ts7: "typescript/tsc", llvm_package: "llvm", runtime_pack: "runtime",
    linker: "tools/linker", linker_args: ["cc"], dsymutil: "dsymutil",
  };
  try {
    writeFileSync(path, JSON.stringify(manifest));
    const toolchain = loadNativeToolchain(path);
    expect(toolchain.ts7Executable).toBe(join(root, "typescript/tsc"));
    expect(toolchain.helperExecutable).toBe(join(root, "llvm/bin/scriptc-llvm-codegen"));
    expect(toolchain.runtimePackRoot).toBe(join(root, "runtime"));
    expect(toolchain.linker).toBe(join(root, "tools/linker"));
    expect(toolchain.linkerArgs).toEqual(["cc"]);
    expect(toolchain.target.name).toBe("macos-arm64");
    for (const invalid of [null, [], {}, { ...manifest, schema: "other" }, { ...manifest, target: "other" },
      { ...manifest, ts7: "" }, { ...manifest, linker_args: [1] }]) {
      writeFileSync(path, JSON.stringify(invalid));
      expect(() => loadNativeToolchain(path)).toThrow();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cross-target packs can be added to a project after the compiler is installed", () => {
  const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-project-pack-"));
  const installation = join(root, "compiler", "bin");
  const project = join(root, "project");
  const nested = join(project, "src", "nested");
  const pack = join(project, "node_modules/@scriptc/runtime-wasm32-wasi");
  mkdirSync(installation, { recursive: true });
  mkdirSync(nested, { recursive: true });
  const path = join(installation, "scriptc.json");
  const manifest: NativeToolchainManifest = {
    schema: "scriptc.native-toolchain.v1", compiler_version: "1.2.3", target: "macos-arm64",
    ts7: "../lib/typescript/tsc", llvm_package: "../lib/llvm", runtime_pack: "../lib/runtime-darwin-arm64",
    linker: "clang", linker_args: [], dsymutil: "dsymutil",
  };
  writeFileSync(path, JSON.stringify(manifest));
  const env = { SCRIPTC_TARGET: "wasm32-wasi" };
  try {
    // Object emission does not require a pack to be installed.
    expect(loadNativeToolchain(path, env, nested).target.name).toBe("wasm32-wasi");
    mkdirSync(pack, { recursive: true });
    writeFileSync(join(pack, "package.json"), JSON.stringify({ name: "@scriptc/runtime-wasm32-wasi", version: "1.2.3" }));
    expect(loadNativeToolchain(path, env, nested).runtimePackRoot).toBe(pack);
    expect(loadNativeToolchain(path, { ...env, SCRIPTC_RUNTIME_PACK: "../explicit" }, nested).runtimePackRoot)
      .toBe(join(root, "compiler", "explicit"));
    expect(loadNativeToolchain(path, {}, nested).runtimePackRoot).toBe(join(root, "compiler", "lib/runtime-darwin-arm64"));
    const registered = join(root, "registered");
    mkdirSync(registered);
    writeFileSync(path, JSON.stringify({ ...manifest, runtime_packs: [{ target: "wasm32-wasi", path: registered }] }));
    expect(loadNativeToolchain(path, env, nested).runtimePackRoot).toBe(registered);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("versioned GNU targets select Zig while ordinary host builds keep the installed linker", () => {
  const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-gnu-linker-"));
  const path = join(root, "scriptc.json");
  writeFileSync(path, JSON.stringify({
    schema: "scriptc.native-toolchain.v1", compiler_version: "1.2.3", target: "linux-x64-gnu",
    ts7: "tsc", llvm_package: "llvm", runtime_pack: "runtime", linker: "clang", linker_args: [], dsymutil: "dsymutil",
  }));
  try {
    expect(loadNativeToolchain(path).linker).toBe("clang");
    expect(loadNativeToolchain(path, { SCRIPTC_TARGET: "x86_64-linux-gnu.2.34" })).toMatchObject({
      linker: "zig", linkerArgs: ["cc"], target: { linkerTargetTriple: "x86_64-linux-gnu.2.34" },
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
