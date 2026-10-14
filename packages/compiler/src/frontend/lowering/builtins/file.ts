import { dynUndefinedExpr } from "../../../ir/build.js";
import type { IrExpr, IrFunction, IrStmt, SrcLoc } from "../../../ir/ir.js";
import { BOOL, DYN, F64, STRING } from "../../../ir/ir.js";
import { locOf } from "../../program.js";
import type { Lowerer } from "../lowerer.js";
import * as ts from "../../ts7/adapter.js";

const FACTORY = "%file.new";
const READ_BYTES = "%file.arrayBuffer";
const PARTS = "parts.0";

/** `new File(parts, name, options?)` from JavaScript. Effect's schema builds
 * one from a byte list plus a name and `{ type, lastModified }`, then reads
 * those fields and `arrayBuffer()`. Other argument shapes stay fenced. */
export function lowerFileNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr {
  const args = expr.arguments ?? [];
  if (args.length < 2 || args.length > 3 || args.some((arg) => ts.isSpreadElement(arg))) {
    lowerer.noLowering(
      `new File with ${args.length} argument${args.length === 1 ? "" : "s"}`,
      expr,
      "new File(parts, name) and new File(parts, name, options) are supported",
    );
  }
  const loc = locOf(expr);
  ensureFileFactory(lowerer, loc);
  const lowered = args.map((arg) => lowerer.lowerExprExpecting(arg, DYN));
  return {
    kind: "call",
    callee: FACTORY,
    args:
      lowered.length === 3 ? lowered : [...lowered, dynUndefinedExpr(loc)],
    type: DYN,
    loc,
  };
}

function str(value: string, loc: SrcLoc): IrExpr {
  return { kind: "strLit", value, type: STRING, loc };
}

function dynStr(value: string, loc: SrcLoc): IrExpr {
  return { kind: "dynFrom", value: str(value, loc), type: DYN, loc };
}

function box(value: IrExpr, loc: SrcLoc): IrExpr {
  return value.type.kind === "dyn" ? value : { kind: "dynFrom", value, type: DYN, loc };
}

function ref(id: string, loc: SrcLoc): IrExpr {
  return { kind: "varRef", localId: id, type: DYN, loc };
}

function keyGet(value: IrExpr, name: string, loc: SrcLoc): IrExpr {
  return {
    kind: "dynKeyGet",
    value,
    key: str(name, loc),
    type: DYN,
    loc,
  };
}

function nullish(value: IrExpr, loc: SrcLoc): IrExpr {
  return { kind: "dynTest", test: "nullish", value, type: BOOL, loc };
}

function textOf(value: IrExpr, loc: SrcLoc): IrExpr {
  return box(
    { kind: "libCall", fn: "dyn.toStringCoerce", args: [value], type: STRING, loc },
    loc,
  );
}

function numberOf(value: IrExpr, loc: SrcLoc): IrExpr {
  return box(
    { kind: "libCall", fn: "dyn.toNumberCoerce", args: [value], type: F64, loc },
    loc,
  );
}

function ensureFileFactory(lowerer: Lowerer, loc: SrcLoc): void {
  if (lowerer.liftedFns.some((fn) => fn.name === FACTORY)) return;
  const parts = ref(PARTS, loc);
  const options = ref("options.0", loc);
  const first: IrExpr = {
    kind: "dynInvoke",
    recv: parts,
    method: "at",
    calleeName: "parts.at",
    args: [box({ kind: "numLit", value: 0, type: F64, loc }, loc)],
    type: DYN,
    loc,
  };
  const typeRaw = keyGet(options, "type", loc);
  const modifiedRaw = keyGet(options, "lastModified", loc);
  const now: IrExpr = { kind: "libCall", fn: "date.now", args: [], type: F64, loc };
  const typeValue: IrExpr = {
    kind: "ternary",
    cond: {
      kind: "logical",
      op: "||",
      left: nullish(options, loc),
      right: nullish(typeRaw, loc),
      type: BOOL,
      loc,
    },
    then: dynStr("", loc),
    else_: textOf(typeRaw, loc),
    type: DYN,
    loc,
  };
  const modifiedValue: IrExpr = {
    kind: "ternary",
    cond: {
      kind: "logical",
      op: "||",
      left: nullish(options, loc),
      right: nullish(modifiedRaw, loc),
      type: BOOL,
      loc,
    },
    then: box(now, loc),
    else_: numberOf(modifiedRaw, loc),
    type: DYN,
    loc,
  };
  const lengthRaw = keyGet(first, "length", loc);
  const sizeValue: IrExpr = {
    kind: "ternary",
    cond: nullish(lengthRaw, loc),
    then: box({ kind: "numLit", value: 0, type: F64, loc }, loc),
    else_: numberOf(lengthRaw, loc),
    type: DYN,
    loc,
  };
  const readBytes: IrFunction = {
    name: READ_BYTES,
    params: [],
    returnType: DYN,
    captures: [{ localId: PARTS, name: "parts", type: DYN }],
    locals: [{ id: PARTS, name: "parts", type: DYN, mutable: false, boxed: true }],
    body: [
      {
        kind: "return",
        value: box(
          {
            kind: "intrinsic",
            name: "promise.resolve",
            args: [first],
            type: { kind: "promise", inner: DYN },
            loc,
          },
          loc,
        ),
        loc,
      },
    ],
    loc,
  };
  const field = (name: string, value: IrExpr) => ({ key: str(name, loc), value });
  const body: IrStmt[] = [
    {
      kind: "return",
      value: {
        kind: "dynObjLit",
        fields: [
          field("name", textOf(ref("name.0", loc), loc)),
          field("type", typeValue),
          field("lastModified", modifiedValue),
          field("size", sizeValue),
          field(
            "arrayBuffer",
            box(
              {
                kind: "closure",
                fnName: READ_BYTES,
                captures: [PARTS],
                type: { kind: "func", params: [], ret: DYN },
                loc,
              },
              loc,
            ),
          ),
        ],
        type: DYN,
        loc,
      },
      loc,
    },
  ];
  const factory: IrFunction = {
    name: FACTORY,
    params: [
      { localId: PARTS, name: "parts", type: DYN },
      { localId: "name.0", name: "name", type: DYN },
      { localId: "options.0", name: "options", type: DYN },
    ],
    returnType: DYN,
    locals: [
      { id: PARTS, name: "parts", type: DYN, mutable: false, boxed: true },
      { id: "name.0", name: "name", type: DYN, mutable: false },
      { id: "options.0", name: "options", type: DYN, mutable: false },
    ],
    body,
    loc,
  };
  lowerer.liftedFns.push(readBytes, factory);
}
