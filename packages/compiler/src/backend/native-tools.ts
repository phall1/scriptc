/** Native tool invocation without a JavaScript host or shell command construction. */
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import type { NativeHelperSpec, NativeTargetSpec } from "./targets.js";
import { validateNativeCodegenVersion } from "./native-codegen-core.js";

export function runNativeTool(executable: string, args: string[]): string {
  const result = spawnSync(executable, args, { encoding: "utf8" });
  if (result.error) throw new Error(`${executable}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${executable} failed (${result.signal ?? String(result.status)}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

export function requireNativeArtifact(path: string): void {
  const info = statSync(path);
  if (!info.isFile() || info.size === 0) throw new Error(`native tool produced no artifact: ${path}`);
}

export function emitNativeObject(options: {
  executable: string;
  packageRoot: string;
  compilerVersion: string;
  target: NativeTargetSpec;
  helper: NativeHelperSpec;
  inputPath: string;
  outputPath: string;
  sourcePath: string;
  optimization: "release" | "dev";
}): void {
  const identity = JSON.parse(readFileSync(options.packageRoot + "/package.json", "utf8")) as { name: string; version: string };
  if (identity.name !== options.helper.packageName || identity.version !== options.compilerVersion) {
    throw new Error(`LLVM helper package mismatch: expected ${options.helper.packageName}@${options.compilerVersion}`);
  }
  const version = JSON.parse(runNativeTool(options.executable, ["version", "--format=json"])) as Record<string, unknown>;
  validateNativeCodegenVersion(version, options.target, options.helper, options.compilerVersion);
  runNativeTool(options.executable, [
    "emit", "--input", options.inputPath, "--output", options.outputPath, "--filetype", "obj",
    "--target", options.target.llvmTriple, "--opt-level", options.optimization === "dev" ? "0" : "2",
    "--relocation-model", options.target.relocationModel, "--diagnostic-format", "json",
    "--source-path", options.sourcePath,
  ]);
  requireNativeArtifact(options.outputPath);
}
