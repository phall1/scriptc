import { boolLit, numLit, varRef } from "../../../ir/build.js";
import { InternalCompilerError } from "../../../errors.js";
import * as ts from "../../ts7/adapter.js";
import type { Lowerer } from "../lowerer.js";
import {
  BOOL,
  F64,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrParam,
  type IrStmt,
  type IrType,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
  VOID,
  arrayOf,
  typeEquals,
} from "../../../ir/ir.js";
import { locOf } from "../../program.js";
import { typeKey } from "../../type-mapper.js";
import { concatStrings, throwTypeError } from "./dynamic-receivers.js";

/* ── iterator helpers (ES2025) ─────────────────────────────────────────── */

/** The lowered iterator-helper chains: `arr.values()` (the array
 * iterator) through any run of map/filter/take/drop/flatMap into a
 * consuming terminal (toArray/forEach/reduce/some/every/find), FUSED
 * into one per-element loop — which IS the helpers' lazy pull order:
 * each source element flows through every stage before the next is
 * touched, take closes the pipeline without pulling upstream again
 * (budget checked before delivery), and short-circuit terminals stop
 * the walk at their hit. Stage callbacks take (value) or (value,
 * counter) — counters count each stage's own input stream, per spec.
 * take/drop budgets validate eagerly AT THE CALL (Node's RangeError,
 * raw value in the message) through an interned checker call inserted
 * at the argument's evaluation position. The source array is iterated
 * LIVE by index against a re-read length, exactly the array iterator's
 * contract. Everything else — iterator objects stored in bindings,
 * generator/Set/Map receivers, Iterator.from — keeps the lib fences.
 * Null when the callee isn't a terminal over such a chain. */
export function lowerIteratorHelperCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  const terminal = access.name.text;
  if (!ITER_TERMINALS.has(terminal)) return null;
  // Walk receiver: stage* ← values()/entries() ← array-typed source
  // (entries seeds the chain with [index, element] pairs — the
  // checker's own tuple type).
  const stages: { name: string; argNode: ts.Expression }[] = [];
  let cur: ts.Expression = access.expression;
  let source: ts.Expression | null = null;
  let srcProj: "values" | "entries" = "values";
  for (;;) {
    if (!ts.isCallExpression(cur) || !ts.isPropertyAccessExpression(cur.expression)) return null;
    if (cur.questionDotToken || cur.expression.questionDotToken) return null;
    const name = cur.expression.name.text;
    if ((name === "values" || name === "entries") && cur.arguments.length === 0) {
      const recvIr = lowerer.mapTypeOf(lowerer.typeOf(cur.expression.expression));
      if (recvIr?.kind !== "array") return null;
      if (!lowerer.isStdlibMember(cur.expression)) return null;
      source = cur.expression.expression;
      srcProj = name;
      break;
    }
    if (
      !ITER_STAGES.has(name) ||
      cur.arguments.length !== 1 ||
      ts.isSpreadElement(cur.arguments[0]!)
    )
      return null;
    stages.push({ name, argNode: cur.arguments[0]! });
    cur = cur.expression.expression;
  }
  stages.reverse(); // source order
  for (const s of stages) {
    const acc = findStageAccess(call, s);
    if (acc !== null && !lowerer.isStdlibMember(acc)) return null;
  }
  if (!lowerer.isStdlibMember(access)) return null;
  const loc = locOf(call);
  // Lower everything in SOURCE ORDER (the chain's own evaluation
  // order): the source array, each stage argument, the terminal's.
  const items = lowerer.lowerExpr(source);
  if (items.type.kind !== "array") return null;
  // The entries() seed: the interned [number, T] tuple — the same shape
  // the checker's own [number, T] maps to, so stage callbacks typed
  // against the lib's pairs intern equal.
  let elem: IrType =
    srcProj === "entries"
      ? {
          kind: "record",
          shapeId: lowerer.shapes.intern(
            [
              { name: "0", type: F64 },
              { name: "1", type: items.type.elem },
            ],
            true,
          ),
        }
      : items.type.elem;
  type StageIr =
    | {
        kind: "map" | "filter" | "flatMap";
        fn: IrExpr & { type: IrType & { kind: "func" } };
        out: IrType;
      }
    | { kind: "take" | "drop"; budget: IrExpr };
  const stageIrs: StageIr[] = [];
  for (const s of stages) {
    if (s.name === "take" || s.name === "drop") {
      const n = lowerer.lowerExpr(s.argNode);
      if (n.type.kind !== "f64") lowerer.badType(s.argNode, lowerer.typeOf(s.argNode));
      // Node validates at the take()/drop() call — the checked budget
      // rides an interned helper call AT this argument position.
      stageIrs.push({
        kind: s.name,
        budget: {
          kind: "call",
          callee: internBudgetChecker(lowerer, loc),
          args: [n],
          type: F64,
          loc,
        },
      });
      continue;
    }
    const f = lowerer.lowerExpr(s.argNode);
    if (
      f.type.kind !== "func" ||
      f.type.params.length > 2 ||
      (f.type.params.length >= 1 && !typeEquals(f.type.params[0]!, elem)) ||
      (f.type.params.length === 2 && f.type.params[1]!.kind !== "f64")
    ) {
      lowerer.badType(s.argNode, lowerer.typeOf(s.argNode));
    }
    const fn = f as IrExpr & { type: IrType & { kind: "func" } };
    if (s.name === "map") {
      stageIrs.push({ kind: "map", fn, out: fn.type.ret });
      elem = fn.type.ret;
    } else if (s.name === "filter") {
      if (fn.type.ret.kind !== "bool") lowerer.badType(s.argNode, lowerer.typeOf(s.argNode));
      stageIrs.push({ kind: "filter", fn, out: elem });
    } else {
      if (fn.type.ret.kind !== "array") {
        lowerer.noLowering(
          `.flatMap over a callback returning '${lowerer.fmt(fn.type.ret)}'`,
          s.argNode,
          "an array-returning callback is the supported form (iterators/strings have no lowering here)",
        );
      }
      stageIrs.push({ kind: "flatMap", fn, out: fn.type.ret.elem });
      elem = fn.type.ret.elem;
    }
  }
  // The terminal's own arguments.
  const termArgs: IrExpr[] = [];
  let resultT: IrType;
  if (terminal === "toArray") {
    if (call.arguments.length !== 0)
      lowerer.noLowering(`.toArray with ${call.arguments.length} arguments`, call);
    resultT = arrayOf(elem);
  } else if (
    terminal === "forEach" ||
    terminal === "some" ||
    terminal === "every" ||
    terminal === "find"
  ) {
    const argNode = call.arguments[0];
    if (call.arguments.length !== 1 || argNode === undefined || ts.isSpreadElement(argNode)) {
      lowerer.noLowering(`.${terminal} with ${call.arguments.length} arguments`, call);
    }
    const f = lowerer.lowerExpr(argNode);
    if (
      f.type.kind !== "func" ||
      f.type.params.length > 2 ||
      (f.type.params.length >= 1 && !typeEquals(f.type.params[0]!, elem)) ||
      (f.type.params.length === 2 && f.type.params[1]!.kind !== "f64") ||
      (terminal !== "forEach" && f.type.ret.kind !== "bool")
    ) {
      lowerer.badType(argNode, lowerer.typeOf(argNode));
    }
    termArgs.push(f);
    resultT =
      terminal === "forEach" ? VOID : terminal === "find" ? lowerer.withUndefinedArm(elem) : BOOL;
  } else {
    // reduce(f[, initial])
    const fNode = call.arguments[0];
    if (
      call.arguments.length < 1 ||
      call.arguments.length > 2 ||
      fNode === undefined ||
      call.arguments.some((a) => ts.isSpreadElement(a))
    ) {
      lowerer.noLowering(`.reduce with ${call.arguments.length} arguments`, call);
    }
    const f = lowerer.lowerExpr(fNode);
    if (
      f.type.kind !== "func" ||
      f.type.params.length < 2 ||
      f.type.params.length > 3 ||
      !typeEquals(f.type.params[1]!, elem) ||
      (f.type.params.length === 3 && f.type.params[2]!.kind !== "f64") ||
      !typeEquals(f.type.params[0]!, f.type.ret)
    ) {
      lowerer.badType(fNode, lowerer.typeOf(fNode));
    }
    const accT = (f.type as IrType & { kind: "func" }).ret;
    if (call.arguments.length === 1 && !typeEquals(accT, elem)) {
      lowerer.noLowering(
        ".reduce without an initial value where the accumulator's type differs from the elements'",
        call,
        "pass the initial value: .reduce(f, init)",
      );
    }
    termArgs.push(f);
    if (call.arguments[1] !== undefined)
      termArgs.push(lowerer.lowerExprExpecting(call.arguments[1], accT));
    resultT = accT;
  }
  // The checker's own result type must agree (annotation drift fences).
  const checkerT = lowerer.mapTypeOf(lowerer.typeOf(call));
  if (terminal !== "forEach" && (checkerT === null || !typeEquals(checkerT, resultT))) {
    lowerer.noLowering(
      `.${terminal} at this result type`,
      call,
      "the chain's element and result types must be representable — annotate the callbacks' types",
    );
  }
  const stageKeys = stageIrs.map((s) => {
    if (!s) throw new InternalCompilerError("missing iterator stage");
    return "budget" in s ? s.kind : `${s.kind}:${typeKey(s.fn.type)}`;
  });
  const key = `iter:${srcProj}:${typeKey(items.type)}:${stageKeys.join(",")}:${terminal}:${termArgs.map((a) => typeKey(a.type)).join(",")}`;
  let helper = lowerer.arrHofHelpers.get(key);
  if (!helper) {
    helper = `%iter.${terminal}.${lowerer.arrHofHelpers.size}`;
    lowerer.arrHofHelpers.set(key, helper);
    lowerer.liftedFns.push(
      buildIterChainFn(
        lowerer,
        helper,
        items.type,
        srcProj,
        stageIrs,
        terminal,
        termArgs.map((a) => a.type),
        resultT,
        loc,
      ),
    );
  }
  const budgetOrFn = stageIrs.map((s): IrExpr => {
    if (!s) throw new InternalCompilerError("missing iterator stage");
    return "budget" in s ? s.budget : s.fn;
  });
  return {
    kind: "call",
    callee: helper,
    args: [items, ...budgetOrFn, ...termArgs],
    type: resultT,
    loc,
  };
}

const ITER_STAGES = new Set(["map", "filter", "take", "drop", "flatMap"]);
const ITER_TERMINALS = new Set(["toArray", "forEach", "reduce", "some", "every", "find"]);

/** The ts.PropertyAccessExpression of stage `s` inside the chain under
 * `call` — for the stdlib-membership check. Walks the same spine the
 * parser walked; null only on shape drift (checked defensively). */
function findStageAccess(
  call: ts.CallExpression,
  s: { name: string; argNode: ts.Expression },
): ts.PropertyAccessExpression | null {
  let cur: ts.Expression = (call.expression as ts.PropertyAccessExpression).expression;
  while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
    if (cur.arguments[0] === s.argNode) return cur.expression;
    cur = cur.expression.expression;
  }
  return null;
}

/** The eager take/drop budget check, interned once per program:
 *
 *   %iter.budget(v) { if (v !== v || trunc(v) < 0) throw RangeError(`${v} must be positive`); return trunc(v) }
 *
 * Node's exact behavior: NaN and negative INTEGER budgets throw (the
 * message carries the RAW argument — take(-1.5) says "-1.5"), -0.5
 * truncates to 0 and passes, Infinity passes through. */
function internBudgetChecker(lowerer: Lowerer, loc: SrcLoc): string {
  const key = "iter:budget";
  let name = lowerer.arrHofHelpers.get(key);
  if (name !== undefined) return name;
  name = "%iter.budget";
  lowerer.arrHofHelpers.set(key, name);
  const v = (): IrExpr => ({ kind: "varRef", localId: "v.0", type: F64, loc });

  // trunc without an Infinity-poisoned fmod: values at or past 2^53 are
  // already integers (Infinity included), so only smaller ones truncate.
  const t = (): IrExpr => ({
    kind: "ternary",
    cond: {
      kind: "bin",
      op: "<",
      left: v(),
      right: numLit(9007199254740992, loc),
      type: BOOL,
      loc,
    },
    then: {
      kind: "bin",
      op: "-",
      left: v(),
      right: { kind: "bin", op: "%", left: v(), right: numLit(1, loc), type: F64, loc },
      type: F64,
      loc,
    },
    else_: v(),
    type: F64,
    loc,
  });
  const bad: IrExpr = {
    kind: "logical",
    op: "||",
    left: { kind: "bin", op: "!==", left: v(), right: v(), type: BOOL, loc },
    right: { kind: "bin", op: "<", left: t(), right: numLit(0, loc), type: BOOL, loc },
    type: BOOL,
    loc,
  };
  const throwStmt: IrStmt = {
    kind: "throw",
    value: {
      kind: "libCall",
      fn: "error.new",
      args: [
        concatStrings(
          [
            { kind: "toString", operand: v(), type: STRING, loc },
            { kind: "strLit", value: " must be positive", type: STRING, loc },
          ],
          loc,
        ),
      ],
      type: { kind: "object", className: "%RangeError" },
      loc,
    },
    loc,
  };
  lowerer.liftedFns.push({
    name,
    params: [{ localId: "v.0", name: "v", type: F64 }],
    returnType: F64,
    locals: [{ id: "v.0", name: "v", type: F64, mutable: true }],
    body: [
      { kind: "if", cond: bad, then: [throwStmt], else_: null, loc },
      { kind: "return", value: t(), loc },
    ],
    loc,
  });
  return name;
}

/** The fused chain body. One loop over the LIVE source (length re-read
 * per pass), a `done` flag every loop condition carries (take closing
 * the pipeline, short-circuit terminals), stage code nested inside in
 * source order, flatMap as an inner loop over its returned array.
 * Pre-loop, a zero take budget marks done immediately — Node pulls
 * nothing at all through a take(0). */
function buildIterChainFn(
  lowerer: Lowerer,
  name: string,
  itemsT: IrType & { kind: "array" },
  srcProj: "values" | "entries",
  stages: { kind: string; fn?: IrExpr & { type: IrType & { kind: "func" } } }[],
  terminal: string,
  termArgTs: IrType[],
  resultT: IrType,
  loc: SrcLoc,
): IrFunction {
  const locals: IrLocal[] = [{ id: "items.0", name: "items", type: itemsT, mutable: true }];
  const params: IrParam[] = [{ localId: "items.0", name: "items", type: itemsT }];
  let n = 0;
  const addLocal = (base: string, type: IrType, mutable: boolean): string => {
    const id = `${base}.${n++}`;
    locals.push({ id, name: base, type, mutable });
    return id;
  };
  const addParam = (base: string, type: IrType): string => {
    const id = `${base}.${n++}`;
    locals.push({ id, name: base, type, mutable: true });
    params.push({ localId: id, name: base, type });
    return id;
  };
  const doneId = addLocal("done", BOOL, true);
  const done = (): IrExpr => varRef(doneId, BOOL, loc);
  const setDone: IrStmt = { kind: "assign", localId: doneId, value: boolLit(true, loc), loc };
  // Parameters in call order: per-stage budget/callback, then terminal's.
  interface StageSlot {
    kind: string;
    paramId: string;
    fnT?: (IrType & { kind: "func" }) | undefined;
    cntId?: string | undefined;
    elem: IrType;
  }
  // The entries() seed builds each pass's [index, element] pair — the
  // same interned tuple the caller computed its stage types against.
  const seedT: IrType =
    srcProj === "entries"
      ? {
          kind: "record",
          shapeId: lowerer.shapes.intern(
            [
              { name: "0", type: F64 },
              { name: "1", type: itemsT.elem },
            ],
            true,
          ),
        }
      : itemsT.elem;
  let elem: IrType = seedT;
  const slots: StageSlot[] = [];
  for (const s of stages) {
    if (s.kind === "take" || s.kind === "drop") {
      const paramId = addParam("n", F64);
      const cntId = addLocal(s.kind === "take" ? "taken" : "dropped", F64, true);
      slots.push({ kind: s.kind, paramId, cntId, elem });
      continue;
    }
    const fnT = s.fn!.type;
    const paramId = addParam("f", fnT);
    const cntId = fnT.params.length === 2 ? addLocal("c", F64, true) : undefined;
    const out =
      s.kind === "map"
        ? fnT.ret
        : s.kind === "flatMap"
          ? (fnT.ret as IrType & { kind: "array" }).elem
          : elem;
    slots.push({ kind: s.kind, paramId, fnT, cntId, elem: out });
    elem = out;
  }
  const termIds = termArgTs.map((t, i) => addParam(i === 0 ? "tf" : "init", t));
  const termFnT =
    termArgTs[0]?.kind === "func" ? (termArgTs[0] as IrType & { kind: "func" }) : null;
  const termCntId =
    (terminal === "reduce" && termFnT !== null && termFnT.params.length === 3) ||
    (terminal !== "reduce" &&
      terminal !== "toArray" &&
      termFnT !== null &&
      termFnT.params.length === 2) ||
    terminal === "reduce"
      ? addLocal("k", F64, true)
      : undefined;
  const bump = (id: string): IrStmt => ({
    kind: "assign",
    localId: id,
    value: {
      kind: "bin",
      op: "+",
      left: varRef(id, F64, loc),
      right: numLit(1, loc),
      type: F64,
      loc,
    },
    loc,
  });
  const callWith = (
    fnT: IrType & { kind: "func" },
    fnId: string,
    value: IrExpr,
    cntId: string | undefined,
  ): IrExpr => {
    const args: IrExpr[] = [];
    if (fnT.params.length >= 1) args.push(value);
    if (cntId !== undefined && fnT.params.length >= 2) args.push(varRef(cntId, F64, loc));
    return { kind: "callValue", callee: varRef(fnId, fnT, loc), args, type: fnT.ret, loc };
  };
  // Terminal state.
  const preLoop: IrStmt[] = [];
  const postLoop: IrStmt[] = [];
  let outId = "";
  let accId = "";
  let hasAccId = "";
  let resId = "";
  if (terminal === "toArray") {
    outId = addLocal("out", resultT, false);
    preLoop.push({
      kind: "varDecl",
      localId: outId,
      init: { kind: "arrayLit", elems: [], type: resultT, loc },
      loc,
    });
    postLoop.push({ kind: "return", value: varRef(outId, resultT, loc), loc });
  } else if (terminal === "some" || terminal === "every") {
    resId = addLocal("res", BOOL, true);
    preLoop.push({
      kind: "varDecl",
      localId: resId,
      init: boolLit(terminal === "every", loc),
      loc,
    });
    postLoop.push({ kind: "return", value: varRef(resId, BOOL, loc), loc });
  } else if (terminal === "find") {
    resId = addLocal("res", resultT, true);
    const undef = lowerer.wrappedUndefined(resultT, loc);
    if (undef === null)
      throw new InternalCompilerError("lowerer bug: find result union lacks undefined");
    preLoop.push({ kind: "varDecl", localId: resId, init: undef, loc });
    postLoop.push({ kind: "return", value: varRef(resId, resultT, loc), loc });
  } else if (terminal === "reduce") {
    accId = addLocal("acc", resultT, true);
    if (termIds.length === 2) {
      preLoop.push({
        kind: "varDecl",
        localId: accId,
        init: varRef(termIds[1]!, resultT, loc),
        loc,
      });
    } else {
      hasAccId = addLocal("hasAcc", BOOL, true);
      preLoop.push({ kind: "varDecl", localId: hasAccId, init: boolLit(false, loc), loc });
      postLoop.push({
        kind: "if",
        cond: { kind: "unary", op: "!", operand: varRef(hasAccId, BOOL, loc), type: BOOL, loc },
        then: [
          throwTypeError(
            {
              kind: "strLit",
              value: "Reduce of a done iterator with no initial value",
              type: STRING,
              loc,
            },
            loc,
          ),
        ],
        else_: null,
        loc,
      });
    }
    postLoop.push({ kind: "return", value: varRef(accId, resultT, loc), loc });
  } else {
    postLoop.push({ kind: "return", value: null, loc });
  }
  if (termCntId !== undefined)
    preLoop.push({ kind: "varDecl", localId: termCntId, init: numLit(0, loc), loc });
  // done starts true when any take budget is zero (nothing pulls).
  let doneInit: IrExpr = boolLit(false, loc);
  for (const s of slots) {
    if (s.kind !== "take") continue;
    const isZero: IrExpr = {
      kind: "bin",
      op: "===",
      left: varRef(s.paramId, F64, loc),
      right: numLit(0, loc),
      type: BOOL,
      loc,
    };
    doneInit =
      doneInit.kind === "boolLit"
        ? isZero
        : { kind: "logical", op: "||", left: doneInit, right: isZero, type: BOOL, loc };
  }
  preLoop.unshift({ kind: "varDecl", localId: doneId, init: doneInit, loc });
  for (const s of slots) {
    if (s.cntId !== undefined)
      preLoop.push({ kind: "varDecl", localId: s.cntId, init: numLit(0, loc), loc });
  }
  // The terminal's per-element statements over `value`.
  const terminalBody = (value: IrExpr): IrStmt[] => {
    const out: IrStmt[] = [];
    if (terminal === "toArray") {
      out.push({
        kind: "exprStmt",
        expr: {
          kind: "arrIntrinsic",
          method: "push",
          receiver: varRef(outId, resultT, loc),
          args: [value],
          type: F64,
          loc,
        },
        loc,
      });
    } else if (terminal === "forEach") {
      out.push({ kind: "exprStmt", expr: callWith(termFnT!, termIds[0]!, value, termCntId), loc });
    } else if (terminal === "some" || terminal === "every") {
      const hit = callWith(termFnT!, termIds[0]!, value, termCntId);
      const cond: IrExpr =
        terminal === "some" ? hit : { kind: "unary", op: "!", operand: hit, type: BOOL, loc };
      out.push({
        kind: "if",
        cond,
        then: [
          { kind: "assign", localId: resId, value: boolLit(terminal === "some", loc), loc },
          setDone,
        ],
        else_: null,
        loc,
      });
    } else if (terminal === "find") {
      const undefTag = resultT.kind === "union" ? lowerer.armTag(resultT.unionId, UNDEFINED_T) : -1;
      const valueTag = resultT.kind === "union" ? (undefTag === 0 ? 1 : 0) : -1;
      if (resultT.kind !== "union" || valueTag < 0)
        throw new InternalCompilerError(
          "lowerer bug: find result is not the undefined-armed union",
        );
      out.push({
        kind: "if",
        cond: callWith(termFnT!, termIds[0]!, value, termCntId),
        then: [
          {
            kind: "assign",
            localId: resId,
            value: {
              kind: "unionWrap",
              unionId: resultT.unionId,
              tag: valueTag,
              value,
              type: resultT,
              loc,
            },
            loc,
          },
          setDone,
        ],
        else_: null,
        loc,
      });
    } else {
      // reduce
      const reducer = (): IrExpr => {
        const args: IrExpr[] = [varRef(accId, resultT, loc), value];
        if (termFnT!.params.length === 3) args.push(varRef(termCntId!, F64, loc));
        return {
          kind: "callValue",
          callee: varRef(termIds[0]!, termFnT!, loc),
          args,
          type: resultT,
          loc,
        };
      };
      if (hasAccId !== "") {
        out.push({
          kind: "if",
          cond: { kind: "unary", op: "!", operand: varRef(hasAccId, BOOL, loc), type: BOOL, loc },
          then: [
            { kind: "assign", localId: accId, value, loc },
            { kind: "assign", localId: hasAccId, value: boolLit(true, loc), loc },
          ],
          else_: [{ kind: "assign", localId: accId, value: reducer(), loc }],
          loc,
        });
      } else {
        out.push({ kind: "assign", localId: accId, value: reducer(), loc });
      }
    }
    if (termCntId !== undefined) out.push(bump(termCntId));
    return out;
  };
  // Fold stages from the terminal outward.
  let emit: (value: IrExpr) => IrStmt[] = terminalBody;
  for (let si = slots.length - 1; si >= 0; si--) {
    const s = slots[si]!;
    const inner = emit;
    if (s.kind === "map") {
      emit = (value) => {
        const vId = addLocal("m", s.fnT!.ret, false);
        return [
          { kind: "varDecl", localId: vId, init: callWith(s.fnT!, s.paramId, value, s.cntId), loc },
          ...(s.cntId !== undefined ? [bump(s.cntId)] : []),
          ...inner(varRef(vId, s.fnT!.ret, loc)),
        ];
      };
    } else if (s.kind === "filter") {
      emit = (value) => {
        const okId = addLocal("ok", BOOL, false);
        return [
          {
            kind: "varDecl",
            localId: okId,
            init: callWith(s.fnT!, s.paramId, value, s.cntId),
            loc,
          },
          ...(s.cntId !== undefined ? [bump(s.cntId)] : []),
          {
            kind: "if",
            cond: { kind: "unary", op: "!", operand: varRef(okId, BOOL, loc), type: BOOL, loc },
            then: [{ kind: "continue", loc }],
            else_: null,
            loc,
          },
          ...inner(value),
        ];
      };
    } else if (s.kind === "drop") {
      emit = (value) => [
        {
          kind: "if",
          cond: {
            kind: "bin",
            op: "<",
            left: varRef(s.cntId!, F64, loc),
            right: varRef(s.paramId, F64, loc),
            type: BOOL,
            loc,
          },
          then: [bump(s.cntId!), { kind: "continue", loc }],
          else_: null,
          loc,
        },
        ...inner(value),
      ];
    } else if (s.kind === "take") {
      // Budget consumed BEFORE delivery: the nth element flows on with
      // done already set, so no later element pulls upstream — and a
      // downstream `continue` can't skip the close (the loop conditions
      // carry !done).
      emit = (value) => [
        bump(s.cntId!),
        {
          kind: "if",
          cond: {
            kind: "bin",
            op: ">=",
            left: varRef(s.cntId!, F64, loc),
            right: varRef(s.paramId, F64, loc),
            type: BOOL,
            loc,
          },
          then: [setDone],
          else_: null,
          loc,
        },
        ...inner(value),
      ];
    } else {
      // flatMap: an inner loop over the returned array, `!done` carried.
      emit = (value) => {
        const innerT = s.fnT!.ret as IrType & { kind: "array" };
        const arrId = addLocal("fm", innerT, false);
        const jId = addLocal("j", F64, true);
        const wId = addLocal("w", innerT.elem, false);
        return [
          {
            kind: "varDecl",
            localId: arrId,
            init: callWith(s.fnT!, s.paramId, value, s.cntId),
            loc,
          },
          ...(s.cntId !== undefined ? [bump(s.cntId)] : []),
          {
            kind: "for",
            init: { kind: "varDecl", localId: jId, init: numLit(0, loc), loc },
            cond: {
              kind: "logical",
              op: "&&",
              left: {
                kind: "bin",
                op: "<",
                left: varRef(jId, F64, loc),
                right: {
                  kind: "arrIntrinsic",
                  method: "length",
                  receiver: varRef(arrId, innerT, loc),
                  args: [],
                  type: F64,
                  loc,
                },
                type: BOOL,
                loc,
              },
              right: { kind: "unary", op: "!", operand: done(), type: BOOL, loc },
              type: BOOL,
              loc,
            },
            update: {
              kind: "assign",
              localId: jId,
              value: {
                kind: "bin",
                op: "+",
                left: varRef(jId, F64, loc),
                right: numLit(1, loc),
                type: F64,
                loc,
              },
              loc,
            },
            body: [
              {
                kind: "varDecl",
                localId: wId,
                init: {
                  kind: "arrayGet",
                  arr: varRef(arrId, innerT, loc),
                  index: varRef(jId, F64, loc),
                  type: innerT.elem,
                  loc,
                },
                loc,
              },
              ...inner(varRef(wId, innerT.elem, loc)),
            ],
            loc,
          },
        ];
      };
    }
  }
  const iId = addLocal("i", F64, true);
  const vId = addLocal("v", seedT, false);
  const elemRead = (): IrExpr => ({
    kind: "arrayGet",
    arr: varRef("items.0", itemsT, loc),
    index: varRef(iId, F64, loc),
    type: itemsT.elem,
    loc,
  });
  const seedInit: IrExpr =
    srcProj === "entries"
      ? {
          kind: "recordLit",
          fields: [
            { name: "0", value: varRef(iId, F64, loc) },
            { name: "1", value: elemRead() },
          ],
          type: seedT,
          loc,
        }
      : elemRead();
  const loop: IrStmt = {
    kind: "for",
    init: { kind: "varDecl", localId: iId, init: numLit(0, loc), loc },
    cond: {
      kind: "logical",
      op: "&&",
      left: {
        kind: "bin",
        op: "<",
        left: varRef(iId, F64, loc),
        right: {
          kind: "arrIntrinsic",
          method: "length",
          receiver: varRef("items.0", itemsT, loc),
          args: [],
          type: F64,
          loc,
        },
        type: BOOL,
        loc,
      },
      right: { kind: "unary", op: "!", operand: done(), type: BOOL, loc },
      type: BOOL,
      loc,
    },
    update: {
      kind: "assign",
      localId: iId,
      value: {
        kind: "bin",
        op: "+",
        left: varRef(iId, F64, loc),
        right: numLit(1, loc),
        type: F64,
        loc,
      },
      loc,
    },
    body: [
      { kind: "varDecl", localId: vId, init: seedInit, loc },
      ...emit(varRef(vId, seedT, loc)),
    ],
    loc,
  };
  return {
    name,
    params,
    returnType: resultT,
    locals,
    body: [...preLoop, loop, ...postLoop],
    loc,
  };
}
