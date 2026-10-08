import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadProgram } from "../program-node.js";
import * as ts from "../ts7/adapter.js";
import { DYN } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";
import { implicitAnyParamSymbolsOf } from "./generic-functions.js";

const declarations = `
function stable(C, value) { return value instanceof C; }
function bare(C, value) { var C; return value instanceof C; }
function defaulted(C, value, flag = (C = globalThis.RegExp)) { return value instanceof C; }
function initialized(C, value) { var C = globalThis.RegExp; return value instanceof C; }
function hoisted(C, value) { function C() {} return value instanceof C; }
function cursor(C, value) { for (var C of [globalThis.RegExp]) {} return value instanceof C; }
function destructured(C, value) { var [C] = [globalThis.RegExp]; return value instanceof C; }
function shadowed(C, value) { function nested(C) { C = globalThis.RegExp; } return value instanceof C; }
function captured(C, value) { function nested() { C = globalThis.RegExp; } return value instanceof C; }
`;

test("implicit identities require unwritten bindings across defaults and redeclarations", () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-implicit-params-"));
  let loaded: ReturnType<typeof loadProgram> | undefined;
  try {
    const entry = join(directory, "input.js");
    writeFileSync(entry, declarations);
    const program = loadProgram(entry);
    loaded = program;
    const checker = program.program.getTypeChecker();
    const lowerer = {
      checker,
      typeOf: (node: ts.Node) => checker.getTypeAtLocation(node),
      checkerAnyArrayType: () => false,
      mapTypeOf: () => DYN,
    } as unknown as Lowerer;
    const functions = new Map<string, ts.FunctionDeclaration>();
    for (const statement of program.entry.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name)
        functions.set(statement.name.text, statement);
    }
    for (const [name, declaration] of functions) {
      const parameters = implicitAnyParamSymbolsOf(lowerer, declaration);
      const symbol = checker.getSymbolAtLocation(declaration.parameters[0]!.name);
      if (["stable", "bare", "shadowed"].includes(name)) expect(parameters?.[0], name).toBe(symbol);
      else expect(parameters?.[0] ?? null, name).toBeNull();
    }
  } finally {
    loaded?.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
