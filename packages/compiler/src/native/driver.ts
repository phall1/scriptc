/** Static executable compiler. The TS7 parser/checker and native toolchain
 * are external native processes; lowering, validation and LLVM emission run
 * inside this binary. Installed paths are supplied by the distribution. */
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { emitLlvmModule } from "../backend/llvm/emitter.js";
import { executableLinkFeatures } from "../backend/executable-features.js";
import { executableLinkInputs } from "../backend/link-plan-core.js";
import { stageNativeRuntimePack } from "../backend/runtime-pack-native.js";
import { emitNativeObject, requireNativeArtifact, runNativeTool } from "../backend/native-tools.js";
import type { NativeHelperSpec, NativeTargetSpec } from "../backend/targets.js";
import { loadFfiProfile, type FfiProfile } from "../ffi/ffi-manifest.js";
import { runNativeFrontend } from "../frontend/pipeline-native.js";
import type { LowerStats } from "../frontend/lowering/lowerer.js";
import { validateModule } from "../ir/validate.js";

export interface NativeToolchain {
  compilerVersion: string;
  ts7Executable: string;
  target: NativeTargetSpec;
  helper: NativeHelperSpec;
  helperExecutable: string;
  helperPackageRoot: string;
  runtimePackRoot: string;
  linker: string;
  linkerArgs: string[];
  dsymutil: string;
}

export interface NativeBuildOptions {
  entryPath: string;
  outputPath: string;
  backend: "llvm";
  outputKind: "exe" | "obj" | "llvm";
  optimization: "release" | "dev";
  strip: boolean;
  keepLlvm?: boolean;
  ffiProfilePath?: string;
  npmStatic?: readonly string[] | "auto";
}

export interface NativeBuildResult {
  outputPath: string;
  llvmPath?: string;
  stats: LowerStats;
}

export function buildNative(options: NativeBuildOptions, toolchain: NativeToolchain): NativeBuildResult {
  const entry = resolve(options.entryPath);
  const output = resolve(options.outputPath);
  if (entry === output) throw new Error("output path must differ from the entry source");
  let ffi: FfiProfile | null = null;
  if (options.ffiProfilePath !== undefined) {
    const loaded = loadFfiProfile(options.ffiProfilePath);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.diagnostics));
    ffi = loaded.profile;
  }
  const frontend = runNativeFrontend(entry, toolchain.ts7Executable, options.npmStatic);
  try {
    if (frontend.preflight.length !== 0) throw new Error(JSON.stringify(frontend.preflight));
    const lowered = frontend.lower({ dynamic: false, targetPlatform: toolchain.target.platform, ffiImports: ffi?.functions ?? [] });
    if (lowered.module === null || lowered.stats.statementsFailed !== 0 || lowered.stats.statementsIsland !== 0 || lowered.stats.functionsSkipped !== 0) {
      throw new Error(JSON.stringify(lowered.diagnostics));
    }
    const module = lowered.module;
    const errors = validateModule(module);
    if (errors.length !== 0) throw new Error(JSON.stringify(errors));
    const features = executableLinkFeatures(module, false);
    const sourceOutput = options.outputKind === "llvm";
    const debug = options.optimization === "dev" && !options.strip;
    const debugSources = debug ? frontend.sourceTexts() : new Map<string, string>();
    const llvm = emitLlvmModule(module, {
      targetTriple: toolchain.target.llvmTriple,
      pointerBits: toolchain.target.pointerBits,
      wasi: toolchain.target.platform === "wasi",
      runtimeAbiMarker: true,
      ...(debug ? { debugSources } : {}),
    });
    const writeSource = (path: string): void => { writeFileSync(path, llvm); };
    mkdirSync(dirname(output), { recursive: true });
    // A sibling temporary directory keeps installation on the same volume
    // and preserves the basename used by Mach-O's ad-hoc signature.
    const stage = mkdtempSync(join(dirname(output), ".scriptc-native-"));
    try {
      const outputDirectory = join(stage, "output");
      const inputDirectory = join(stage, "input");
      mkdirSync(outputDirectory);
      mkdirSync(inputDirectory);
      const stagedOutput = join(outputDirectory, basename(output));
      if (sourceOutput) {
        writeSource(stagedOutput);
      } else {
        const input = join(inputDirectory, "program.ll");
        const object = options.outputKind === "obj" ? stagedOutput : join(inputDirectory, "program" + toolchain.target.outputSuffixes.obj);
        writeSource(input);
        emitNativeObject({
          executable: toolchain.helperExecutable, packageRoot: toolchain.helperPackageRoot,
          compilerVersion: toolchain.compilerVersion, target: toolchain.target, helper: toolchain.helper,
          inputPath: input, outputPath: object, sourcePath: entry, optimization: options.optimization,
        });
        if (options.outputKind === "exe") {
          const runtime = stageNativeRuntimePack(toolchain.runtimePackRoot, join(stage, "runtime"),
            toolchain.target, toolchain.compilerVersion, features, options.optimization);
          const plan = executableLinkInputs({
            target: toolchain.target, programObject: object,
            ffiLibraries: ffi?.libraries ?? [], ffiSystemLibraries: ffi?.systemLibraries ?? [],
            ffiFrameworks: ffi?.frameworks ?? [],
            runtimeObjects: runtime.runtimeObjects, runtimeArchives: runtime.archives,
            runtimeSystemLibraries: runtime.systemLibraries, optimization: options.optimization, strip: options.strip,
          });
          runNativeTool(toolchain.linker, [
            ...toolchain.linkerArgs, ...plan.driverFlags, ...plan.inputs,
            ...plan.systemLibraries.map((name) => `-l${name}`), "-o", stagedOutput,
          ]);
          requireNativeArtifact(stagedOutput);
          if (toolchain.target.platform === "darwin" && options.optimization === "dev" && !options.strip) {
            runNativeTool(toolchain.dsymutil, [stagedOutput, "-o", stagedOutput + ".dSYM"]);
            rmSync(output + ".dSYM", { recursive: true, force: true });
            renameSync(stagedOutput + ".dSYM", output + ".dSYM");
          }
        }
      }
      if (options.keepLlvm && !sourceOutput) renameSync(join(inputDirectory, "program.ll"), output + ".ll");
      renameSync(stagedOutput, output);
      if (options.outputKind === "exe" && toolchain.target.platform === "darwin" && (options.optimization !== "dev" || options.strip)) {
        rmSync(output + ".dSYM", { recursive: true, force: true });
      }
    } finally { rmSync(stage, { recursive: true, force: true }); }
    return {
      outputPath: output, stats: lowered.stats,
      ...(options.keepLlvm && !sourceOutput ? { llvmPath: output + ".ll" } : {}),
    };
  } finally { frontend.dispose(); }
}
