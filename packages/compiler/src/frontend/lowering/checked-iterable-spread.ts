import { DYN, STRING, type IrExpr, type SrcLoc } from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import { newFnCtx, type Lowerer } from "./lowerer.js";
import { lowerCheckedArrayFrom } from "./lower-containers.js";

/** Spread consumes the iterator protocol, including native class methods. */
export function checkedIterableSpread(lowerer: Lowerer, source: IrExpr, spelling: string, loc: SrcLoc): IrExpr {
  const name = "%spread.iterable";
  if (!lowerer.liftedFns.some((fn) => fn.name === name)) {
    const context = newFnCtx(false, null, null, DYN);
    lowerer.fnStack.push(context);
    try {
      const params = [{ localId: "source", name: "source", type: DYN }, { localId: "spelling", name: "spelling", type: STRING }];
      const result = lowerCheckedArrayFrom(lowerer, varRef("source", DYN, loc), loc, undefined, undefined, false, varRef("spelling", STRING, loc));
      lowerer.liftedFns.push({ name, params, returnType: DYN,
        locals: [...params.map((param) => ({ id: param.localId, name: param.name, type: param.type, mutable: false })), ...context.locals],
        body: [{ kind: "return", value: result, loc }], loc });
    } finally {
      lowerer.fnStack.pop();
    }
  }
  return { kind: "call", callee: name, args: [lowerer.coerceToExpected(source, DYN), { kind: "strLit", value: spelling, type: STRING, loc }], type: DYN, loc };
}
