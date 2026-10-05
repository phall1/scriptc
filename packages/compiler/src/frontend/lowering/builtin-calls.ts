import * as ts from "../ts7/adapter.js";
import type { IrExpr, SrcLoc } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";
import { lowerTimersMemberCall } from "./lower-timers.js";
import { lowerStreamModuleCall } from "./lower-stream.js";
import { lowerNodeModuleCall } from "./lower-builtins.js";
import { builtinModuleFnOf, builtinFenceHintOf } from "./surfaces.js";

/** Named imports, namespace members and callable aliases share validation
 * and dispatch. Resolve diagnostic provenance only if no handler accepts. */
export function lowerBuiltinCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
  namespaceMember?: ts.MemberName,
): IrExpr {
  if (bi.module === "child_process" && bi.member === "execFile") {
    return lowerer.lowerExecFileCall(expr, loc);
  }
  if (bi.module === "timers") {
    const timersServed = lowerTimersMemberCall(lowerer, expr, bi.member, loc);
    if (timersServed) return timersServed;
  }
  const served = lowerer.lowerNetModuleCall(expr, bi, loc);
  if (served) return served;
  const dgramServed = lowerer.lowerDgramDnsModuleCall(expr, bi, loc);
  if (dgramServed) return dgramServed;
  const assertServed = lowerer.lowerAssertModuleCall(expr, bi, loc);
  if (assertServed) return assertServed;
  const testServed = lowerer.lowerNodeTestModuleCall(expr, bi, loc);
  if (testServed) return testServed;
  const utilServed = lowerer.lowerUtilModuleCall(expr, bi, loc);
  if (utilServed) return utilServed;
  const streamServed = lowerStreamModuleCall(lowerer, expr, bi, loc);
  if (streamServed) return streamServed;
  const fsTs = lowerer.lowerFsToUnixTimestampCall(expr, bi, loc);
  if (fsTs) return fsTs;
  const fsLadder = lowerer.lowerFsLadderCall(expr, bi, loc);
  if (fsLadder) return fsLadder;
  const cryptoServed = lowerer.lowerCryptoModuleCall(expr, bi, loc);
  if (cryptoServed) return cryptoServed;
  const timersInterval = lowerer.lowerTimersPromisesSetInterval(expr, bi, loc);
  if (timersInterval) return timersInterval;
  const nodeModuleServed = lowerNodeModuleCall(lowerer, expr, bi, loc);
  if (nodeModuleServed) return nodeModuleServed;
  const builtinFn = builtinModuleFnOf(lowerer, bi.module, bi.member);
  if (!builtinFn) {
    lowerer.noLowering(
      `${bi.module}.${bi.member}`,
      expr,
      builtinFenceHintOf(bi.module, bi.member),
      namespaceMember ? lowerer.checker.getSymbolAtLocation(namespaceMember)
        : ts.isIdentifier(expr.expression) ? lowerer.resolveValueSymbol(expr.expression) : undefined,
    );
  }
  return lowerer.lowerBuiltinModuleCall(expr, bi, builtinFn, loc);
}
