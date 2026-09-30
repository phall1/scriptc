import * as ts from "../ts7/adapter.js";
import { BOOL, DYN, STRING, type IrExpr, type IrFunction, type SrcLoc } from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import { locOf } from "../program.js";
import { exactClassOfReceiver, findGenericMethodOn, findMethodOn, type ClassInfo } from "./lower-classes.js";
import { compiledMethodValue } from "./class-method-values.js";
import type { Lowerer } from "./lowerer.js";

/** Data added to a top-level class prototype has shared identity and remains
 * separate from instance fields. Allocate lazily so inheritance and module
 * initialization order do not require hoisting source assignments. */
export function classPrototypeData(lowerer: Lowerer, info: ClassInfo, loc: SrcLoc): IrExpr | null {
  if (info.localClass || info.mixinInstance || info.generic || info.genericInstance || info.def.runtime || info.builtinEmitter || info.builtinStream || info.builtinError) return null;
  if (info.def.prototypeDataHelper === undefined) {
    const base = info.base ? classPrototypeData(lowerer, info.base, loc) : null;
    if (info.base && base === null) return null;
    const name = `%prototype.data.${info.def.name}`;
    const globalId = `%g.${name}`;
    const readyId = `${globalId}.ready`;
    info.def.prototypeDataHelper = name;
    const className = info.def.jsName ?? info.def.name;
    lowerer.globalsList.push({ id: globalId, name: `${className}.prototype`, type: DYN, mutable: true });
    lowerer.globalsList.push({ id: readyId, name: `${className}.prototype.ready`, type: BOOL, mutable: true });
    const value = varRef(globalId, DYN, loc);
    const helper: IrFunction = {
      name, params: [], returnType: DYN, locals: [], loc,
      body: [
        { kind: "if", cond: { kind: "unary", op: "!", operand: varRef(readyId, BOOL, loc), type: BOOL, loc }, then: [
          { kind: "assign", localId: globalId, value: base
            ? { kind: "libCall", fn: "dyn.objCreate", args: [base], type: DYN, loc }
            : { kind: "dynObjLit", fields: [], type: DYN, loc }, loc },
          { kind: "assign", localId: readyId, value: { kind: "boolLit", value: true, type: BOOL, loc }, loc },
        ], else_: null, loc },
        { kind: "return", value, loc },
      ],
    };
    // Materialize only observed method slots. Own declarations stop lookup
    // at the correct prototype even if an ancestor is replaced later.
    for (const [method, access] of lowerer.prototypeMethodAccesses) {
      if (!info.methods.has(method) || method.startsWith("get:") || method.startsWith("set:")) continue;
      const compiled = compiledMethodValue(lowerer, info, method, access, locOf(access));
      if (!compiled) continue;
      const descriptor: IrExpr = { kind: "dynObjLit", fields: [
        { key: { kind: "strLit", value: "value", type: STRING, loc }, value: lowerer.coerceToExpected(compiled, DYN) },
        { key: { kind: "strLit", value: "writable", type: STRING, loc }, value: lowerer.coerceToExpected({ kind: "boolLit", value: true, type: BOOL, loc }, DYN) },
        { key: { kind: "strLit", value: "configurable", type: STRING, loc }, value: lowerer.coerceToExpected({ kind: "boolLit", value: true, type: BOOL, loc }, DYN) },
      ], type: DYN, loc };
      const init = helper.body[0]!;
      if (init.kind === "if") init.then.push({ kind: "exprStmt", expr: { kind: "libCall", fn: "dyn.defineProperty", args: [value,
        lowerer.coerceToExpected({ kind: "strLit", value: method, type: STRING, loc }, DYN), descriptor], type: DYN, loc }, loc });
    }
    lowerer.liftedFns.push(helper);
  }
  return { kind: "call", callee: info.def.prototypeDataHelper, args: [], type: DYN, loc };
}

export function hasClassPrototypeData(info: ClassInfo): boolean {
  return info.def.prototypeDataHelper !== undefined || (info.base !== null && hasClassPrototypeData(info.base));
}

export function isCompiledPrototypeMember(lowerer: Lowerer, info: ClassInfo, name: string): boolean {
  return name === "constructor" || name === "__proto__" ||
    !!findMethodOn(lowerer, info, name) || !!findGenericMethodOn(lowerer, info, name) ||
    !!findMethodOn(lowerer, info, `get:${name}`) || !!findMethodOn(lowerer, info, `set:${name}`);
}

/** Named data and method slots have native descriptors. Bare reflection and
 * accessor replacement still require a complete view of the prototype. */
export function lowerClassPrototypeData(lowerer: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
  if (expr.questionDotToken || expr.name.text !== "prototype") return null;
  const info = exactClassOfReceiver(lowerer, expr.expression);
  if (!info) return null;
  const parent = expr.parent;
  const name = ts.isPropertyAccessExpression(parent) && parent.expression === expr ? parent.name.text
    : ts.isElementAccessExpression(parent) && parent.expression === expr && parent.argumentExpression && ts.isStringLiteral(parent.argumentExpression)
      ? parent.argumentExpression.text : null;
  const method = name !== null && lowerer.prototypeMethodAccesses.has(name) && findMethodOn(lowerer, info, name);
  if (name === null || isCompiledPrototypeMember(lowerer, info, name) && !method) {
    lowerer.unsupported("SC1090", expr, "class prototype reflection and accessor replacement (named prototype data and methods compile)");
  }
  const value = classPrototypeData(lowerer, info, locOf(expr));
  if (value === null) lowerer.unsupported("SC1090", expr, "prototype data on local, generic, mixin, or runtime-provided classes");
  return value;
}
