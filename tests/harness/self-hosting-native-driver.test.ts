import { execFile, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { WASI } from "node:wasi";
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

test("the production CLI relocates, builds programs, and rebuilds itself with Node unavailable", async () => {
  const directory = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-native-bootstrap-"));
  const executable = (name: string) => join(directory, name + (process.platform === "win32" ? ".exe" : ""));
  const options = { cwd: root, timeout: 1_800_000, maxBuffer: 16 * 1024 * 1024 };
  try {
    const distribution = join(directory, "distribution");
    await bootstrapStep("build production CLI seed", () =>
      exec(process.execPath, ["--max-old-space-size=8192", "--import", "tsx", join(root, "scripts/build-native-cli.mts"), distribution], {
        // The seed builds an instrumented second generation below. Run
        // the full sanitizer proof with that generation instead of paying
        // for two instrumented traversals of the complete compiler graph.
        ...options, env: { ...process.env, SCRIPTC_SAN: "", SCRIPTC_NATIVE_EMIT_IR: "1" },
      }));
    // All compiler assets must survive moving the complete distribution.
    const relocated = join(directory, "relocated");
    renameSync(distribution, relocated);
    const seed = join(relocated, "bin", "scriptc" + (process.platform === "win32" ? ".exe" : ""));
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
    if (process.platform === "darwin") manifest.relocatable_linker = absoluteCommand("ld");
    manifest.archiver = absoluteCommand(process.platform === "win32" ? "zig" : "ar");
    manifest.archiver_args = process.platform === "win32" ? ["ar"] : [];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    let sanitizerCompiler: string | undefined;
    if (sanitize) {
      sanitizerCompiler = absoluteCommand(process.env["SCRIPTC_CC"] ?? "clang");
      if (process.platform === "linux") {
        const linker = await exec(sanitizerCompiler, ["--print-prog-name=ld"], options);
        const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
        const wrapper = join(directory, "sanitizer-clang");
        // Preserve the empty PATH while making Clang's child linker explicit.
        writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(sanitizerCompiler)} ${quote("--ld-path=" + absoluteCommand(linker.stdout.trim()))} "$@"\n`);
        chmodSync(wrapper, 0o755);
        sanitizerCompiler = wrapper;
      }
    }
    const nativeOptions = { ...options, env: { ...process.env, PATH: "", SCRIPTC_TOOLCHAIN: manifestPath,
      SCRIPTC_CACHE_DIR: join(directory, "cache"), ...(sanitizerCompiler === undefined ? {} : { SCRIPTC_CC: sanitizerCompiler }) } };
    const invoke = async (compiler: string, args: string[], expectedStderr = "") => {
      const result = await exec(compiler, args, nativeOptions).catch((error: unknown) => {
        const failure = error as Error & { code?: string | number; signal?: string; stdout?: string; stderr?: string };
        throw new Error(`${failure.message}\ncode=${failure.code} signal=${failure.signal}\n${failure.stderr ?? ""}\n${failure.stdout ?? ""}`, { cause: error });
      });
      expect(comparableStderr(result.stderr)).toBe(expectedStderr);
      return result.stdout;
    };
    const entry = join(root, "packages/compiler/src/native/cli.ts");
    const ffi = join(directory, ".scriptc/distribution-seed/compiler.ffi.json");
    const rebuilt = executable("scriptc-rebuilt");
    // Optimize the compiler that will process the full graph again. Small
    // programs below still exercise development output.
    const self = await bootstrapStep("production CLI rebuilds itself", () =>
      invoke(seed, ["build", entry, "-o", rebuilt, "--strip", "--keep-llvm", "--emit-ir", "--ffi", ffi,
        ...(sanitize ? ["--sanitize"] : [])],
      "scriptc: warning: --emit-ir is deprecated; use --emit=ir for IR as the primary output\n"));
    expect(self.trim()).toBe(rebuilt);
    // All command, library, and dynamic probes run inside the instrumented
    // compiler in the sanitizer lane, including their failure paths.
    const probe = sanitize ? rebuilt : seed;
    expect(await invoke(probe, ["--help"])).toContain("scriptc build");
    expect((await invoke(probe, ["--version"])).trim()).toBe(manifest.compiler_version);
    const checkProgram = async (compiler: string, source: string, extra: string[] = []) => {
      // This basename formerly collided with the driver's temporary object.
      const output = executable("program.o");
      const built = await invoke(compiler, ["build", source, "-o", output, "--optimization=dev", "--strip", ...extra]);
      expect(built.trim()).toBe(output);
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
    const receiverSample = join(root, "tests/corpus/llvm-read-receiver-lifetime.ts");
    await checkProgram(probe, sample);
    await checkProgram(probe, unionSample);
    await checkProgram(probe, receiverSample);
    await checkProgram(probe, join(root, "tests/corpus/closure-nullable-union-return.ts"));
    await checkProgram(probe, join(root, "tests/corpus/record-optional-json-presence.ts"));
    await checkProgram(probe, join(root, "tests/corpus/1010-json-stringify-space.ts"));
    await checkProgram(probe, join(root, "tests/corpus/fs-write-string-bytes-union.ts"));

    const fetchOptions = join(directory, "fetch-options.ts");
    writeFileSync(fetchOptions, 'async function probe() { const response = await fetch("https://example.invalid", { headers: { accept: "application/json" } }); console.log(response.status); } if (process.env["RUN_NATIVE_FETCH_PROBE"] === "1") await probe();\n');
    await checkProgram(probe, fetchOptions);
    expect(await invoke(probe, ["coverage", fetchOptions])).toContain("(100%)");

    const dynamic = join(directory, "dynamic.ts");
    writeFileSync(dynamic, 'const value: any = { answer: 42 }; console.log(`answer:${value.answer}`);\n');
    await checkProgram(probe, dynamic, ["--dynamic"]);
    const comptime = join(directory, "comptime.ts");
    writeFileSync(comptime, 'const answer = comptime(() => [1, 2, 3].reduce((sum, value) => sum + value, 0) * 7); console.log(answer);\n');
    expect(await invoke(probe, ["run", comptime, "-o", executable("comptime"), "--strip"])).toBe("42\n");

    const object = join(directory, "program.obj");
    const linkInfo = JSON.parse(await invoke(probe, ["build", sample, "-o", object, "--print=native-link-info"]));
    expect(linkInfo.program.object).toBe(object);
    expect(readFileSync(object).length).toBeGreaterThan(0);

    const profile = join(root, "tests/library-mode/contract-attest/profile.json");
    const archive = join(directory, "contract.a");
    const expectedArchive = join(directory, "contract-node.a");
    await exec(process.execPath, [join(root, "packages/cli/dist/main.js"), "build", "--lib", "--profile", profile, "-o", expectedArchive], options);
    await invoke(probe, ["build", "--lib", "--profile", profile, "-o", archive]);
    expect(JSON.parse(readFileSync(archive + ".contract.json", "utf8")))
      .toEqual(JSON.parse(readFileSync(expectedArchive + ".contract.json", "utf8")));

    // The unmodified package exercises deep validator traversals. Compile it
    // through the installed CLI, including its async command boundary.
    const threeProfile = join(root, "tests/library-mode/wasm/three.json");
    await invoke(probe, ["build", "--lib", "--profile", threeProfile, "-o", join(directory, "three.a")]);
    if (process.platform !== "win32" && spawnSync("zig", ["version"]).status === 0 && existsSync(join(root, "packages/runtime-wasm32-wasi/runtime-pack.json"))) {
      const linker = join(directory, "zigcc");
      writeFileSync(linker, `#!/bin/sh\nexec '${absoluteCommand("zig").replaceAll("'", "'\\''")}' cc "$@"\n`, { mode: 0o755 });
      const output = join(directory, "three.wasm");
      const built = await exec(probe, ["build", "--lib", "--profile", threeProfile, "-o", output], {
        ...nativeOptions, env: { ...nativeOptions.env, SCRIPTC_TARGET: "wasm32-wasi", SCRIPTC_LINKER: linker,
          SCRIPTC_RUNTIME_PACK: join(root, "packages/runtime-wasm32-wasi"), SCRIPTC_NO_CACHE: "1" },
      });
      expect(built.stdout.trim()).toBe(output);
      expect(comparableStderr(built.stderr)).toBe("");
      const vertices: number[][] = [];
      const wasi = new WASI({ version: "preview1" });
      const instance = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(output)), {
        ...wasi.getImportObject(), scriptc: {
          vertex: (...args: number[]) => vertices.push(args.map((value) => Number(value.toFixed(9)))),
          panic: () => { throw new Error("unexpected Wasm panic"); },
        },
      });
      wasi.initialize(instance);
      const api = instance.exports as Record<string, (...args: number[]) => number>;
      api.app_init!();
      for (const time of [0, 123, 2000]) expect(api.app_frame!(time, 1.5)).toBe(24);
      const oracle = await exec(process.execPath, ["--input-type=module", "--eval", `
        const vertices = [];
        globalThis.vertex = (...args) => vertices.push(args.map(value => Number(value.toFixed(9))));
        const { frame } = await import(${JSON.stringify(join(root, "tests/library-mode/wasm/three.mjs"))});
        for (const time of [0, 123, 2000]) frame(time, 1.5);
        console.log(JSON.stringify(vertices));
      `], options);
      expect(vertices).toEqual(JSON.parse(oracle.stdout));
      expect(oracle.stderr).toBe("");
      api.app_collect!();
    }

    const badSource = join(directory, "bad.ts");
    writeFileSync(badSource, 'const value: number = "wrong"; console.log(value);\n');
    const retained = executable("retained");
    writeFileSync(retained, "existing output");
    const failed = spawnSync(probe, ["build", badSource, "-o", retained], nativeOptions);
    expect(failed.status).toBe(1);
    expect(failed.stderr.toString()).toContain("not assignable");
    expect(readFileSync(retained, "utf8")).toBe("existing output");

    // The production chain owns the complete frontend and emitter proof:
    // compare the Node seed's IR and LLVM with the native self-rebuild, then
    // execute the next compiler generation below. Large structural checks
    // run in a roomy child so Vitest's worker remains responsive.
    const seedDirectory = join(directory, ".scriptc/distribution-seed");
    const comparison = await bootstrapStep("compare Node and native compiler IR and LLVM", () =>
      exec(process.execPath, ["--max-old-space-size=8192", "--import", "tsx", "--input-type=module", "--eval", `
        import assert from 'node:assert/strict';
        import { readFileSync } from 'node:fs';
        import { isDeepStrictEqual } from 'node:util';
        import { deserializeModule, validateModule } from ${JSON.stringify(pathToFileURL(join(root, "packages/compiler/src/index.ts")).href)};
        const expected = deserializeModule(readFileSync(process.argv[1], 'utf8'));
        const actual = deserializeModule(readFileSync(process.argv[2], 'utf8'));
        assert.ok(actual.functions.length > 1000);
        assert.deepEqual(validateModule(actual), []);
        assert.ok(isDeepStrictEqual(actual, expected), 'native self-lowering must match the Node seed');
        assert.ok(readFileSync(process.argv[3], 'utf8') === readFileSync(process.argv[4], 'utf8'),
          'native LLVM emission must match the Node seed');
      `, join(seedDirectory, "cli.ir.json"), join(directory, "cli.ir.json"),
      join(seedDirectory, "cli.ll"), join(directory, "cli.ll")], options));
    expect(comparison.stdout).toBe("");
    expect(comparison.stderr).toBe("");
    await checkProgram(rebuilt, join(root, "tests/corpus/nullish-long-chain.ts"));
    await checkProgram(rebuilt, sample);
    await checkProgram(rebuilt, unionSample);
    await checkProgram(rebuilt, receiverSample);
    await checkProgram(rebuilt, join(root, "tests/corpus/1010-json-stringify-space.ts"));

    // Compare the LLVM used to build the second generation with its own
    // output. Retaining the build input avoids repeating the seed's work.
    const seedLlvm = join(directory, "cli.ll");
    const rebuiltLlvm = join(directory, "rebuilt.ll");
    await bootstrapStep("rebuilt compiler emits itself", () =>
      invoke(rebuilt, ["build", entry, "--emit=llvm", "-o", rebuiltLlvm, "--ffi", ffi]));
    // Executable output adds a runtime ABI check; textual LLVM emission
    // omits it. Compare all other output without changing either mode.
    const withoutAbiCheck = (path: string): string => readFileSync(path, "utf8")
      .replace(/^declare void @scr_runtime_abi_v\d+\(\)\n/m, "")
      .replace(/^  call void @scr_runtime_abi_v\d+\(\)\n/m, "");
    expect(withoutAbiCheck(seedLlvm) === withoutAbiCheck(rebuiltLlvm), "native compiler generations must emit identical LLVM").toBe(true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 5_400_000);
