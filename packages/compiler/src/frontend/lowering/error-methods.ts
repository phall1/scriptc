import { BOOL, DYN, STRING, type IrExpr, type IrFunction, type IrStmt, type IrType } from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import type { Lowerer } from "./lowerer.js";
import { classPrototypeData, hasClassPrototypeData } from "./class-prototypes.js";
import { classMethodValue } from "./class-method-values.js";

const helperName = "%error.toString.method";
const errorType: IrType = { kind: "object", className: "%Error" };

/** Select at extraction time, preserving detached function identity and
 * binding the receiver only when the selected function is called. */
export function errorToStringMethod(lowerer: Lowerer, receiver: IrExpr): Extract<IrExpr, { kind: "call" }> {
  const loc = receiver.loc;
  if (!lowerer.liftedFns.some((fn) => fn.name === helperName)) {
    lowerer.liftedFns.push({
      name: helperName,
      params: [{ localId: "error.0", name: "error", type: errorType }],
      returnType: DYN,
      locals: [{ id: "error.0", name: "error", type: errorType, mutable: false }],
      body: [], loc,
    });
  }
  return { kind: "call", callee: helperName, args: [lowerer.upcastTo(receiver, "%Error")], type: DYN, loc };
}

export function errorToStringCall(lowerer: Lowerer, receiver: IrExpr): IrExpr {
  const loc = receiver.loc;
  const method = errorToStringMethod(lowerer, receiver);
  const name = "%error.toString.virtual";
  if (!lowerer.liftedFns.some((fn) => fn.name === name)) {
    const value = varRef("error.0", errorType, loc);
    lowerer.liftedFns.push({
      name, params: [{ localId: "error.0", name: "error", type: errorType }], returnType: STRING,
      locals: [{ id: "error.0", name: "error", type: errorType, mutable: false }],
      body: [{ kind: "return", value: { kind: "dynCheck", type: STRING, loc, value: {
        kind: "dynCall", callee: { ...method, args: [value] },
        receiver: { kind: "dynFrom", value, type: DYN, loc }, calleeName: "error.toString", args: [], type: DYN, loc,
      } }, loc }], loc,
    });
  }
  return { kind: "call", callee: name, args: [lowerer.upcastTo(receiver, "%Error")], type: STRING, loc };
}

/** Runtime Error vtables have no user slots. Walk most-derived declarations
 * and their own prototype data, retaining the builtin method as fallback. */
export function refreshErrorMethodDispatch(lowerer: Lowerer, functions: readonly IrFunction[]): boolean {
  const helper = functions.find((fn) => fn.name === helperName);
  if (!helper) return false;
  const overrides = [...lowerer.classes.values()].filter((info) =>
    !info.builtinError && (info.methods.has("toString") || hasClassPrototypeData(info)) && lowerer.isSubclassOf(info.def.name, "%Error"));
  overrides.sort((a, b) => lowerer.isSubclassOf(a.def.name, b.def.name) ? -1 : lowerer.isSubclassOf(b.def.name, a.def.name) ? 1 : 0);
  const revision = JSON.stringify(overrides.map((info) => [info.def.name, hasClassPrototypeData(info), info.methods.has("toString")]));
  if (lowerer.errorMethodDispatchRevision === revision) return false;
  lowerer.errorMethodDispatchRevision = revision;
  const loc = helper.loc;
  const value = varRef("error.0", errorType, loc);
  const key: IrExpr = { kind: "strLit", value: "toString", type: STRING, loc };
  const body: IrStmt[] = [];
  for (const info of overrides) {
    const receiver: IrExpr = { kind: "downcast", value, type: { kind: "object", className: info.def.name }, loc };
    const branch: IrStmt[] = [];
    const prototype = hasClassPrototypeData(info) ? classPrototypeData(lowerer, info, loc, receiver) : null;
    if (prototype) branch.push({
      kind: "if", cond: { kind: "libCall", fn: "dyn.hasOwn", args: [prototype, key], type: BOOL, loc },
      then: [{ kind: "return", value: { kind: "dynKeyGet", value: prototype, key, type: DYN, loc }, loc }], else_: null, loc,
    });
    if (info.methods.has("toString")) {
      const method = classMethodValue(lowerer, info.decl!, info, "toString", loc)!;
      branch.push({ kind: "return", value: { kind: "dynFrom", value: method, type: DYN, loc }, loc });
    }
    body.push({ kind: "if", cond: { kind: "instanceOf", value, className: info.def.name, type: BOOL, loc }, then: branch, else_: null, loc });
  }
  const builtin = lowerer.classes.get("%Error")!;
  // Runtime-provided classes have no declaration. Keep the diagnostic
  // location valid even when the program has no user Error overrides.
  const method = classMethodValue(lowerer, overrides[0]?.decl ?? lowerer.entry, builtin, "toString", loc)!;
  body.push({ kind: "return", value: { kind: "dynFrom", value: method, type: DYN, loc }, loc });
  helper.body = body;
  return true;
}
