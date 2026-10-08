import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { stdlibGlobalNameOf } from "./surfaces.js";
import { BOOL, DYN, STRING, VOID, type IrExpr, type IrLibFn, type SrcLoc } from "../../ir/ir.js";
import { nodeThrowExpr, varRef } from "../../ir/build.js";

/** Compile-time provenance, never recovered from the runtime identity token. */
export type BuiltinConstructorIdentity = "URL" | "URLSearchParams" | "RegExp";

export function builtinConstructorScope(
  previous: Map<ts.Symbol, BuiltinConstructorIdentity> | null,
  current: Map<ts.Symbol, BuiltinConstructorIdentity> | undefined,
  shadowed: readonly (ts.Symbol | null)[] = [],
): Map<ts.Symbol, BuiltinConstructorIdentity> | null {
  if (!current && shadowed.length === 0) return previous;
  const scope = new Map(previous ?? []);
  // Default/dynamic instances must not inherit a prior recursion's own
  // parameter identity merely because the AST symbol is shared.
  for (const symbol of shadowed) if (symbol) scope.delete(symbol);
  for (const [symbol, identity] of current ?? []) scope.set(symbol, identity);
  return scope;
}

const brandTests: Record<BuiltinConstructorIdentity, IrLibFn> = {
  URL: "dyn.nativeUrlIs",
  URLSearchParams: "dyn.nativeSearchParamsIs",
  RegExp: "dyn.nativeRegexIs",
};

/** Direct existing brands retain their current paths; new snapshots share native predicates. */
export function lowerBuiltinConstructorInstanceOf(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  loc: SrcLoc,
): IrExpr | null {
  const direct = directIdentity(lowerer, expr.right);
  const proven = builtinConstructorIdentityOf(lowerer, expr.right);
  const identity = direct === "URL" || direct === "RegExp" ? null : proven;
  if (!identity) return null;
  // instanceof evaluates LHS once, then reads RHS, even when its brand is proven.
  const left = lowerer.lowerExpr(expr.left);
  const slot = lowerer.declareHiddenLocal("%nativeInstance", left.type);
  const read = lowerConstructorRead(lowerer, expr.right, loc);
  const value = lowerer.coerceInto(expr.left, varRef(slot.id, slot.type, loc), DYN);
  const result: IrExpr = {
    kind: "libCall",
    fn: brandTests[identity],
    args: [value],
    type: BOOL,
    loc,
  };
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: slot.id, init: left, loc },
      { kind: "exprStmt", expr: read, loc },
      {
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "dyn.nativeInstanceOfOperand",
          args: [value],
          type: VOID,
          loc,
        },
        loc,
      },
    ],
    result,
    type: BOOL,
    loc,
  };
}

function containingFunctionOf(expr: ts.Node): ts.Node | null {
  let node: ts.Node | undefined = expr.parent;
  while (node) {
    if (ts.isFunctionLike(node)) return node;
    node = node.parent;
  }
  return null;
}

function uninitializedConstructorReference(lowerer: Lowerer, expr: ts.Identifier): boolean {
  if (lowerer.peekLocal(expr)) return false;
  const symbol = lowerer.checker.getSymbolAtLocation(expr);
  const declaration = symbol ? lowerer.checker.valueDeclarationOf(symbol) : undefined;
  if (!declaration) return false;
  const owner = containingFunctionOf(expr);
  if (!owner) return false;
  if (ts.isParameter(declaration)) return owner === declaration.parent;
  if (!ts.isVariableDeclaration(declaration)) return false;
  return owner === containingFunctionOf(declaration) && expr.getStart() < declaration.getStart();
}

function lowerConstructorRead(lowerer: Lowerer, expr: ts.Expression, loc: SrcLoc): IrExpr {
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  // declareParams binds left-to-right. A later ABI argument exists, but
  // its source binding is still in TDZ in this function's earlier default.
  // Same-function forward const reads also precede initialization; nested
  // closures instead retain the existing live TDZ-box/capture machinery.
  if (ts.isIdentifier(expr) && uninitializedConstructorReference(lowerer, expr))
    return nodeThrowExpr(5, "", `Cannot access '${expr.text}' before initialization`, DYN, loc);
  return lowerer.lowerExpr(expr);
}

function supportedIdentity(name: string | null): BuiltinConstructorIdentity | null {
  return name === "URL" || name === "URLSearchParams" || name === "RegExp" ? name : null;
}

function directIdentity(lowerer: Lowerer, expr: ts.Expression): BuiltinConstructorIdentity | null {
  const global = supportedIdentity(stdlibGlobalNameOf(lowerer, expr));
  if (global) return global;
  const imported = ts.isIdentifier(expr)
    ? lowerer.builtinImportOf(expr)
    : ts.isPropertyAccessExpression(expr)
      ? lowerer.builtinMemberOf(expr)
      : null;
  return imported?.module === "url" ? supportedIdentity(imported.member) : null;
}

/** Direct native constructor values are functions, never forgeable primitive tokens. */
export function lowerBuiltinConstructorValue(
  lowerer: Lowerer,
  expr: ts.Expression,
  loc: SrcLoc,
): IrExpr | null {
  if (lowerer.dynamic) return null;
  if (!ts.isIdentifier(expr) && !ts.isPropertyAccessExpression(expr)) return null;
  const name = ts.isIdentifier(expr) ? expr : expr.name;
  const symbol = lowerer.checker.getSymbolAtLocation(name);
  // Const aliases must read their own live slot (and TDZ), not recreate
  // the global merely because alias analysis knows their identity.
  if (!lowerer.isStdlibSymbol(symbol)) {
    const imported = ts.isIdentifier(expr)
      ? lowerer.builtinImportOf(expr)
      : lowerer.builtinMemberOf(expr);
    if (imported?.module !== "url") return null;
  }
  const identity = directIdentity(lowerer, expr);
  if (!identity) return null;
  return {
    kind: "libCall",
    fn: "dyn.nativeConstructor",
    args: [{ kind: "strLit", value: identity, type: STRING, loc }],
    type: DYN,
    loc,
  };
}

/** Only never-written specialized parameters can replace an instanceof RHS. */
export function specializedConstructorIdentity(
  lowerer: Lowerer,
  expr: ts.Expression,
): BuiltinConstructorIdentity | null {
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (!ts.isIdentifier(expr)) return null;
  const symbol = lowerer.checker.getSymbolAtLocation(expr);
  return symbol ? (lowerer.implicitBuiltinConstructors?.get(symbol) ?? null) : null;
}

function constInitializer(lowerer: Lowerer, expr: ts.Expression): ts.Expression | null {
  if (!ts.isIdentifier(expr)) return null;
  const symbol = lowerer.checker.getSymbolAtLocation(expr);
  const decl = symbol ? lowerer.checker.valueDeclarationOf(symbol) : undefined;
  if (!decl || !ts.isVariableDeclaration(decl)) return null;
  if ((ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) === 0) return null;
  return decl.initializer ?? null;
}

/** Stable argument snapshots and forwarding retain identity; argument evaluation still runs. */
export function builtinConstructorIdentityOf(
  lowerer: Lowerer,
  expr: ts.Expression,
  seen = new Set<ts.Node>(),
): BuiltinConstructorIdentity | null {
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (seen.has(expr)) return null;
  seen.add(expr);
  const identity = directIdentity(lowerer, expr) ?? specializedConstructorIdentity(lowerer, expr);
  if (identity) return identity;
  const initializer = constInitializer(lowerer, expr);
  return initializer ? builtinConstructorIdentityOf(lowerer, initializer, seen) : null;
}
