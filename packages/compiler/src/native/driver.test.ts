import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { buildNative, type NativeToolchain } from "./driver.js";
import { runNativeFrontend } from "../frontend/pipeline-native.js";
import { emitNativeObject } from "../backend/native-tools.js";
import { MACOS_ARM64_TARGET } from "../backend/targets.js";
import { VOID, type IrModule } from "../ir/ir.js";

vi.mock("../frontend/pipeline-native.js", () => ({ runNativeFrontend: vi.fn() }));
vi.mock("../backend/native-tools.js", async (original) => ({
  ...await original<typeof import("../backend/native-tools.js")>(), emitNativeObject: vi.fn(),
}));

const directories: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

test.each([false, true])("object generation releases frontend resources and preserves outputs on failure (%s)", (fail) => {
  const directory = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-native-driver-"));
  directories.push(directory);
  const entry = join(directory, "entry.ts");
  const output = join(directory, "output.o");
  const llvmPath = output + ".ll";
  writeFileSync(output, "previous object");
  writeFileSync(llvmPath, "previous LLVM");
  const module: IrModule = {
    irVersion: 13, sourceFile: entry, entry: "%main",
    functions: [{ name: "%main", params: [], locals: [], body: [], returnType: VOID, loc: { file: entry, start: 0, end: 0 } }],
  };
  const dispose = vi.fn();
  vi.mocked(runNativeFrontend).mockReturnValue({
    preflight: [], entryText: () => "", entryExports: () => new Map(),
    entryContract: () => { throw new Error("unexpected contract request"); },
    sourceTexts: () => new Map(), npmStatic: [], npmImportSites: new Map(), dispose,
    lower: () => ({ module, diagnostics: [], runtimeFences: [], stats: {
      statementsTotal: 0, statementsFailed: 0, statementsIsland: 0, functionsSkipped: 0,
    } }),
  });
  let emitted = "";
  vi.mocked(emitNativeObject).mockImplementation((options) => {
    expect(dispose).toHaveBeenCalledTimes(1);
    emitted = readFileSync(options.inputPath, "utf8");
    expect(emitted).toContain("define i32 @main");
    if (fail) throw new Error("codegen failed");
    writeFileSync(options.outputPath, "new object");
  });
  const target = MACOS_ARM64_TARGET;
  const toolchain: NativeToolchain = {
    compilerVersion: "0.0.0", target, helper: target.helper, ts7Executable: "unused",
    helperExecutable: "unused", helperPackageRoot: "unused", runtimePackRoot: "unused",
    linker: "unused", linkerArgs: [], dsymutil: "unused",
  };
  const build = () => buildNative({
    entryPath: entry, outputPath: output, backend: "llvm", outputKind: "obj",
    optimization: "release", strip: true, keepLlvm: true,
  }, toolchain);
  if (fail) {
    expect(build).toThrow("codegen failed");
    expect(readFileSync(output, "utf8")).toBe("previous object");
    expect(readFileSync(llvmPath, "utf8")).toBe("previous LLVM");
  } else {
    expect(build()).toMatchObject({ outputPath: output, llvmPath });
    expect(readFileSync(output, "utf8")).toBe("new object");
    expect(readFileSync(llvmPath, "utf8")).toBe(emitted);
  }
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(readdirSync(directory).sort()).toEqual(["output.o", "output.o.ll"]);
});
