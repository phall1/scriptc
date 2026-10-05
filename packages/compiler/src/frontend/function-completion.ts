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
