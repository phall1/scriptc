import type { IntegerCountedForLoop } from "../../ir/integer-loops.js";
import type { LlvmEmitterContext } from "./expr-context.js";
import { f64Lit } from "./common.js";

/** The caller has proved or guarded the direction's finite endpoint. Clamp
 * the opposite infinity before integer conversion. Fractional limits become
 * exclusive integer endpoints for signed comparisons in either direction. */
export function emitCountedLoopLimit(host: LlvmEmitterContext, loop: IntegerCountedForLoop): string {
  const ascending = loop.step > 0;
  if (loop.limit.kind === "numLit") {
    const value = ascending ? Math.max(-(2 ** 53), loop.limit.value) : Math.min(2 ** 53, loop.limit.value);
    return String(ascending ? loop.inclusive ? Math.floor(value) + 1 : Math.ceil(value)
      : loop.inclusive ? Math.ceil(value) - 1 : Math.floor(value));
  }
  const B = host.B;
  const value = host.emitExpr(loop.limit);
  const within = B.tmp(), bounded = B.tmp(), rounded = B.tmp(), integer = B.tmp();
  const clamp = ascending ? -(2 ** 53) : 2 ** 53;
  B.line(`${within} = fcmp ${ascending ? "oge" : "ole"} double ${value.name}, ${f64Lit(clamp)}`);
  B.line(`${bounded} = select i1 ${within}, double ${value.name}, double ${f64Lit(clamp)}`);
  const rounding = ascending === loop.inclusive ? "floor" : "ceil";
  host.declare(`declare double @llvm.${rounding}.f64(double)`);
  B.line(`${rounded} = call double @llvm.${rounding}.f64(double ${bounded})`);
  B.line(`${integer} = fptosi double ${rounded} to i64`);
  if (!loop.inclusive) return integer;
  const limit = B.tmp();
  B.line(`${limit} = add nsw i64 ${integer}, ${ascending ? 1 : -1}`);
  return limit;
}
