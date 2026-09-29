import { DYN, VOID, ffiClassType, ffiSourceParamTypes, funcOf, isFfiCallbackParam, type IrExpr, type IrLocal, type SrcLoc } from "../../ir/ir.js";
import { strLit, varRef } from "../../ir/build.js";
import type { Lowerer } from "./lowerer.js";

/** Compile node:ffi's library catalog into ordinary native closures. No
 * runtime resolver, executable code generation, or engine is involved. */
export function lowerFfiMemoryModule(lowerer: Lowerer, loc: SrcLoc): IrExpr {
  const text = (value: string): IrExpr => ({ kind: "dynFrom", value: strLit(value, loc), type: DYN, loc });
  const object = (fields: Record<string, IrExpr>): IrExpr => ({
    kind: "dynObjLit", fields: Object.entries(fields).map(([key, value]) => ({ key: strLit(key, loc), value })), type: DYN, loc,
  });
  const entries = lowerer.ffiImports.filter(entry => entry.library !== undefined).map(entry => {
    const name = `%ffi.module.${lowerer.lambdaCounter++}`;
    const sourceTypes = ffiSourceParamTypes(entry.params);
    const locals: IrLocal[] = sourceTypes.map((_, i) => ({ id: `%arg${i}`, name: `arg${i}`, type: DYN, mutable: false }));
    const args: IrExpr[] = entry.params.map((param, i) => ({
      kind: "dynCheck", type: sourceTypes[i]!, loc,
      value: typeof param === "string"
        ? { kind: "libCall", fn: "ffi.argument", args: [varRef(locals[i]!.id, DYN, loc), strLit(param, loc)], type: DYN, loc }
        : varRef(locals[i]!.id, DYN, loc),
    }));
    const resultType = ffiClassType(entry.returns);
    const call: IrExpr = { kind: "ffiCall", import: entry.name, args, type: resultType, loc };
    lowerer.liftedFns.push({
      name, params: locals.map(local => ({ localId: local.id, name: local.name, type: DYN })),
      locals, returnType: resultType.kind === "void" ? VOID : DYN,
      body: resultType.kind === "void"
        ? [{ kind: "exprStmt", expr: call, loc }, { kind: "return", value: null, loc }]
        : [{ kind: "return", value: { kind: "dynFrom", value: call, type: DYN, loc }, loc }], loc,
    });
    const closure: IrExpr = { kind: "closure", fnName: name, captures: [], type: funcOf(locals.map(() => DYN), resultType.kind === "void" ? VOID : DYN), loc };
    const callback = entry.params.find(param => isFfiCallbackParam(param))?.callback;
    return object({
      library: text(entry.library!), name: text(entry.name),
      operation: text(entry.callbackOperation ?? "call"), target: text(entry.callbackTarget ?? ""),
      arguments: { kind: "dynArrLit", elems: (callback?.params ?? entry.params).map(param => text(param as string)), type: DYN, loc },
      return: text(callback?.returns ?? entry.returns), call: { kind: "dynFrom", value: closure, type: DYN, loc },
    });
  });
  return { kind: "libCall", fn: "ffi.memoryModule", args: [{ kind: "dynArrLit", elems: entries, type: DYN, loc }], type: DYN, loc };
}
