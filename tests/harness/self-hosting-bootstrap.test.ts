import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";
import { expect, test } from "vitest";
import { compileC, deserializeModule, emitLlvmModule, validateModule } from "@scriptc/compiler";
import type { compile } from "@scriptc/compiler";
import * as ir from "../../packages/compiler/src/ir/ir.js";
import { ts7Executable } from "../../packages/compiler/src/frontend/ts7/rpc-api.js";

const root = join(import.meta.dirname, "../..");
const execFileAsync = promisify(execFile);
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const options = { cwd: root, timeout: 1_200_000, maxBuffer: 16 * 1024 * 1024 };

function nativeFeatures(module: ir.IrModule) {
  return {
    regex: ir.moduleUsesRegex(module), copying: ir.moduleUsesCopying(module),
    inspect: ir.moduleUsesInspect(module), dynInvoke: ir.moduleUsesDynInvoke(module),
    symbol: ir.moduleUsesSymbol(module), bigint: ir.moduleUsesBigInt(module),
    zlib: ir.moduleUsesZlib(module), assert: ir.moduleUsesAssert(module),
    textDecoderLegacy: ir.moduleUsesLegacyTextDecoder(module), fileHandle: ir.moduleUsesFileHandle(module),
    fetch: ir.moduleUsesFetch(module), dc: ir.moduleUsesDc(module), dynAsync: ir.moduleUsesDynAsync(module),
    events: ir.moduleUsesProcessEvents(module), emitter: ir.moduleUsesEmitter(module),
    searchParams: ir.moduleUsesSearchParams(module), qs: ir.moduleUsesQs(module), parseArgs: ir.moduleUsesParseArgs(module),
    stream: ir.moduleUsesStream(module), net: ir.moduleUsesNet(module), http: ir.moduleUsesHttpServer(module),
    http2: ir.moduleUsesHttp2(module), dgram: ir.moduleUsesDgram(module), watch: ir.moduleUsesFsWatch(module),
    nodeTest: ir.moduleUsesNodeTest(module), tls: ir.moduleUsesTls(module), tlsCa: ir.moduleUsesTlsCa(module),
  };
}

test("the native frontend and LLVM emitter rebuild a working frontend from its TypeScript source", async () => {
  const directory = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-bootstrap-"));
  const executable = (name: string) => join(directory, name + (process.platform === "win32" ? ".exe" : ""));
  const frontend = join(root, "tests/fixtures/self-hosting/frontend-lowering.ts");
  const emitter = join(root, "tests/fixtures/self-hosting/llvm-emitter.ts");
  const nativeOptions = { ...options, env: { ...process.env, PATH: "" } };
  try {
    const nativeSources = join(root, "packages/compiler/native");
    const object = join(directory, "ts7-process.o");
    execFileSync("clang", ["-std=c11", "-Wall", "-Wextra", "-Werror", ...(sanitize ? ["-fsanitize=address"] : []),
      "-c", join(nativeSources, "ts7-process.c"), "-o", object]);
    const profile = join(directory, "ffi.json");
    writeFileSync(profile, JSON.stringify({
      ...JSON.parse(readFileSync(join(nativeSources, "ts7-process.ffi.json"), "utf8")), libraries: [object],
    }));

    const buildSeed = async (entry: string, name: string, ffi?: string) => {
      const api = pathToFileURL(join(root, "packages/compiler/src/index.ts")).href;
      const built = await execFileAsync(process.execPath, [
        "--max-old-space-size=8192", "--import", "tsx", "--input-type=module", "--eval",
        `import { compile } from ${JSON.stringify(api)};
         const result = await compile(process.argv[1], {
           outDir: process.argv[2], outPath: process.argv[3], backend: 'llvm',
           dynamic: false, optimization: 'dev', sanitize: process.argv[4] === '1',
           ffiProfilePath: process.argv[5] || undefined, emitIr: true,
         });
         console.log(JSON.stringify({ ...result, sourceTexts: undefined }));`,
        entry, directory, executable(name), sanitize ? "1" : "0", ffi ?? "",
      ], options);
      expect(built.stderr).toBe("");
      const result = JSON.parse(built.stdout) as Awaited<ReturnType<typeof compile>>;
      if (!result.ok) throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      if (!("binaryPath" in result)) throw new Error("expected a native frontend executable");
      expect(result.backend).toBe("llvm");
      expect(result.irPath).toBeDefined();
      return result;
    };
    const seed = await buildSeed(frontend, "frontend-seed", profile);
    const nativeEmitter = await buildSeed(emitter, "emitter");
    const emitterRequest = join(directory, "emitter-request.json");
    writeFileSync(emitterRequest, JSON.stringify({ debug: true, sources: [], pointerBits: 64, wasi: false, emitLibraryIdentity: true, runtimeAbiMarker: false }));
    const ownIr = join(directory, "frontend-native.json");
    const self = await execFileAsync(seed.binaryPath, [ts7Executable(), frontend, ownIr, profile], nativeOptions);
    expect(self.stdout).toBe("0\n0 0\n");
    expect(self.stderr).toBe("");

    // Compare complete IR, including layouts and helper signatures. A valid
    // module alone can hide different optional-return inference or dropped
    // method-registry mutations in the native compiler.
    const module = deserializeModule(readFileSync(ownIr, "utf8"));
    expect(module.functions.length).toBeGreaterThan(1_000);
    expect(validateModule(module)).toEqual([]);
    expect(isDeepStrictEqual(module, deserializeModule(readFileSync(seed.irPath!, "utf8"))), "native self-lowering must match the Node seed").toBe(true);

    const cPath = join(directory, "frontend-native.ll");
    const emitted = await execFileAsync(nativeEmitter.binaryPath, [ownIr, cPath, emitterRequest], nativeOptions);
    expect(emitted.stdout).toBe("");
    expect(emitted.stderr).toBe("");
    // Avoid rendering hundreds of megabytes in an assertion failure.
    expect(readFileSync(cPath, "utf8") === emitLlvmModule(module, { debugSources: new Map() }), "native LLVM emission must match Node exactly").toBe(true);
    const rebuilt = executable("frontend-rebuilt");
    await compileC({ cPath, outPath: rebuilt, optimization: "dev", sanitize, linkInputs: [object], ...nativeFeatures(module) });

    // The rebuilt compiler consumes new source, and its emitted program
    // executes. These inputs exercise the two bugs found by self-compiling:
    // long nullish dispatch and optional class-method return promotion.
    for (const name of ["nullish-long-chain", "class-array-optional-return"]) {
      const source = join(root, "tests/corpus", name + ".ts");
      const actualIr = join(directory, name + "-native.json");
      const expectedIr = join(directory, name + "-node.json");
      const expected = await execFileAsync(process.execPath, ["--import", "tsx",
        join(root, "tests/fixtures/self-hosting/frontend-lowering-node.ts"), ts7Executable(), source, expectedIr], options);
      const actual = await execFileAsync(rebuilt, [ts7Executable(), source, actualIr], nativeOptions);
      expect(expected.stdout).toBe("0\n0 0\n");
      expect(actual.stdout).toBe(expected.stdout);
      expect(expected.stderr).toBe("");
      expect(actual.stderr).toBe("");
      const program = deserializeModule(readFileSync(actualIr, "utf8"));
      expect(program).toEqual(deserializeModule(readFileSync(expectedIr, "utf8")));
      expect(validateModule(program)).toEqual([]);
      const programC = join(directory, "program.ll");
      const emission = await execFileAsync(nativeEmitter.binaryPath, [actualIr, programC, emitterRequest], nativeOptions);
      expect(emission.stdout).toBe("");
      expect(emission.stderr).toBe("");
      await compileC({ cPath: programC, outPath: executable("program"), sanitize, ...nativeFeatures(program) });
      const oracle = spawnSync(process.execPath, [source], options);
      const native = spawnSync(executable("program"), [], options);
      for (const result of [oracle, native]) {
        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status, result.stderr.toString()).toBe(0);
      }
      expect(native.stdout).toEqual(oracle.stdout);
      expect(native.stderr).toEqual(oracle.stderr);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 2_400_000);
