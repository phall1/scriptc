import { dynUndefinedExpr } from "../../../ir/build.js";
import type { IrExpr, IrFunction, IrType, SrcLoc } from "../../../ir/ir.js";
import { DYN, STRING } from "../../../ir/ir.js";
import { locOf } from "../../program.js";
import type { Lowerer } from "../lowerer.js";
import * as ts from "../../ts7/adapter.js";

const WRAP = "%formData.wrap";
const APPEND = "%formData.append";
const ENTRIES = "%formData.entries";
const ENTRIES_LOCAL = "entries.0";

const APPEND_TYPE: IrType = { kind: "func", params: [DYN, DYN], ret: DYN };
const ENTRIES_TYPE: IrType = { kind: "func", params: [], ret: DYN };

/** `new FormData()` with no arguments. The value is a checked-dynamic object
 * whose append() records string pairs and whose entries() iterates them.
 * That is the subset Effect's schema helpers construct and read. */
export function lowerFormDataNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr {
  const args = expr.arguments ?? [];
  if (args.length !== 0 || args.some((arg) => ts.isSpreadElement(arg))) {
    lowerer.noLowering(
      `new FormData with ${args.length} argument${args.length === 1 ? "" : "s"}`,
      expr,
      "new FormData() with no arguments is supported",
    );
  }
  const loc = locOf(expr);
  ensureFormDataFactory(lowerer, loc);
  return {
    kind: "call",
    callee: WRAP,
    args: [{ kind: "dynArrLit", elems: [], type: DYN, loc }],
    type: DYN,
    loc,
  };
}

function ensureFormDataFactory(lowerer: Lowerer, loc: SrcLoc): void {
  if (lowerer.liftedFns.some((fn) => fn.name === WRAP)) return;
  const entriesRef: IrExpr = { kind: "varRef", localId: ENTRIES_LOCAL, type: DYN, loc };
  const str = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
  const keyRef: IrExpr = { kind: "varRef", localId: "key.0", type: DYN, loc };
  const valueRef: IrExpr = { kind: "varRef", localId: "value.0", type: DYN, loc };
  const keyText: IrExpr = {
    kind: "dynFrom",
    value: { kind: "libCall", fn: "dyn.toStringCoerce", args: [keyRef], type: STRING, loc },
    type: DYN,
    loc,
  };
  const append: IrFunction = {
    name: APPEND,
    params: [
      { localId: "key.0", name: "key", type: DYN },
      { localId: "value.0", name: "value", type: DYN },
    ],
    returnType: DYN,
    captures: [{ localId: ENTRIES_LOCAL, name: "entries", type: DYN }],
    locals: [
      { id: ENTRIES_LOCAL, name: "entries", type: DYN, mutable: false, boxed: true },
      { id: "key.0", name: "key", type: DYN, mutable: false },
      { id: "value.0", name: "value", type: DYN, mutable: false },
    ],
    body: [
      {
        kind: "exprStmt",
        expr: {
          kind: "dynInvoke",
          recv: entriesRef,
          method: "push",
          calleeName: "push",
          args: [{ kind: "dynArrLit", elems: [keyText, valueRef], type: DYN, loc }],
          type: DYN,
          loc,
        },
        loc,
      },
      { kind: "return", value: dynUndefinedExpr(loc), loc },
    ],
    loc,
  };
  const readEntries: IrFunction = {
    name: ENTRIES,
    params: [],
    returnType: DYN,
    captures: [{ localId: ENTRIES_LOCAL, name: "entries", type: DYN }],
    locals: [{ id: ENTRIES_LOCAL, name: "entries", type: DYN, mutable: false, boxed: true }],
    body: [{ kind: "return", value: entriesRef, loc }],
    loc,
  };
  const wrap: IrFunction = {
    name: WRAP,
    params: [{ localId: ENTRIES_LOCAL, name: "entries", type: DYN }],
    returnType: DYN,
    locals: [{ id: ENTRIES_LOCAL, name: "entries", type: DYN, mutable: false, boxed: true }],
    body: [
      {
        kind: "return",
        value: {
          kind: "dynObjLit",
          fields: [
            {
              key: str("append"),
              value: {
                kind: "dynFrom",
                value: {
                  kind: "closure",
                  fnName: APPEND,
                  captures: [ENTRIES_LOCAL],
                  type: APPEND_TYPE,
                  loc,
                },
                fnName: "append",
                type: DYN,
                loc,
              },
            },
            {
              key: str("entries"),
              value: {
                kind: "dynFrom",
                value: {
                  kind: "closure",
                  fnName: ENTRIES,
                  captures: [ENTRIES_LOCAL],
                  type: ENTRIES_TYPE,
                  loc,
                },
                fnName: "entries",
                type: DYN,
                loc,
              },
            },
          ],
          type: DYN,
          loc,
        },
        loc,
      },
    ],
    loc,
  };
  lowerer.liftedFns.push(append, readEntries, wrap);
}
