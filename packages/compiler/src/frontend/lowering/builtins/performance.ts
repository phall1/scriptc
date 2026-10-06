import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { F64, type IrExpr, STRING, type SrcLoc, funcOf } from "../../../ir/ir.js";
import { builtinImportOf } from "./module-bindings.js";

/** True for any spelling of node:perf_hooks' `performance` object — the
 * named import binding, a namespace/default-import member, the require
 * twins (all through the shared builtin tables), or the GLOBAL Node
 * exposes without any import (the module export and the global are one
 * value; provenance-checked like console/process, so the bare
 * identifier and the globalThis.performance member both land here and
 * a user's own `performance` binding never does). */
function isPerfHooksPerformanceExpr(lowerer: Lowerer, node: ts.Expression): boolean {
  if (lowerer.isStdlibGlobal(node, "performance")) return true;
  if (ts.isIdentifier(node)) {
    const bi = builtinImportOf(lowerer, node);
    return bi !== null && bi.module === "perf_hooks" && bi.member === "performance";
  }
  if (ts.isPropertyAccessExpression(node) && !node.questionDotToken) {
    const bi = lowerer.builtinMemberOf(node);
    return bi !== null && bi.module === "perf_hooks" && bi.member === "performance";
  }
  return false;
}

/** Presence probes do not extract an unbound Performance method value. */
export function lowerPerfHooksTypeof(lowerer: Lowerer, expression: ts.Expression): IrExpr | null {
  const value = isPerfHooksPerformanceExpr(lowerer, expression)
    ? "object"
    : ts.isPropertyAccessExpression(expression) &&
        !expression.questionDotToken &&
        expression.name.text === "now" &&
        isPerfHooksPerformanceExpr(lowerer, expression.expression)
      ? "function"
      : null;
  return value === null ? null : { kind: "strLit", value, type: STRING, loc: locOf(expression) };
}

/** The node:perf_hooks spoke: `performance.now()` reads the runtime's
 * monotonic clock anchored at process start — Node's timeOrigin for a
 * compiled program, fractional milliseconds — and
 * `performance.now.bind(performance)` (the mockable-clock idiom's
 * getTimestamp) is the same clock as a plain () => number function
 * value. Other members on the performance object fence by name; null
 * for non-perf_hooks callees (the call chain keeps trying). */
export function lowerPerfHooksCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (access.questionDotToken) return null;
  const loc = locOf(expr);
  if (access.name.text === "now" && isPerfHooksPerformanceExpr(lowerer, access.expression)) {
    if (expr.arguments.length !== 0) {
      lowerer.noLowering(
        "performance.now with arguments",
        expr,
        "Node's performance.now takes none",
      );
    }
    return { kind: "libCall", fn: "perf.now", args: [], type: F64, loc };
  }
  if (
    access.name.text === "bind" &&
    ts.isPropertyAccessExpression(access.expression) &&
    !access.expression.questionDotToken &&
    access.expression.name.text === "now" &&
    isPerfHooksPerformanceExpr(lowerer, access.expression.expression)
  ) {
    if (expr.arguments.length !== 1 || !isPerfHooksPerformanceExpr(lowerer, expr.arguments[0]!)) {
      lowerer.noLowering(
        "this performance.now.bind form",
        expr,
        "performance.now.bind(performance) is the lowered function-value spelling",
      );
    }
    return {
      kind: "closure",
      fnName: perfNowFnValueOf(lowerer),
      captures: [],
      type: funcOf([], F64),
      loc,
    };
  }
  if (isPerfHooksPerformanceExpr(lowerer, access.expression)) {
    lowerer.noLowering(
      `perf_hooks performance.${access.name.text}`,
      expr,
      "performance.now() — and its .bind(performance) function value — is the lowered surface",
    );
  }
  return null;
}

/** The memoized () => number lifted wrapper behind
 * performance.now.bind(performance): a plain function value over the
 * same perf.now libCall. */
function perfNowFnValueOf(lowerer: Lowerer): string {
  const name = "%perf.now.value";
  if (!lowerer.liftedFns.some((f) => f.name === name)) {
    const loc: SrcLoc = { file: "<builtin>", start: 0, end: 0 };
    lowerer.liftedFns.push({
      name,
      params: [],
      returnType: F64,
      locals: [],
      body: [
        {
          kind: "return",
          value: { kind: "libCall", fn: "perf.now", args: [], type: F64, loc },
          loc,
        },
      ],
      loc,
    });
  }
  return name;
}
