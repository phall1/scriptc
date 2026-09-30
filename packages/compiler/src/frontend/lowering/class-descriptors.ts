import * as ts from "../ts7/adapter.js";
import { DYN, type IrExpr, type IrStmt, isDynTypedRefType } from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import type { ClassInfo } from "./lower-classes.js";
import { isCompiledPrototypeMember } from "./class-prototypes.js";
import { classPropertiesHelper } from "./class-dynamic-dispatch.js";

function literalName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
}

/** Native layout fields cannot change descriptors. New named data properties
 * live in the instance's shared bag, preserving attributes and identity. */
export function lowerClassDataDescriptor(lowerer: Lowerer, call: ts.CallExpression, member: string, target: IrExpr): IrExpr | null {
  if (!isDynTypedRefType(target.type)) return null;
  const info = lowerer.classes.get(target.type.className);
  if (!info || info.def.runtime || info.builtinError || info.builtinEmitter || info.builtinStream) return null;
  const safeName = (owner: ClassInfo, name: string): boolean =>
    !owner.fields.has(name) && !isCompiledPrototypeMember(lowerer, owner, name) &&
    owner.subclasses.every((child) => safeName(child, name));
  const descriptor = (node: ts.Expression): boolean => ts.isObjectLiteralExpression(node) &&
    node.properties.every((p) => ts.isPropertyAssignment(p) &&
      ["value", "writable", "enumerable", "configurable"].includes(literalName(p.name) ?? ""));
  const descriptors = call.arguments[member === "defineProperty" ? 2 : 1]!;
  if (member === "defineProperty") {
    const key = call.arguments[1]!;
    if (!ts.isStringLiteral(key) || !safeName(info, key.text) || !descriptor(descriptors)) return null;
  } else {
    if (!ts.isObjectLiteralExpression(descriptors) || !descriptors.properties.every((p) => {
      if (!ts.isPropertyAssignment(p)) return false;
      const name = literalName(p.name);
      return name !== null && name !== "__proto__" && safeName(info, name) && descriptor(p.initializer);
    })) return null;
  }
  const loc = locOf(call);
  const receiver = lowerer.declareHiddenLocal("%descriptorReceiver", target.type);
  const desc = lowerer.declareHiddenLocal("%descriptors", DYN);
  const value = varRef(receiver.id, target.type, loc);
  const boxed = lowerer.coerceToExpected(value, DYN);
  const helper = classPropertiesHelper(lowerer, loc);
  const bag: IrExpr = { kind: "call", callee: helper.name, args: [boxed], type: DYN, loc };
  const args = member === "defineProperty"
    ? [bag, lowerer.lowerExprExpecting(call.arguments[1]!, DYN), varRef(desc.id, DYN, loc)]
    : [bag, varRef(desc.id, DYN, loc)];
  const stmts: IrStmt[] = [
    { kind: "varDecl", localId: receiver.id, init: target, loc },
    { kind: "varDecl", localId: desc.id, init: lowerer.lowerExprExpecting(descriptors, DYN), loc },
    { kind: "exprStmt", expr: { kind: "libCall", fn: member === "defineProperty" ? "dyn.defineProperty" : "dyn.defineProps", args, type: DYN, loc }, loc },
  ];
  return { kind: "seqExpr", stmts, result: value, type: value.type, loc };
}
