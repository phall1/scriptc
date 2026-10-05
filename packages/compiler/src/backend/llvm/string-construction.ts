import type { IrExpr } from "../../ir/ir.js";
import type { LlValue, LlvmEmitterContext } from "./expr-context.js";
import { emitStringInputs } from "./string-lifetimes.js";

const MAX_PARTS = 16;

/** Flatten only string concatenation, preserving conversion and operand
 * order. Larger trees remain operands of bounded groups, so each call uses
 * at most sixteen stack slots and does not need a heap argument array. */
export function stringParts(value: IrExpr): IrExpr[] {
  const pending = [value];
  const parts: IrExpr[] = [];
  while (pending.length > 0) {
    const part = pending.pop()!;
    if (part.kind === "strConcat" && parts.length + pending.length < MAX_PARTS - 1) {
      pending.push(part.right, part.left);
    } else {
      parts.push(part);
    }
  }
  return parts;
}

/** The runtime borrows every part without mutating it. Earlier operands
 * therefore borrow only when their owners survive all later evaluations;
 * other operands retain ordinary snapshots and exception cleanup. */
export function emitStringParts(host: LlvmEmitterContext, parts: readonly IrExpr[]): LlValue {
  const values = emitStringInputs(host, parts);
  const B = host.B;
  const storage = B.slot();
  B.entryAllocas.push(`${storage} = alloca [${parts.length} x ptr]`);
  for (let i = 0; i < values.length; i++) {
    const slot = B.tmp();
    B.line(`${slot} = getelementptr [${parts.length} x ptr], ptr ${storage}, i32 0, i32 ${i}`);
    B.line(`store ptr ${values[i]!.name}, ptr ${slot}`);
  }
  host.declare(`declare ptr @scr_str_concat_parts(ptr, ${host.sizeType})`);
  const result = B.tmp();
  B.line(`${result} = call ptr @scr_str_concat_parts(ptr ${storage}, ${host.sizeType} ${parts.length})`);
  return host.own({ name: result, type: parts[0]!.type });
}
