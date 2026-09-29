import { expect, test } from "vitest";
import { parseNativeArguments } from "./arguments.js";

test("native build arguments preserve paths and select explicit output modes", () => {
  expect(parseNativeArguments([
    "build", "source with spaces.ts", "-o", "result with spaces", "--backend=llvm", "--emit=obj",
    "--toolchain", "/installed/compiler.json", "--dev", "--strip", "--ffi=bindings.json", "--npm-static=one,@scope/two",
  ], "default.json")).toEqual({
    help: false, toolchainPath: "/installed/compiler.json",
    build: {
      entryPath: "source with spaces.ts", outputPath: "result with spaces", backend: "llvm", outputKind: "obj",
      optimization: "dev", strip: true, ffiProfilePath: "bindings.json", npmStatic: ["one", "@scope/two"],
    },
  });
  expect(parseNativeArguments(["--out=result", "--npm-static", "auto", "--", "-entry.ts"], "default.json")).toMatchObject({
    toolchainPath: "default.json", build: { entryPath: "-entry.ts", outputKind: "exe", backend: "llvm", npmStatic: "auto" },
  });
  expect(parseNativeArguments(["--help"], "default.json").help).toBe(true);
});

test("native build rejects unknown, missing and ambiguous arguments", () => {
  for (const [args, message] of [
    [[], "entry source"],
    [["main.ts"], "output path"],
    [["main.ts", "-o"], "requires a value"],
    [["main.ts", "-o", "--dev"], "requires a value"],
    [["main.ts", "-o=x", "extra.ts"], "unexpected argument"],
    [["main.ts", "-o=x", "--dynamic"], "unknown native compiler option"],
    [["main.ts", "-o=x", "--backend=other"], "LLVM is the only backend"],
    [["main.ts", "-o=x", "--backend=c"], "LLVM is the only backend"],
    [["main.ts", "-o=x", "--emit=c"], "--emit must"],
    [["main.ts", "-o=x", "--emit=other"], "--emit must"],
  ] as const) expect(() => parseNativeArguments(args, "toolchain.json")).toThrow(message);
});
