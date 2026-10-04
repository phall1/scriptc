import type { IrExpr, IrLocal, IrStmt } from "./ir.js";

import { everyStmtList } from "./traverse.js";

/** A canonical byte loop whose induction variable is mathematically an
 * unsigned integer for every body entry. Backends may keep this binding in
 * integer storage while the loop runs, converting to f64 at ordinary JS
 * number uses and using the integer directly for typed-array indices. */
export interface IntegerBytesForLoop {
  localId: string;
  limitReceiver: IrExpr;
}

/** True when a lowered subtree writes `localId`. Local ids are unique per
 * function, so typed traversal includes writes
 * nested in expressions, branches, nested loops, and try/finally bodies. */
function writesLocal(body: IrStmt[], localId: string): boolean {
  return !everyStmtList(body, {
    expr: (expr) => (expr.kind !== "assignExpr" && expr.kind !== "incDec") || expr.localId !== localId,
    stmt: (stmt) => stmt.kind !== "assign" || stmt.localId !== localId,
  });
}

function isUnitIncrement(update: IrStmt | null, localId: string): boolean {
  // The frontend normally lowers `i++` to `i = i + 1` before backend
  // emission. Accept the incDec form too so this analysis remains valid for
  // hand-built IR and if normalization is moved later in the pipeline.
  if (update?.kind === "exprStmt") {
    return (
      update.expr.kind === "incDec" &&
      update.expr.localId === localId &&
      update.expr.op === "+"
    );
  }
  return (
    update?.kind === "assign" &&
    update.localId === localId &&
    update.value.kind === "bin" &&
    update.value.op === "+" &&
    update.value.left.kind === "varRef" &&
    update.value.left.localId === localId &&
    update.value.right.kind === "numLit" &&
    update.value.right.value === 1
  );
}

/** Recognize the deliberately small, semantics-transparent first tier of
 * integer induction:
 *
 *   for (let i = 0; i < bytes.length; i++) { ... }
 *
 * The binding must be an unboxed mutable f64 local and the body must not
 * write it. The exact zero start plus unit increment and ScrBytes' fixed,
 * safe-integer length prove every body value is an exactly representable
 * non-negative integer. A captured loop binding is boxed and therefore
 * refused (per-iteration binding identity remains on the generic path).
 */
export function matchIntegerBytesForLoop(
  stmt: IrStmt & { kind: "for" },
  locals: ReadonlyMap<string, IrLocal>,
): IntegerBytesForLoop | null {
  const init = stmt.init;
  if (
    init?.kind !== "varDecl" ||
    init.init?.kind !== "numLit" ||
    init.init.value !== 0 ||
    Object.is(init.init.value, -0)
  ) {
    return null;
  }
  const local = locals.get(init.localId);
  if (local?.type.kind !== "f64" || !local.mutable || local.boxed === true) return null;

  const cond = stmt.cond;
  if (
    cond?.kind !== "bin" ||
    cond.op !== "<" ||
    cond.left.kind !== "varRef" ||
    cond.left.localId !== init.localId ||
    cond.right.kind !== "bytesIntrinsic" ||
    cond.right.method !== "length" ||
    cond.right.receiver.kind !== "varRef" ||
    cond.right.receiver.type.kind !== "bytes"
  ) {
    return null;
  }
  const receiverLocal = locals.get(cond.right.receiver.localId);
  if (receiverLocal?.boxed === true) return null;

  if (!isUnitIncrement(stmt.update, init.localId)) return null;
  if (writesLocal(stmt.body, init.localId)) return null;

  return { localId: init.localId, limitReceiver: cond.right.receiver };
}

/** Array lengths are uint32, so zero-based loops and nested `j = i + 1`
 * loops have exact integer induction even when the body changes length.
 * Only active array induction bindings may seed a nested loop. Their body
 * values are at most 2^32 - 2, making the increment safe on 32-bit targets. */
export function matchIntegerArrayForLoop(
  stmt: IrStmt & { kind: "for" }, locals: ReadonlyMap<string, IrLocal>, outer: ReadonlySet<string>,
): IntegerBytesForLoop | null {
  const init = stmt.init;
  if (init?.kind !== "varDecl" || !init.init) return null;
  const start = init.init;
  const zero = start.kind === "numLit" && start.value === 0 && !Object.is(start.value, -0);
  const nested = start.kind === "bin" && start.op === "+" && start.left.kind === "varRef" && outer.has(start.left.localId) &&
    start.right.kind === "numLit" && start.right.value === 1;
  const local = locals.get(init.localId);
  if ((!zero && !nested) || local?.type.kind !== "f64" || !local.mutable || local.boxed || local.tdz) return null;
  const cond = stmt.cond;
  if (cond?.kind !== "bin" || cond.op !== "<" || cond.left.kind !== "varRef" || cond.left.localId !== local.id ||
      cond.right.kind !== "arrIntrinsic" || cond.right.method !== "length" || cond.right.receiver.kind !== "varRef" ||
      cond.right.receiver.type.kind !== "array" || locals.get(cond.right.receiver.localId)?.boxed ||
      !isUnitIncrement(stmt.update, local.id) || writesLocal(stmt.body, local.id)) return null;
  return { localId: local.id, limitReceiver: cond.right.receiver };
}
