import * as ts from "../ts7/adapter.js";
import type { IrExpr } from "../../ir/ir.js";
import { isJsSourceFile, locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import { bindingNeverReassigned, type FnSig } from "./lower-calls.js";

/** An ordinary constructor's explicit object return replaces its receiver.
 * Without observing this or new.target, it can use the function's call ABI. */
export function objectFactorySignature(lowerer: Lowerer, expr: ts.NewExpression): FnSig | null {
  if (!ts.isIdentifier(expr.expression) || lowerer.peekLocal(expr.expression)) return null;
  // This probe also sees ordinary classes during global collection. Leave
  // their deferred diagnostics for the class declaration's lowering.
  const wasCollecting = lowerer.collecting;
  let symbol: ts.Symbol | null = null;
  lowerer.collecting = true;
  try {
    if (!lowerer.isTopLevelFnSymbol(expr.expression)) return null;
    symbol = lowerer.resolveValueSymbol(expr.expression);
  } finally {
    lowerer.collecting = wasCollecting;
  }
  if (!symbol) return null;
  const declaration = lowerer.checker.declarationsOf(symbol).find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.body !== undefined,
  );
  if (!declaration?.body || !bindingNeverReassigned(lowerer, symbol, declaration) || !isJsSourceFile(declaration.getSourceFile()) || declaration.asteriskToken ||
      declaration.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return null;
  const last = declaration.body.statements.at(-1);
  if (!last || !ts.isReturnStatement(last) || !last.expression || !ts.isObjectLiteralExpression(last.expression)) return null;
  let safe = true;
  const visit = (node: ts.Node, nestedArrow = false): void => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) { safe = false; return; }
    if (ts.isFunctionLike(node)) {
      if (!ts.isArrowFunction(node)) return;
      nestedArrow = true;
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword || ts.isMetaProperty(node)) safe = false;
    if (!nestedArrow && ts.isReturnStatement(node) && (!node.expression || !ts.isObjectLiteralExpression(node.expression))) safe = false;
    ts.forEachChild(node, (child) => visit(child, nestedArrow));
  };
  for (const parameter of declaration.parameters) visit(parameter);
  visit(declaration.body);
  if (!safe) return null;
  const signature = lowerer.fnSigOf(expr.expression);
  return signature && signature.returnType.kind !== "void" ? signature : null;
}

export function lowerObjectFactoryNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  const signature = objectFactorySignature(lowerer, expr);
  if (!signature) return null;
  const loc = locOf(expr);
  lowerer.noteEdge(signature.name);
  return {
    kind: "call", callee: signature.name,
    args: lowerer.completeArgs(expr.arguments ?? [], signature.params, loc, expr),
    type: signature.returnType, loc,
  };
}
