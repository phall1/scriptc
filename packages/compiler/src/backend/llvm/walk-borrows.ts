import type { IrExpr, IrFunction, IrLocal } from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";

/** What the emitter knows about a projection's storage. */
export interface WalkBorrowHost {
  /** The local holds a plain pointer: a class instance or a nullable-pointer
   * union. Tagged union boxes, strings and containers keep ownership. */
  pointerLocal(local: IrLocal): boolean;
  /** emitReadReceiver yields this expression's pointer without acquiring a
   * reference (class casts, nullable wraps, plain field reads, checked
   * ternaries). */
  borrowsWithoutOwning(e: IrExpr): boolean;
}

/** Locals that may hold borrowed pointers for their whole lifetime: every
 * definition (declaration or statement assignment) is a projection of an
 * unwritten parameter or of another such local, for example the parent
 * walk `let p = node.parent; while (p.parent) p = p.parent;`.
 *
 * Soundness rests on the whole body preserving heap edges (the caller
 * passes only functions in ReferenceEffects.functions): neither the body
 * nor anything it calls removes a field, element or global reference, so
 * every object reachable from a parameter at entry stays reachable (and
 * alive) until the function returns. Such a local therefore needs no
 * retain on definition, no release on rebinding and none at scope exit.
 * Whole-value uses (returns, stores, owned arguments) still retain their
 * own copies when they read the binding. Other locals may be rebound
 * freely: they never root a walk, so releasing their old values cannot free
 * an object the walk reaches. */
export function findWalkBorrows(fn: IrFunction, host: WalkBorrowHost): ReadonlySet<string> {
  const result = new Set<string>();
  if (fn.async || fn.generator || fn.captures || fn.classCaptures) return result;
  const params = new Set(fn.params.map((param) => param.localId));
  const locals = new Map(fn.locals.map((local) => [local.id, local]));
  const definitions = new Map<string, (IrExpr | null)[]>();
  // Locals written in any other way (expression assignments, loop and catch
  // bindings, captures) keep the ordinary owned representation.
  const excluded = new Set<string>();
  const define = (id: string, value: IrExpr | null): void => {
    let list = definitions.get(id);
    if (!list) definitions.set(id, (list = []));
    list.push(value);
  };
  everyStmtList(fn.body, {
    stmt: (s) => {
      switch (s.kind) {
        case "varDecl":
          define(s.localId, s.init);
          break;
        case "assign":
          define(s.localId, s.value);
          break;
        case "forOf":
          excluded.add(s.localId);
          break;
        case "rethrow":
          excluded.add(s.localId);
          break;
        case "tryCatch":
          if (s.catchLocalId !== null) excluded.add(s.catchLocalId);
          break;
      }
      return true;
    },
    expr: (e) => {
      switch (e.kind) {
        case "assignExpr":
        case "incDec":
          excluded.add(e.localId);
          break;
        case "closure":
        case "classRef":
          for (const id of e.captures ?? []) excluded.add(id);
          break;
      }
      return true;
    },
  });
  // Parameters are roots only while no definition rebinds them.
  const roots = new Set([...params].filter((id) => !definitions.has(id) && !excluded.has(id)));
  const candidates = new Set<string>();
  for (const id of definitions.keys()) {
    const local = locals.get(id);
    if (
      params.has(id) ||
      excluded.has(id) ||
      !local ||
      local.boxed ||
      local.tdz ||
      !host.pointerLocal(local)
    )
      continue;
    candidates.add(id);
  }
  // A walk projects roots or candidates through reads that never acquire a
  // reference. Drop candidates until every definition is such a walk.
  const walk = (e: IrExpr): boolean => {
    switch (e.kind) {
      case "varRef":
        return roots.has(e.localId) || candidates.has(e.localId);
      case "fieldGet":
      case "recordGet":
        return host.borrowsWithoutOwning(e) && walk(e.obj);
      case "unionNarrow":
      case "downcast":
      case "upcast":
        return host.borrowsWithoutOwning(e) && walk(e.value);
      case "unionWrap":
        if (!host.borrowsWithoutOwning(e)) return false;
        return e.value.kind === "unitLit" || walk(e.value);
      case "ternary":
        return host.borrowsWithoutOwning(e) && walkOrThrow(e.then) && walkOrThrow(e.else_);
      default:
        return false;
    }
  };
  const walkOrThrow = (e: IrExpr): boolean =>
    (e.kind === "libCall" && e.fn === "error.nodeThrow") || walk(e);
  for (let changed = true; changed;) {
    changed = false;
    for (const id of candidates) {
      if (definitions.get(id)!.every((value) => value === null || walk(value))) continue;
      candidates.delete(id);
      changed = true;
    }
  }
  for (const id of candidates) result.add(id);
  return result;
}
