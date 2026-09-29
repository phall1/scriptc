/** Seed a native compiler using the Node-hosted compiler. Subsequent builds
 * can invoke the resulting executable with the emitted FFI profile. */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../packages/compiler/src/index.js";
import { nativeCodegenTarget } from "../packages/compiler/src/backend/targets.js";
import { ts7Executable } from "../packages/compiler/src/frontend/ts7/rpc-api.js";
import type { NativeToolchainManifest } from "../packages/compiler/src/native/toolchain.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.argv[2] ?? join(root, ".scriptc/native"));
const target = nativeCodegenTarget();
if (target === null || target.platform === "wasi") throw new Error("a supported native host is required to build the compiler");
mkdirSync(output, { recursive: true });
const executable = join(output, "scriptc-native" + target.outputSuffixes.exe);
const object = join(output, "ts7-process" + target.outputSuffixes.obj);
const ffi = join(output, "ts7-process.ffi.json");
const nativeSources = join(root, "packages/compiler/native");
const compiler = process.env["SCRIPTC_CC"] ?? target.defaultLinker;
const compilerArgs = process.env["SCRIPTC_CC"] === undefined ? [...target.defaultLinkerArgs] : [];
const sanitize = process.env["SCRIPTC_SAN"] === "1";
// This object and profile are reused by native rebuilds with packaged runtimes.
// Sanitizer instrumentation belongs to the seed compiler's own build below.
execFileSync(compiler, [
  ...compilerArgs, "-std=c11", "-Wall", "-Wextra", "-Werror", "-target", target.linkerTargetTriple,
  "-c", join(nativeSources, "ts7-process.c"), "-o", object,
], { stdio: "inherit" });
writeFileSync(ffi, JSON.stringify({
  ...JSON.parse(readFileSync(join(nativeSources, "ts7-process.ffi.json"), "utf8")), libraries: [object],
}, null, 2) + "\n");
const result = await compile(join(root, "packages/compiler/src/native/main.ts"), {
  outDir: output, outPath: executable, backend: "llvm", optimization: "release", strip: true, dynamic: false, ffiProfilePath: ffi, sanitize,
});
if (!result.ok) throw new Error(result.diagnostics.map((item) =>
  `${item.loc ? `${item.loc.file}:${item.loc.start}: ` : ""}${item.code}: ${item.message}`,
).join("\n"));

// The executable path can be canonical even when the build directory was
// reached through a symlink (for example /tmp on macOS).
const relativeRoot = realpathSync(output);
const packagePath = (name: string) => relative(relativeRoot, join(root, "packages", name.replace("@scriptc/", "")));
const manifest: NativeToolchainManifest = {
  schema: "scriptc.native-toolchain.v1",
  compiler_version: (JSON.parse(readFileSync(join(root, "packages/compiler/package.json"), "utf8")) as { version: string }).version,
  target: target.name, ts7: relative(relativeRoot, ts7Executable()),
  llvm_package: packagePath(target.helper.packageName), runtime_pack: packagePath(target.runtimePackPackage),
  linker: process.env["SCRIPTC_LINKER"] ?? target.defaultLinker,
  linker_args: process.env["SCRIPTC_LINKER"] === undefined ? [...target.defaultLinkerArgs] : [],
  dsymutil: process.env["SCRIPTC_DSYMUTIL"] ?? "dsymutil",
};
writeFileSync(executable + ".json", JSON.stringify(manifest, null, 2) + "\n");
console.log(executable);
