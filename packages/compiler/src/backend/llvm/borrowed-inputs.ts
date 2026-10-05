import type { IrExpr } from "../../ir/ir.js";
import type { LlValue, LlvmEmitterContext } from "./expr-context.js";

/** For a runtime input whose ABI borrows rather than consumes ownership.
 * An unchanged, unboxed local owns its value across all later arguments and
 * the operation, including callbacks and collection mutation. Projections,
 * globals, captures and reassigned bindings keep their ordinary snapshots.
 * Stored values that move into a container must still use emitExpr. */
export function emitBorrowedInput(host: LlvmEmitterContext, value: IrExpr): LlValue {
  return host.canBorrowCallArgument(value) ? host.emitReadReceiver(value) : host.emitExpr(value);
}
