import type { IntegerRange } from "./integer-ranges.js";
import type { IrExpr, IrLocal, IrStmt } from "./ir.js";
import { everyExprChild, everyStmtChild } from "./traverse.js";

function increment(id: string, value: IrExpr): number | null {
  if (value.kind !== "bin" || value.left.kind !== "varRef" || value.left.localId !== id ||
      value.right.kind !== "numLit" || !Number.isSafeInteger(value.right.value) || Object.is(value.right.value, -0)) return null;
  return value.op === "+" ? value.right.value : value.op === "-" ? -value.right.value : null;
}

/** Bound secondary cursors by a finite ascending loop's maximum iteration
 * count. Sum all syntactic updates, including both sides of branches, so
 * filtering, breaks and continues can only reduce the budget. A nested
 * loop or opaque control region invalidates the bindings it writes. */
export function boundedIntegerLoopFacts(
  loop: IrStmt & { kind: "for" }, locals: ReadonlyMap<string, IrLocal>, initial: ReadonlyMap<string, IntegerRange>,
): ReadonlyMap<string, IntegerRange> {
  const result = new Map<string, IntegerRange>();
  if (loop.init?.kind !== "varDecl" || loop.update?.kind !== "assign" || loop.cond?.kind !== "bin") return result;
  const counter = loop.init.localId, start = initial.get(counter);
  const step = loop.update.localId === counter ? increment(counter, loop.update.value) : null;
  if (!start || start.min < 0 || step === null || step <= 0 || step > 2147483647 ||
      loop.cond.left.kind !== "varRef" || loop.cond.left.localId !== counter ||
      (loop.cond.op !== "<" && loop.cond.op !== "<=")) return result;
  const written = new Set<string>(), refused = new Set<string>();
  const lower = new Map<string, number>(), upper = new Map<string, number>();
  let opaque = 0;
  const write = (id: string, delta: number | null): void => {
    written.add(id);
    if (opaque || delta === null) { refused.add(id); return; }
    const lo = (lower.get(id) ?? 0) + Math.min(0, delta);
    const hi = (upper.get(id) ?? 0) + Math.max(0, delta);
    if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi)) refused.add(id);
    lower.set(id, lo); upper.set(id, hi);
  };
  const expr = (e: IrExpr): boolean => {
    if (e.kind === "assignExpr") write(e.localId, increment(e.localId, e.value));
    if (e.kind === "incDec") write(e.localId, e.op === "+" ? 1 : -1);
    return everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => {
    const region = s.kind === "for" || s.kind === "while" || s.kind === "doWhile" ||
      s.kind === "forOf" || s.kind === "tryCatch" || s.kind === "switch";
    if (region) opaque++;
    if (s.kind === "assign") write(s.localId, increment(s.localId, s.value));
    if (s.kind === "varDecl" || s.kind === "forOf") write(s.localId, null);
    const completed = everyStmtChild(s, expr, stmt);
    if (region) opaque--;
    return completed;
  };
  loop.body.every(stmt);
  if (written.has(counter)) return result;
  const stable = (id: string): boolean => {
    const local = locals.get(id);
    return local !== undefined && !local.boxed && !local.tdz && !written.has(id) && id !== counter;
  };
  function bound(e: IrExpr): IntegerRange | null {
    if (e.kind === "numLit" && Number.isSafeInteger(e.value) && !Object.is(e.value, -0)) return { min: e.value, max: e.value };
    if (e.kind === "varRef" && stable(e.localId)) return initial.get(e.localId) ?? null;
    if (e.kind === "bytesIntrinsic" && (e.method === "length" || e.method === "byteLength") &&
        e.receiver.kind === "varRef" && stable(e.receiver.localId)) return { min: 0, max: Number.MAX_SAFE_INTEGER };
    return null;
  }
  const limit = bound(loop.cond.right);
  if (!limit || limit.max < start.min) return result;
  const distance = limit.max - start.min;
  const iterations = Math.floor(distance / step) + 1;
  if (!Number.isSafeInteger(distance) || !Number.isSafeInteger(iterations)) return result;
  // Header facts also cover the failing final condition and zero iterations.
  const maximum = Math.max(start.max, limit.max + step);
  if (Number.isSafeInteger(maximum)) result.set(counter, { min: start.min, max: maximum });
  for (const [id, hi] of upper) {
    const range = initial.get(id);
    if (!range || refused.has(id) || id === counter) continue;
    const decrement = iterations * lower.get(id)!;
    const increment = iterations * hi;
    if (!Number.isSafeInteger(decrement) || !Number.isSafeInteger(increment)) continue;
    const min = range.min + decrement;
    const max = range.max + increment;
    if (Number.isSafeInteger(min) && Number.isSafeInteger(max)) result.set(id, { min, max });
  }
  return result;
}

/** Recognize only exits whose target cannot be inside this statement list.
 * Labeled blocks, loops, switch and exception regions retain the join. */
export function integerPathFallsThrough(body: readonly IrStmt[]): boolean {
  for (const stmt of body) {
    if (stmt.kind === "return" || stmt.kind === "throw" || stmt.kind === "rethrow" || stmt.kind === "break" || stmt.kind === "continue") return false;
    if (stmt.kind === "block" && !stmt.labels?.length && !integerPathFallsThrough(stmt.body)) return false;
    if (stmt.kind === "if" && stmt.else_ && !integerPathFallsThrough(stmt.then) && !integerPathFallsThrough(stmt.else_)) return false;
  }
  return true;
}
