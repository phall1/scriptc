import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import type { NativeToolchainManifest } from "../../packages/compiler/src/native/toolchain.js";
import { bootstrapStep } from "./self-hosting-timing.js";

const root = join(import.meta.dirname, "../..");
const exec = promisify(execFile);
const sanitize = process.env["SCRIPTC_SAN"] === "1";

function comparableStderr(text: string): string {
  return sanitize
    ? text.replace(/^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext functions and may produce false positives in some cases!\n/gm, "")
    : text;
}

function absoluteCommand(command: string): string {
  if (command.includes("/") || command.includes("\\")) return resolve(command);
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd"] : [""];
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    for (const extension of extensions) {
      const path = join(directory, command + extension);
      if (existsSync(path)) return resolve(path);
    }
  }
  throw new Error(`native tool is not on PATH: ${command}`);
}

test("the standalone compiler builds programs and rebuilds itself with Node unavailable", async () => {
  const directory = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-native-bootstrap-"));
  const executable = (name: string) => join(directory, name + (process.platform === "win32" ? ".exe" : ""));
  const options = { cwd: root, timeout: 1_800_000, maxBuffer: 16 * 1024 * 1024 };
  try {
    await bootstrapStep("build native compiler seed", () =>
      exec(process.execPath, ["--max-old-space-size=8192", "--import", "tsx", join(root, "scripts/build-native-compiler.mts"), directory], options));
    const seed = executable("scriptc-native");
    const manifestPath = seed + ".json";
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as NativeToolchainManifest;
    manifest.linker = absoluteCommand(manifest.linker);
    if (process.platform === "linux") {
      // Clang delegates linking to a separate executable. Resolve it before
      // removing PATH so the complete native toolchain remains available.
      const linker = await exec(manifest.linker, [...manifest.linker_args, "--print-prog-name=ld"], options);
      manifest.linker_args.push("--ld-path=" + absoluteCommand(linker.stdout.trim()));
    }
    if (process.platform === "darwin") manifest.dsymutil = absoluteCommand(manifest.dsymutil);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const nativeOptions = { ...options, env: { ...process.env, PATH: "" } };
    const invoke = async (compiler: string, args: string[]) => {
      const result = await exec(compiler, [...args, "--toolchain", manifestPath], nativeOptions).catch((error: unknown) => {
        const failure = error as Error & { code?: string | number; signal?: string; stdout?: string; stderr?: string };
        throw new Error(`${failure.message}\ncode=${failure.code} signal=${failure.signal}\n${failure.stderr ?? ""}\n${failure.stdout ?? ""}`, { cause: error });
      });
      expect(comparableStderr(result.stderr)).toBe("");
      const built = JSON.parse(result.stdout) as { outputPath: string; llvmPath?: string; stats: {
        statementsTotal: number; statementsFailed: number; statementsIsland: number; functionsSkipped: number;
      } };
      expect(built.stats.statementsFailed).toBe(0);
      expect(built.stats.statementsIsland).toBe(0);
      expect(built.stats.functionsSkipped).toBe(0);
      return built;
    };
    expect((await exec(seed, ["--help"], nativeOptions)).stdout).toContain("Usage: scriptc-native");
    const checkProgram = async (compiler: string, source: string, backend: string) => {
      // This basename formerly collided with the driver's temporary object.
      const output = executable("program.o");
      const built = await invoke(compiler, ["build", source, "-o", output, "--backend", backend, "--dev", "--strip"]);
      expect(built.outputPath).toBe(output);
      const oracle = spawnSync(process.execPath, [source], options);
      const actual = spawnSync(output, [], nativeOptions);
      for (const result of [oracle, actual]) {
        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status, result.stderr.toString()).toBe(0);
      }
      expect(actual.stdout).toEqual(oracle.stdout);
      expect(actual.stderr).toEqual(oracle.stderr);
    };
    const sample = join(root, "tests/corpus/class-array-optional-return.ts");
    const unionSample = join(root, "tests/corpus/union-nested-layout-discriminant.ts");
    await checkProgram(seed, sample, "llvm");
    await checkProgram(seed, unionSample, "llvm");

    const badSource = join(directory, "bad.ts");
    writeFileSync(badSource, 'const value: number = "wrong"; console.log(value);\n');
    const retained = executable("retained");
    writeFileSync(retained, "existing output");
    const failed = spawnSync(seed, [badSource, "-o", retained, "--toolchain", manifestPath], nativeOptions);
    expect(failed.status).toBe(1);
    expect(failed.stderr.toString()).toContain("not assignable");
    expect(readFileSync(retained, "utf8")).toBe("existing output");

    const entry = join(root, "packages/compiler/src/native/main.ts");
    const profile = join(directory, "ts7-process.ffi.json");
    const rebuilt = executable("scriptc-rebuilt");
    // Optimize the compiler that will process the full graph again. Small
    // programs above and below still exercise development output.
    const self = await bootstrapStep("native compiler rebuilds itself", () =>
      invoke(seed, [entry, "-o", rebuilt, "--backend=llvm", "--strip", "--keep-llvm", "--ffi", profile]));
    expect(self.stats.statementsTotal).toBeGreaterThan(10_000);
    expect(self.llvmPath).toBe(rebuilt + ".ll");
    console.log("native self-build", self.stats);
    await checkProgram(rebuilt, join(root, "tests/corpus/nullish-long-chain.ts"), "llvm");
    await checkProgram(rebuilt, sample, "llvm");
    await checkProgram(rebuilt, unionSample, "llvm");

    // Compare the LLVM used to build the second generation with its own
    // output. Retaining the build input avoids repeating the seed's work.
    if (!self.llvmPath) throw new Error("native self-build did not retain its LLVM");
    const seedLlvm = self.llvmPath;
    const rebuiltLlvm = join(directory, "rebuilt.ll");
    await bootstrapStep("rebuilt compiler emits itself", () =>
      invoke(rebuilt, [entry, "--emit=llvm", "-o", rebuiltLlvm, "--ffi", profile]));
    expect(readFileSync(seedLlvm).equals(readFileSync(rebuiltLlvm)), "native compiler generations must emit identical LLVM").toBe(true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 5_400_000);
