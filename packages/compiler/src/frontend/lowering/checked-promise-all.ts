import { CAUGHT, DYN, type IrExpr, type IrType, type SrcLoc } from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import { newFnCtx, type Lowerer } from "./lowerer.js";
import { checkedIterableSpread } from "./checked-iterable-spread.js";

/** JavaScript builds Promise.all inputs at runtime. Iterator failures
 * reject its result instead of escaping the synchronous call. */
export function checkedPromiseAll(lowerer: Lowerer, source: IrExpr, loc: SrcLoc): IrExpr {
  const name = "%promise.all.checked";
  const type: IrType = { kind: "promise", inner: DYN };
  if (!lowerer.liftedFns.some((fn) => fn.name === name)) {
    const context = newFnCtx(false, null, null, type);
    lowerer.fnStack.push(context);
    try {
      const entries = checkedIterableSpread(lowerer, varRef("source", DYN, loc), "", loc);
      lowerer.liftedFns.push({ name, params: [{ localId: "source", name: "source", type: DYN }], returnType: type,
        locals: [{ id: "source", name: "source", type: DYN, mutable: false },
          { id: "error", name: "error", type: CAUGHT, mutable: false }, ...context.locals],
        body: [{ kind: "tryCatch", tryBody: [
          { kind: "return", value: { kind: "libCall", fn: "dyn.promiseAll", args: [entries], type, loc }, loc },
        ], catchLocalId: "error", catchBody: [
          { kind: "return", value: { kind: "intrinsic", name: "promise.reject",
            args: [{ kind: "caughtToDyn", value: varRef("error", CAUGHT, loc), type: DYN, loc }], type, loc }, loc },
        ], finallyBody: null, loc }], loc });
    } finally {
      lowerer.fnStack.pop();
    }
  }
  return { kind: "call", callee: name, args: [lowerer.coerceToExpected(source, DYN)], type, loc };
}
