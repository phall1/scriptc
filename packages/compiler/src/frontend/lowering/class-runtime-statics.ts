import * as ts from "../ts7/adapter.js";
import { BOOL, DYN, STRING, type IrExpr, type IrStmt } from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import { locOf } from "../program.js";
import { dynUndefinedExpr, type Lowerer } from "./lowerer.js";
import type { ClassInfo } from "./lower-classes.js";
import { classPrototypeData } from "./class-prototypes.js";

export function hasRuntimeStatics(info: ClassInfo): boolean {
  for (let current: ClassInfo | null = info; current; current = current.base) {
    if (current.runtimeStatics !== undefined) return true;
  }
  return false;
}

/** Factory evaluations own their static fields and closures. Defining them
 * on the constructor preserves inherited getter receivers and independent
 * state when one factory is called repeatedly. */
export function initializeRuntimeStatics(lowerer: Lowerer, info: ClassInfo, value: IrExpr): IrExpr {
  if (!info.runtimeStatics && !info.runtimePrototypeMembers) return value;
  const loc = value.loc;
  const local = lowerer.declareHiddenLocal("%staticClass", value.type);
  const receiver = varRef(local.id, value.type, loc);
  const boxed = lowerer.coerceToExpected(receiver, DYN);
  const statements: IrStmt[] = [
    { kind: "varDecl", localId: local.id, init: value, loc },
    { kind: "exprStmt", expr: { kind: "libCall", fn: "dyn.classInherit", args: [boxed, dynUndefinedExpr(loc)], type: DYN, loc }, loc },
  ];
  const previousThis = lowerer.ctx.thisLocal;
  lowerer.ctx.thisLocal = local;
  try {
    for (const member of [...(info.runtimeStatics ?? []), ...(info.runtimePrototypeMembers ?? [])]) {
      if (ts.isClassStaticBlockDeclaration(member)) {
        statements.push(...lowerer.lowerStmts(member.body.statements));
        continue;
      }
      if (!member.name) continue;
      const memberLoc = locOf(member);
      const key: IrExpr = ts.isComputedPropertyName(member.name)
        ? lowerer.lowerExprExpecting(member.name.expression, DYN)
        : lowerer.coerceToExpected({ kind: "strLit", value: member.name.text!, type: STRING, loc: memberLoc }, DYN);
      const fields: { key: string; value: IrExpr }[] = [
        { key: "configurable", value: lowerer.coerceToExpected({ kind: "boolLit", value: true, type: BOOL, loc: memberLoc }, DYN) },
        { key: "enumerable", value: lowerer.coerceToExpected({ kind: "boolLit", value: ts.isPropertyDeclaration(member), type: BOOL, loc: memberLoc }, DYN) },
      ];
      if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
        fields.push({ key: ts.isGetAccessorDeclaration(member) ? "get" : "set", value: lowerer.coerceToExpected(lowerer.lowerLambda(member), DYN) });
      } else if (ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member)) {
        fields.push({ key: "writable", value: lowerer.coerceToExpected({ kind: "boolLit", value: true, type: BOOL, loc: memberLoc }, DYN) });
        fields.push({ key: "value", value: ts.isMethodDeclaration(member)
          ? lowerer.coerceToExpected(lowerer.lowerLambda(member), DYN)
          : member.initializer ? lowerer.lowerExprExpecting(member.initializer, DYN) : dynUndefinedExpr(memberLoc) });
      }
      const target = info.runtimePrototypeMembers?.includes(member) ? classPrototypeData(lowerer, info, memberLoc, receiver)! : boxed;
      statements.push({ kind: "exprStmt", expr: { kind: "libCall", fn: "dyn.defineProperty", args: [target, key,
        { kind: "dynObjLit", fields: fields.map((field) => ({ key: { kind: "strLit", value: field.key, type: STRING, loc: memberLoc }, value: field.value })), type: DYN, loc: memberLoc },
      ], type: DYN, loc: memberLoc }, loc: memberLoc });
    }
  } finally {
    lowerer.ctx.thisLocal = previousThis;
  }
  return { kind: "seqExpr", stmts: statements, result: receiver, type: receiver.type, loc };
}
