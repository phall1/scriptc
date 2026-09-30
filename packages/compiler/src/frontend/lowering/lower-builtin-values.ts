import * as ts from "../ts7/adapter.js";
import { BOOL, DYN, NULL_T, STRING, UNDEFINED_T, type IrExpr, type IrStmt, type SrcLoc } from "../../ir/ir.js";
import { strLit, varRef } from "../../ir/build.js";
import type { Lowerer } from "./lowerer.js";
import { BUILTIN_MODULE_CONSTS, BUILTIN_MODULE_FNS, OBJECT_CALLABLE_VALUES, builtinConstLit, builtinModuleConstOf, builtinModulesArrayLit } from "./surfaces.js";

/** These native callables own their argument checks. Unannotated JS aliases
 * keep the checked value instead of narrowing it to the ambient signature.
 * This selects storage only: reassignment still updates a real runtime slot. */
export function isNativeBuiltinValueInitializer(lowerer: Lowerer, expr: ts.Expression | undefined, seen = new Set<ts.Symbol>()): boolean {
  if (!expr) return false;
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (lowerer.isStdlibGlobal(expr, "console")) return true;
  if (ts.isNewExpression(expr) && lowerer.isStdlibGlobal(expr.expression, "Date")) return true;
  if (ts.isConditionalExpression(expr)) {
    return isNativeBuiltinValueInitializer(lowerer, expr.whenTrue, new Set(seen)) ||
      isNativeBuiltinValueInitializer(lowerer, expr.whenFalse, new Set(seen));
  }
  if (ts.isPropertyAccessExpression(expr)) {
    return lowerer.stdlibGlobalMember(expr, "console") !== null ||
      lowerer.stdlibGlobalMember(expr, "globalThis") === "console" ||
      lowerer.stdlibGlobalMember(expr, "process") === "getBuiltinModule" ||
      lowerer.stdlibGlobalMember(expr, "process") === "hrtime" ||
      (expr.name.text === "bigint" && ts.isPropertyAccessExpression(expr.expression) &&
        lowerer.stdlibGlobalMember(expr.expression, "process") === "hrtime") ||
      lowerer.stdlibGlobalMember(expr, "Array") === "isArray" ||
      lowerer.stdlibGlobalMember(expr, "Array") === "prototype" ||
      lowerer.stdlibGlobalMember(expr, "JSON") === "stringify" ||
      (lowerer.isStdlibGlobal(expr.expression, "Object") && Object.hasOwn(OBJECT_CALLABLE_VALUES, expr.name.text));
  }
  if (!ts.isIdentifier(expr)) return false;
  const symbol = lowerer.resolveValueSymbol(expr);
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  return lowerer.checker.declarationsOf(symbol).some((decl) =>
    ts.isVariableDeclaration(decl) && isNativeBuiltinValueInitializer(lowerer, decl.initializer, seen));
}

/** The stored Array.isArray function shares the direct call's native test. */
export function lowerArrayIsArrayValue(lowerer: Lowerer, loc: SrcLoc): IrExpr {
  const key = "%builtin.Array.isArray";
  let name = lowerer.builtinCallableValueFns.get(key);
  if (!name) {
    name = key;
    lowerer.builtinCallableValueFns.set(key, name);
    lowerer.liftedFns.push({
      name, params: [{ localId: "value", name: "value", type: DYN }], returnType: BOOL,
      locals: [{ id: "value", name: "value", type: DYN, mutable: false }],
      body: [{ kind: "return", value: { kind: "dynTest", test: "array", value: varRef("value", DYN, loc), type: BOOL, loc }, loc }],
      loc,
    });
  }
  return { kind: "closure", fnName: name, captures: [], type: { kind: "func", params: [DYN], ret: BOOL }, loc };
}

// These module values expose existing native callable lowerings and main-thread
// metadata. Other exports keep an explicit runtime refusal, including Worker.
const MODULES = ["path/posix", "path/win32", "os", "worker_threads"] as const;

const box = (value: IrExpr): IrExpr => value.type.kind === "dyn" ? value : { kind: "dynFrom", value, type: DYN, loc: value.loc };

function moduleValue(lowerer: Lowerer, module: string, loc: SrcLoc): IrExpr {
  const cacheKey = `%builtin.module.get.${module}`;
  let name = lowerer.builtinCallableValueFns.get(cacheKey);
  if (!name) {
    name = cacheKey;
    lowerer.builtinCallableValueFns.set(cacheKey, name);
    const key = varRef("key", STRING, loc);
    const body: IrStmt[] = [];
    const add = (member: string, value: IrExpr): void => {
      body.push({
        kind: "if", cond: { kind: "strEq", negated: false, left: key, right: strLit(member, loc), type: BOOL, loc },
        then: [{ kind: "return", value: box(value), loc }], else_: null, loc,
      });
    };
    for (const member of Object.keys(BUILTIN_MODULE_FNS[module] ?? {})) {
      const callable = lowerer.lowerBuiltinCallableValue({ module, member }, loc);
      if (callable) add(member, callable);
    }
    for (const member of Object.keys(BUILTIN_MODULE_CONSTS[module] ?? {})) {
      const value = builtinModuleConstOf(lowerer, module, member);
      if (value !== undefined) add(member, builtinConstLit(value, loc));
    }
    if (module.startsWith("path/")) {
      add("posix", moduleValue(lowerer, "path/posix", loc));
      add("win32", moduleValue(lowerer, "path/win32", loc));
    }
    if (module === "worker_threads") {
      add("isInternalThread", { kind: "boolLit", value: false, type: BOOL, loc });
      add("parentPort", { kind: "unitLit", unit: "null", type: NULL_T, loc });
      add("workerData", { kind: "unitLit", unit: "null", type: NULL_T, loc });
    }
    body.push({ kind: "return", value: {
      kind: "libCall", fn: "process.builtinUnsupported", args: [strLit(module, loc), key], type: DYN, loc,
    }, loc });
    lowerer.liftedFns.push({
      name, params: [{ localId: "key", name: "key", type: STRING }], returnType: DYN,
      locals: [{ id: "key", name: "key", type: STRING, mutable: false }], body, loc,
    });
  }
  const getter: IrExpr = { kind: "closure", fnName: name, captures: [], type: { kind: "func", params: [STRING], ret: DYN }, loc };
  return { kind: "libCall", fn: "process.builtinModule", args: [strLit(module, loc), box(getter)], type: DYN, loc };
}

/** A first-class loader uses the same native functions as direct imports.
 * Module handles cache values and preserve aliases without a JS engine. */
export function lowerBuiltinLoaderValue(lowerer: Lowerer, loc: SrcLoc): IrExpr {
  const cacheKey = "%builtin.process.getBuiltinModule";
  let name = lowerer.builtinCallableValueFns.get(cacheKey);
  if (!name) {
    name = cacheKey;
    lowerer.builtinCallableValueFns.set(cacheKey, name);
    const id = varRef("id", STRING, loc);
    const body: IrStmt[] = [{ kind: "varDecl", localId: "id", init: {
      kind: "libCall", fn: "process.builtinId", args: [varRef("input", DYN, loc), builtinModulesArrayLit(loc)], type: STRING, loc,
    }, loc }];
    const add = (specifier: string, value: IrExpr): void => {
      body.push({
        kind: "if", cond: { kind: "strEq", negated: false, left: id, right: strLit(specifier, loc), type: BOOL, loc },
        then: [{ kind: "return", value, loc }], else_: null, loc,
      });
    };
    add("", box({ kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc }));
    // path's default is the target platform's implementation, including identity.
    const pathModule = builtinModuleConstOf(lowerer, "path", "sep") === "\\" ? "path/win32" : "path/posix";
    add("path", moduleValue(lowerer, pathModule, loc));
    for (const module of MODULES) add(module, moduleValue(lowerer, module, loc));
    body.push({ kind: "return", value: {
      kind: "libCall", fn: "process.builtinUnsupported", args: [id, strLit("", loc)], type: DYN, loc,
    }, loc });
    lowerer.liftedFns.push({
      name, params: [{ localId: "input", name: "id", type: DYN }], returnType: DYN,
      locals: [{ id: "input", name: "id", type: DYN, mutable: false }, { id: "id", name: "module", type: STRING, mutable: false }], body, loc,
    });
  }
  return { kind: "closure", fnName: name, captures: [], type: { kind: "func", params: [DYN], ret: DYN }, loc };
}
