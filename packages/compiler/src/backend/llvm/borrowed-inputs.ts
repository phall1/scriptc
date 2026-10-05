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

/** A projection or writable binding can borrow across later operands only
 * while every operation preserves existing owners. Compute suffix facts
 * once, keeping left-to-right evaluation and the owning fallback for each
 * argument independently. The consumer must borrow all inputs and preserve
 * reference edges itself; mutating runtime operations use emitBorrowedInput. */
export function borrowableInputs(
  host: LlvmEmitterContext,
  inputs: readonly IrExpr[],
  consumerPreserves = true,
): boolean[] {
  const result: boolean[] = new Array(inputs.length);
  let preserves = consumerPreserves;
  for (let i = inputs.length - 1; i >= 0; i--) {
    const value = inputs[i]!;
    result[i] = host.canBorrowCallArgument(value) || (preserves && host.canBorrowReceiver(value));
    preserves = preserves && host.referenceEffects.preserves(value);
  }
  return result;
}

export function emitBorrowedInputs(host: LlvmEmitterContext, inputs: readonly IrExpr[]): LlValue[] {
  const borrowed = borrowableInputs(host, inputs);
  return inputs.map((value, index) =>
    borrowed[index] ? host.emitReadReceiver(value) : host.emitExpr(value),
  );
}
