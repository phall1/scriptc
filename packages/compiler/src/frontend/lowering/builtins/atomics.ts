import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { F64, type IrExpr, STRING } from "../../../ir/ir.js";

/** `Atomics.wait(int32Array, idx, expected, timeoutMs)` — the
 * synchronous-sleep idiom (RouteStore's
 * `Atomics.wait(sleepBuffer, 0, 0, ms)`): scriptc has no threads, so
 * nothing can ever notify a waiter and the spec's behavior for every
 * compilable program is exactly "compare, then sleep out the timeout"
 * — "not-equal" when the element differs, a real nanosleep and
 * "timed-out" otherwise ("ok" is unreachable). The timeout argument is
 * REQUIRED: without it Node blocks until a notify that cannot exist
 * here — a certain deadlock, fenced with that explanation. Every other
 * Atomics member (notify has no one to wake; add/load/... — nothing
 * races) fences member-qualified. Null for non-Atomics receivers. */
export function lowerAtomicsCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  const member = lowerer.stdlibGlobalMember(access, "Atomics");
  if (member === null) return null;
  const loc = locOf(call);
  if (member !== "wait") {
    lowerer.noLowering(
      `Atomics.${member}`,
      call,
      "Atomics.wait(int32Array, idx, expected, timeoutMs) is the supported Atomics surface " +
        "(scriptc has no threads — wait is the synchronous-sleep idiom, and nothing else has anyone to race)",
      lowerer.checker.getSymbolAtLocation(access.name),
    );
  }
  if (call.arguments.length !== 4 || call.arguments.some(ts.isSpreadElement)) {
    lowerer.noLowering(
      `Atomics.wait with ${call.arguments.length} arguments`,
      call,
      "the timeout is required: without it the wait blocks forever — scriptc has no threads, " +
        "so no notify can ever arrive (Atomics.wait(arr, idx, expected, timeoutMs))",
    );
  }
  const arrNode = call.arguments[0]!;
  const arrIr = lowerer.mapTypeOf(lowerer.typeOf(arrNode));
  if (!(arrIr?.kind === "bytes" && arrIr.elem === "i32")) {
    lowerer.noLowering(
      `Atomics.wait over '${lowerer.checker.typeToString(lowerer.typeOf(arrNode))}' values`,
      arrNode,
      "an Int32Array is the supported waitable array",
    );
  }
  const arr = lowerer.lowerExpr(arrNode);
  const idx = lowerer.lowerExprExpecting(call.arguments[1]!, F64);
  const expected = lowerer.lowerExprExpecting(call.arguments[2]!, F64);
  const timeout = lowerer.lowerExprExpecting(call.arguments[3]!, F64);
  return {
    kind: "libCall",
    fn: "atomics.wait",
    args: [arr, idx, expected, timeout],
    type: STRING,
    loc,
  };
}
