import {
  BOOL,
  DYN,
  F64,
  STRING,
  UNDEFINED_T,
  type IrExpr,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { numLit, varRef } from "../../ir/build.js";
import type { Lowerer } from "./lowerer.js";

/** A number-keyed string property read whose declared result includes
 * undefined. Unlike charAt, property lookup does not truncate fractions or
 * convert NaN to zero. Capture both operands before testing the index: even
 * a plain receiver variable can be reassigned while evaluating the key. */
export function lowerOptionalStringIndex(
  lowerer: Lowerer,
  receiver: IrExpr,
  index: IrExpr,
  type: IrType,
  loc: SrcLoc,
): IrExpr {
  const textLocal = lowerer.declareHiddenLocal("%indexedString", STRING);
  const indexLocal = lowerer.declareHiddenLocal("%stringIndex", F64);
  const text = varRef(textLocal.id, STRING, loc);
  const key = varRef(indexLocal.id, F64, loc);
  const inBounds: IrExpr = {
    kind: "logical",
    op: "&&",
    left: { kind: "bin", op: ">=", left: key, right: numLit(0, loc), type: BOOL, loc },
    right: {
      kind: "bin",
      op: "<",
      left: key,
      right: { kind: "strIntrinsic", method: "length", receiver: text, args: [], type: F64, loc },
      type: BOOL,
      loc,
    },
    type: BOOL,
    loc,
  };
  const integral: IrExpr = {
    kind: "bin",
    op: "===",
    left: key,
    right: { kind: "libCall", fn: "math.floor", args: [key], type: F64, loc },
    type: BOOL,
    loc,
  };
  const read: IrExpr = {
    kind: "strIntrinsic",
    method: "charAt",
    receiver: text,
    args: [key],
    type: STRING,
    loc,
  };
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: textLocal.id, init: receiver, loc },
      { kind: "varDecl", localId: indexLocal.id, init: index, loc },
    ],
    result: {
      kind: "ternary",
      cond: { kind: "logical", op: "&&", left: inBounds, right: integral, type: BOOL, loc },
      then: lowerer.coerceToExpected(read, type),
      else_: lowerer.wrappedUndefined(type, loc)!,
      type,
      loc,
    },
    type,
    loc,
  };
}

function isStringOrUndefined(
  lowerer: Lowerer,
  unionId: string,
  arms: readonly IrType[] | undefined,
): boolean {
  return (
    arms?.length === 2 &&
    lowerer.armTag(unionId, STRING) >= 0 &&
    lowerer.armTag(unionId, UNDEFINED_T) >= 0
  );
}

function lowerMappedNumericStringIndex(
  lowerer: Lowerer,
  receiver: IrExpr,
  index: IrExpr,
  resultType: IrType | null,
  loc: SrcLoc,
): IrExpr | null {
  if (index.type.kind !== "f64" || receiver.type.kind !== "string") return null;
  if (resultType?.kind === "string") {
    return {
      kind: "strIntrinsic",
      method: "charAt",
      receiver,
      args: [index],
      type: STRING,
      loc,
    };
  }
  if (resultType?.kind !== "union") return null;
  const arms = lowerer.unions.get(resultType.unionId)?.arms;
  if (!isStringOrUndefined(lowerer, resultType.unionId, arms)) return null;
  return lowerOptionalStringIndex(lowerer, receiver, index, resultType, loc);
}

/** String element access: charAt for a string result, the optional UTF-16
 * read for `string | undefined`, and the unmapped JavaScript fallback when
 * the checker type did not map. */
export function lowerStringElement(
  lowerer: Lowerer,
  receiver: IrExpr,
  index: IrExpr,
  resultType: IrType | null,
  loc: SrcLoc,
): IrExpr | null {
  if (receiver.type.kind !== "string") return null;
  return (
    lowerMappedNumericStringIndex(lowerer, receiver, index, resultType, loc) ??
    lowerUnmappedStringIndex(lowerer, receiver, index, resultType, loc)
  );
}

/** JavaScript element access whose checker type did not map (implicit any
 * inside a monomorphized JS function). A numeric index is a UTF-16 read
 * that is undefined when missing. A string key is ordinary property lookup
 * on the boxed string, so brand keys are undefined and "length" is kept. */
export function lowerUnmappedStringIndex(
  lowerer: Lowerer,
  receiver: IrExpr,
  index: IrExpr,
  resultType: IrType | null,
  loc: SrcLoc,
): IrExpr | null {
  if (receiver.type.kind !== "string") return null;
  if (resultType !== null && resultType.kind !== "dyn") return null;
  if (index.type.kind === "f64") {
    const optional: IrType = {
      kind: "union",
      unionId: lowerer.unions.intern([STRING, UNDEFINED_T]),
    };
    return lowerer.coerceToExpected(
      lowerOptionalStringIndex(lowerer, receiver, index, optional, loc),
      DYN,
    );
  }
  if (index.type.kind !== "string") return null;
  return {
    kind: "dynKeyGet",
    value: lowerer.coerceToExpected(receiver, DYN),
    key: index,
    type: DYN,
    loc,
  };
}
