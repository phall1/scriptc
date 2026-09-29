import type { NativeBuildOptions } from "./driver.js";

export interface NativeArguments {
  help: boolean;
  toolchainPath: string;
  build: NativeBuildOptions;
}

export function parseNativeArguments(args: readonly string[], defaultToolchain: string): NativeArguments {
  let toolchainPath = defaultToolchain;
  let entryPath = "";
  let outputPath = "";
  let backend = "llvm" as const;
  let outputKind: "exe" | "obj" | "llvm" = "exe";
  let optimization: "release" | "dev" = "release";
  let strip = false;
  let help = false;
  let ffiProfilePath: string | undefined;
  let npmStatic: string[] | "auto" | undefined;
  let positional = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!positional && (arg === "--help" || arg === "-h")) { help = true; continue; }
    if (!positional && arg === "--") { positional = true; continue; }
    if (!positional && arg === "--dev") { optimization = "dev"; continue; }
    if (!positional && arg === "--strip") { strip = true; continue; }
    if (!positional && arg.startsWith("-")) {
      const equals = arg.indexOf("=");
      const name = equals < 0 ? arg : arg.slice(0, equals);
      if (!["-o", "--out", "--toolchain", "--backend", "--emit", "--ffi", "--npm-static"].includes(name)) {
        throw new Error(`unknown native compiler option: ${name}`);
      }
      const value = equals < 0 ? args[++index] : arg.slice(equals + 1);
      if (value === undefined || value === "" || (equals < 0 && value.startsWith("--"))) throw new Error(`${name} requires a value`);
      if (name === "-o" || name === "--out") outputPath = value;
      else if (name === "--toolchain") toolchainPath = value;
      else if (name === "--ffi") ffiProfilePath = value;
      else if (name === "--npm-static") npmStatic = value === "auto" ? "auto" : value.split(",");
      else if (name === "--backend") {
        if (value !== "llvm") throw new Error("LLVM is the only backend");
        backend = value;
      } else if (name === "--emit") {
        if (value !== "exe" && value !== "obj" && value !== "llvm") throw new Error("--emit must be exe, obj, or llvm");
        outputKind = value;
      }
      continue;
    }
    if (!positional && index === 0 && arg === "build") continue;
    if (entryPath !== "") throw new Error(`unexpected argument: ${arg}`);
    entryPath = arg;
  }
  if (!help && entryPath === "") throw new Error("a TypeScript entry source is required");
  if (!help && outputPath === "") throw new Error("an output path is required (-o <path>)");
  return {
    help, toolchainPath,
    build: {
      entryPath, outputPath, backend, outputKind, optimization, strip,
      ...(ffiProfilePath === undefined ? {} : { ffiProfilePath }),
      ...(npmStatic === undefined ? {} : { npmStatic }),
    },
  };
}

export const NATIVE_HELP = `Usage: scriptc-native build <entry.ts> -o <output> [options]

  --backend <llvm>       Code generation backend (default: llvm)
  --emit <exe|obj|llvm>  Output artifact (default: exe)
  --dev                   Disable optimization and include debug information
  --strip                 Strip executable symbols
  --ffi <profile.json>    Native FFI bindings and link inputs
  --npm-static <packages> Compile comma-separated packages, or auto
  --toolchain <file>      Native toolchain manifest (default: beside executable)
  --help                  Show this help

The native compiler builds static programs; unsupported statements are errors.`;
