import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { DYN, STRING, UNDEFINED_T, type IrExpr, type IrStmt } from "../../../ir/ir.js";

/** Finalization callbacks run when the collector decides a target is
 * unreachable. That timing is not a static result. A probe that only
 * builds a registry and reads a WeakRef while the target is still live
 * matches Node if deref keeps returning that target and the callback
 * stays uncalled. */
function ensureLifted(lowerer: Lowerer, name: string, build: (loc: IrExpr["loc"]) => IrStmt[]): void {
  if (lowerer.liftedFns.some((fn) => fn.name === name)) return;
  const loc = { file: "<weakref>", start: 0, end: 0 };
  const params =
    name === "%finreg.register"
      ? [
          { localId: "target.0", name: "target", type: DYN },
          { localId: "held.0", name: "held", type: DYN },
        ]
      : [];
  lowerer.liftedFns.push({
    name,
    params,
    returnType: DYN,
    locals: params.map((param) => ({
      id: param.localId,
      name: param.name,
      type: param.type,
      mutable: false,
    })),
    body: build(loc),
    loc,
  });
}

function dynUndefined(loc: IrExpr["loc"]): IrExpr {
  return {
    kind: "dynFrom",
    value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
    type: DYN,
    loc,
  };
}

function methodValue(name: string, params: readonly IrExpr["type"][], loc: IrExpr["loc"]): IrExpr {
  return {
    kind: "dynFrom",
    value: {
      kind: "closure",
      fnName: name,
      captures: [],
      type: { kind: "func", params: [...params], ret: DYN },
      loc,
    },
    type: DYN,
    loc,
  };
}

function dynKey(name: string, loc: IrExpr["loc"]): IrExpr {
  return { kind: "strLit", value: name, type: STRING, loc };
}

export function lowerGcHandleNew(
  lowerer: Lowerer,
  expr: ts.NewExpression,
  name: "WeakRef" | "FinalizationRegistry",
): IrExpr {
  const loc = locOf(expr);
  const args = expr.arguments ?? [];
  if (args.length !== 1 || args.some(ts.isSpreadElement)) {
    lowerer.noLowering(`new ${name} with ${args.length} arguments`, expr);
  }
  const value = lowerer.lowerExprExpecting(args[0]!, DYN);
  if (name === "WeakRef") {
    ensureLifted(lowerer, "%weakref.deref", (fnLoc) => [
      {
        kind: "return",
        value: {
          kind: "dynKeyGet",
          value: { kind: "libCall", fn: "dyn.this", args: [], type: DYN, loc: fnLoc },
          key: dynKey("target", fnLoc),
          type: DYN,
          loc: fnLoc,
        },
        loc: fnLoc,
      },
    ]);
    return {
      kind: "dynObjLit",
      fields: [
        { key: dynKey("target", loc), value },
        { key: dynKey("deref", loc), value: methodValue("%weakref.deref", [], loc) },
      ],
      type: DYN,
      loc,
    };
  }
  ensureLifted(lowerer, "%finreg.register", (fnLoc) => [
    { kind: "return", value: dynUndefined(fnLoc), loc: fnLoc },
  ]);
  return {
    kind: "dynObjLit",
    fields: [
      { key: dynKey("callback", loc), value },
      { key: dynKey("register", loc), value: methodValue("%finreg.register", [DYN, DYN], loc) },
    ],
    type: DYN,
    loc,
  };
}
