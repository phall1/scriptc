import * as ts from "./ts7/adapter.js";

/** JavaScript documentation does not enforce an explicit return. Keep
 * implicit completion even when the documented result omits undefined. */
export function functionCanFallThrough(declaration: ts.Node): boolean {
  if (
    !ts.isFunctionLike(declaration) ||
    declaration.asteriskToken ||
    declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  )
    return false;
  const body = declaration.body as ts.Block | ts.Expression | undefined;
  if (!body || !ts.isBlock(body)) return false;
  const completes = (statement: ts.Statement): boolean => {
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return false;
    if (ts.isBlock(statement)) return sequence(statement.statements);
    if (ts.isLabeledStatement(statement)) return completes(statement.statement);
    if (ts.isIfStatement(statement))
      return (
        completes(statement.thenStatement) ||
        !statement.elseStatement ||
        completes(statement.elseStatement)
      );
    if (ts.isTryStatement(statement)) {
      if (statement.finallyBlock && !completes(statement.finallyBlock)) return false;
      return (
        completes(statement.tryBlock) ||
        (!!statement.catchClause && completes(statement.catchClause.block))
      );
    }
    if (ts.isSwitchStatement(statement))
      return (
        !statement.caseBlock.clauses.some(ts.isDefaultClause) ||
        statement.caseBlock.clauses.some((clause) => sequence(clause.statements))
      );
    // `while (true)` and `for (;;)` never resume after the loop unless a
    // break leaves it. A do-while that always returns or throws never
    // reaches its condition either. Treating those as fall-through made
    // `uvarintBig()`'s bigint a `bigint | undefined` and fenced `code >> 1n`.
    if (ts.isDoStatement(statement)) {
      if (breakLeavesLoop(statement)) return true;
      if (!completes(statement.statement)) return false;
      if (isConstantTrue(statement.expression)) return false;
      return true;
    }
    if (
      (ts.isWhileStatement(statement) || ts.isForStatement(statement)) &&
      infiniteLoop(statement) &&
      !breakLeavesLoop(statement)
    )
      return false;
    return true;
  };
  const sequence = (statements: readonly ts.Statement[]): boolean => statements.every(completes);
  return sequence(body.statements);
}

/** A documented JavaScript result must also represent explicit empty returns. */
export function functionCanReturnUndefined(declaration: ts.Node): boolean {
  if (functionCanFallThrough(declaration)) return true;
  if (
    !ts.isFunctionLike(declaration) ||
    declaration.asteriskToken ||
    declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  )
    return false;
  const body = declaration.body;
  if (!body) return false;
  let emptyReturn = false;
  ts.walkPreorder(body, (node) => {
    if (node !== body && ts.isFunctionLike(node)) return "skip";
    if (ts.isReturnStatement(node) && (!node.expression || ts.isVoidExpression(node.expression)))
      emptyReturn = true;
  });
  return emptyReturn;
}

function isIterationStatement(node: ts.Node): boolean {
  return (
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node)
  );
}

function isConstantTrue(expression: ts.Expression): boolean {
  let current: ts.Expression = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current.kind === ts.SyntaxKind.TrueKeyword;
}

function infiniteLoop(statement: ts.WhileStatement | ts.ForStatement | ts.DoStatement): boolean {
  if (ts.isForStatement(statement))
    return statement.condition === undefined || isConstantTrue(statement.condition);
  return isConstantTrue(statement.expression);
}

/** True when some `break` transfers control to just after `loop`. */
function breakLeavesLoop(loop: ts.Node): boolean {
  let leaves = false;
  const visit = (node: ts.Node, nestedBreakable: boolean): void => {
    if (leaves) return;
    if (node !== loop && ts.isFunctionLike(node)) return;
    if (node !== loop && (isIterationStatement(node) || ts.isSwitchStatement(node))) {
      ts.forEachChild(node, (child) => visit(child, true));
      return;
    }
    if (ts.isBreakStatement(node)) {
      const label = node.label?.text;
      if (label === undefined) {
        if (!nestedBreakable) leaves = true;
        return;
      }
      if (labelTargetEnclosesLoop(node, label, loop)) leaves = true;
      return;
    }
    ts.forEachChild(node, (child) => visit(child, nestedBreakable));
  };
  visit(loop, false);
  return leaves;
}

/** The named label wraps `loop` or sits outside it, so breaking to it
 * leaves the loop. A label nested in the body does not. */
function labelTargetEnclosesLoop(from: ts.Node, name: string, loop: ts.Node): boolean {
  let current = from.parent;
  while (current) {
    if (ts.isLabeledStatement(current) && current.label.text === name) {
      let inner: ts.Node | undefined = current;
      while (inner) {
        if (inner === loop) return false;
        inner = inner.parent;
      }
      return true;
    }
    current = current.parent;
  }
  return false;
}
