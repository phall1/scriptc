import * as ts from "./ts7/adapter.js";

/** JavaScript documentation does not enforce an explicit return. Keep
 * implicit completion even when the documented result omits undefined. */
export function functionCanFallThrough(declaration: ts.Node): boolean {
  if (!ts.isFunctionLike(declaration) || declaration.asteriskToken ||
      declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return false;
  const body = "body" in declaration ? declaration.body as ts.Block | ts.Expression | undefined : undefined;
  if (!body || !ts.isBlock(body)) return false;
  const completes = (statement: ts.Statement): boolean => {
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return false;
    if (ts.isBlock(statement)) return sequence(statement.statements);
    if (ts.isIfStatement(statement)) return completes(statement.thenStatement) || !statement.elseStatement || completes(statement.elseStatement);
    if (ts.isTryStatement(statement)) {
      if (statement.finallyBlock && !completes(statement.finallyBlock)) return false;
      return completes(statement.tryBlock) || !!statement.catchClause && completes(statement.catchClause.block);
    }
    if (ts.isSwitchStatement(statement)) return !statement.caseBlock.clauses.some(ts.isDefaultClause) ||
      statement.caseBlock.clauses.some((clause) => sequence(clause.statements));
    return true;
  };
  const sequence = (statements: readonly ts.Statement[]): boolean => statements.every(completes);
  return sequence(body.statements);
}
