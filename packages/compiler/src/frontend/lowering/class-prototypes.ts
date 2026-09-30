import * as ts from "../ts7/adapter.js";
import { BOOL, DYN, type IrExpr, type IrFunction, type SrcLoc } from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import { locOf } from "../program.js";
import { exactClassOfReceiver, findGenericMethodOn, findMethodOn, type ClassInfo } from "./lower-classes.js";
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

/** Compiled methods still live in vtables. Keep prototype reflection and
 * method replacement fenced until those descriptors have a native view. */
export function lowerClassPrototypeData(lowerer: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
  if (expr.questionDotToken || expr.name.text !== "prototype") return null;
  const info = exactClassOfReceiver(lowerer, expr.expression);
  if (!info) return null;
  const parent = expr.parent;
  const name = ts.isPropertyAccessExpression(parent) && parent.expression === expr ? parent.name.text
    : ts.isElementAccessExpression(parent) && parent.expression === expr && parent.argumentExpression && ts.isStringLiteral(parent.argumentExpression)
      ? parent.argumentExpression.text : null;
  if (name === null || isCompiledPrototypeMember(lowerer, info, name)) {
    lowerer.unsupported("SC1090", expr, "class prototype reflection and compiled method replacement (named prototype data properties compile)");
  }
  const value = classPrototypeData(lowerer, info, locOf(expr));
  if (value === null) lowerer.unsupported("SC1090", expr, "prototype data on local, generic, mixin, or runtime-provided classes");
  return value;
}
