import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { NATIVE_TARGETS, type NativeTargetSpec } from "../backend/targets.js";
import type { NativeToolchain } from "./driver.js";

/** Distribution paths are relative to this manifest, so moving an installed
 * compiler does not bake the seed machine's paths into the native binary. */
export interface NativeToolchainManifest {
  schema: "scriptc.native-toolchain.v1";
  compiler_version: string;
  target: string;
  ts7: string;
  llvm_package: string;
  runtime_pack: string;
  linker: string;
  linker_args: string[];
  dsymutil: string;
}

function pathFrom(root: string, value: string): string {
  return isAbsolute(value) ? value : resolve(root, value);
}

function commandFrom(root: string, value: string): string {
  return value.includes("/") || value.includes("\\") ? pathFrom(root, value) : value;
}

export function loadNativeToolchain(path: string): NativeToolchain {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid native toolchain manifest");
  const value = raw as Record<string, unknown>;
  if (value.schema !== "scriptc.native-toolchain.v1") throw new Error("unsupported native toolchain manifest schema");
  for (const name of ["compiler_version", "target", "ts7", "llvm_package", "runtime_pack", "linker", "dsymutil"]) {
    if (typeof value[name] !== "string" || value[name] === "") throw new Error(`native toolchain requires ${name}`);
  }
  for (const name of ["linker_args"]) {
    if (!Array.isArray(value[name]) || !(value[name] as unknown[]).every((arg) => typeof arg === "string")) {
      throw new Error(`native toolchain requires a string array for ${name}`);
    }
  }
  const manifest = raw as NativeToolchainManifest;
  const targets: readonly NativeTargetSpec[] = NATIVE_TARGETS;
  const target = targets.find((item) => item.name === manifest.target);
  if (target === undefined || target.platform === "wasi") throw new Error(`unsupported native compiler target: ${manifest.target}`);
  const root = dirname(resolve(path));
  const helperPackageRoot = pathFrom(root, manifest.llvm_package);
  return {
    compilerVersion: manifest.compiler_version,
    ts7Executable: pathFrom(root, manifest.ts7),
    target, helper: target.helper, helperPackageRoot,
    helperExecutable: join(helperPackageRoot, "bin", target.platform === "win32" ? "scriptc-llvm-codegen.exe" : "scriptc-llvm-codegen"),
    runtimePackRoot: pathFrom(root, manifest.runtime_pack),
    linker: commandFrom(root, manifest.linker), linkerArgs: manifest.linker_args,
    dsymutil: commandFrom(root, manifest.dsymutil),
  };
}
