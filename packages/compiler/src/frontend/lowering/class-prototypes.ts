import * as ts from "../ts7/adapter.js";
import { BOOL, DYN, STRING, SYMBOL_T, type IrExpr, type IrFunction, type SrcLoc } from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import { locOf } from "../program.js";
import { exactClassOfReceiver, findGenericMethodOn, findMethodOn, type ClassInfo } from "./lower-classes.js";
import { classMethodValue } from "./class-method-values.js";
import type { Lowerer } from "./lowerer.js";
import { dynUndefinedExpr } from "./lowerer.js";

/** Data added to a top-level class prototype has shared identity and remains
 * separate from instance fields. Allocate lazily so inheritance and module
 * initialization order do not require hoisting source assignments. */
export function classPrototypeData(lowerer: Lowerer, info: ClassInfo, loc: SrcLoc, receiver?: IrExpr): IrExpr | null {
  if (info.localClass) {
    if (!receiver) return null;
    info.localPrototypeData = true;
    const value: IrExpr = receiver.type.kind === "classval" ? receiver : {
      kind: "fieldGet", obj: receiver, className: info.def.name, field: `%classEnvironment:${info.def.name}`,
      type: { kind: "classval", className: info.def.name }, loc,
    };
    const base = info.callableBase ? varRef(info.callableBase.prototypeId, DYN, loc)
      : info.base && !info.base.builtinError ? classPrototypeData(lowerer, info.base, loc) : null;
    return { kind: "libCall", fn: "dyn.classPrototype", args: [
      { kind: "dynFrom", value, type: DYN, loc }, base ?? dynUndefinedExpr(loc),
    ], type: DYN, loc };
  }
  if (info.mixinInstance || info.generic || info.genericInstance || info.def.runtime || info.builtinEmitter || info.builtinStream || info.builtinError) return null;
  if (info.def.prototypeDataHelper === undefined) {
    const base = info.callableBase ? varRef(info.callableBase.prototypeId, DYN, loc)
      : info.base && !info.base.builtinError ? classPrototypeData(lowerer, info.base, loc) : null;
    if (info.base && !info.base.builtinError && base === null) return null;
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
      const compiled = classMethodValue(lowerer, access, info, method, locOf(access));
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
  return info.callableBase !== undefined || info.localPrototypeData === true || info.def.prototypeDataHelper !== undefined || (info.base !== null && hasClassPrototypeData(info.base));
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
  const value = classPrototypeData(lowerer, info, locOf(expr), info.localClass ? lowerer.lowerExpr(expr.expression) : undefined);
  if (value === null) lowerer.unsupported("SC1090", expr, "prototype data on local, generic, mixin, or runtime-provided classes");
  return value;
}

/** Object.assign may add data without exposing an incomplete prototype view.
 * The runtime refuses replacement of compiled members at the individual Set. */
export function lowerClassPrototypeAssign(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  const target = call.arguments[0];
  if (!target || !ts.isPropertyAccessExpression(target) || target.name.text !== "prototype") return null;
  const info = exactClassOfReceiver(lowerer, target.expression);
  if (!info) return null;
  if (!ts.isExpressionStatement(call.parent) || call.arguments.some(ts.isSpreadElement)) {
    lowerer.unsupported("SC1090", call, "class prototype assignment results and spread arguments");
  }
  const loc = locOf(call);
  const value = classPrototypeData(lowerer, info, loc, info.localClass ? lowerer.lowerExpr(target.expression) : undefined);
  if (!value) lowerer.unsupported("SC1090", target, "prototype data on generic, mixin, or runtime-provided classes");
  const keys: IrExpr[] = ["constructor", "__proto__"].map((name) => ({ kind: "strLit", value: name, type: STRING, loc }));
  for (let owner: ClassInfo | null = info; owner; owner = owner.base) {
    const methodNames = new Set([...owner.methods.keys()]);
    if (owner.genericMethods) for (const name of [...owner.genericMethods.keys()]) methodNames.add(name);
    for (const name of methodNames) {
      if (name.startsWith("#")) continue;
      // Error.toString uses checked native dispatch, including prototype
      // additions. A user-declared method remains protected below.
      if (owner.builtinError && name === "toString") continue;
      if (name.startsWith("sym:")) {
        keys.push({ kind: "libCall", fn: "sym.wellKnown", args: [{ kind: "strLit", value: name.slice(4), type: STRING, loc }], type: SYMBOL_T, loc });
      } else if (name.startsWith("%symbol:")) {
        const entries: [ts.Symbol, string][] = owner.symbolMethods ? [...owner.symbolMethods] : [];
        const entry = entries.find(([, field]) => field === name);
        const declaration = entry ? lowerer.checker.valueDeclarationOf(entry[0]) : undefined;
        if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) lowerer.unsupported("SC1090", target, "prototype mutation with unresolved symbol methods");
        keys.push(lowerer.lowerExpr(declaration.name));
      } else keys.push({ kind: "strLit", value: name.replace(/^(get|set):/, ""), type: STRING, loc });
    }
  }
  const sources = call.arguments.slice(1).map((node) => lowerer.lowerExprExpecting(node, DYN));
  return { kind: "libCall", fn: "dyn.assignPrototype", args: [value,
    { kind: "dynArrLit", elems: sources, type: DYN, loc },
    { kind: "dynArrLit", elems: keys.map((key) => key.type.kind === "dyn" ? key : { kind: "dynFrom", value: key, type: DYN, loc }), type: DYN, loc },
  ], type: DYN, loc };
}
