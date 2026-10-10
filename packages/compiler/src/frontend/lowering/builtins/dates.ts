import * as ts from "../../ts7/adapter.js";
import { type Lowerer, own } from "../lowerer.js";
import { locOf } from "../../program.js";
import { DATE_T, DYN, F64, type IrExpr, type IrLibFn, STRING } from "../../../ir/ir.js";

const DATE_GETTER_FNS: Readonly<Record<string, IrLibFn>> = {
  getFullYear: "date.getFullYear",
  getUTCFullYear: "date.getUTCFullYear",
  getMonth: "date.getMonth",
  getUTCMonth: "date.getUTCMonth",
  getDate: "date.getDate",
  getUTCDate: "date.getUTCDate",
  getDay: "date.getDay",
  getUTCDay: "date.getUTCDay",
  getHours: "date.getHours",
  getUTCHours: "date.getUTCHours",
  getMinutes: "date.getMinutes",
  getUTCMinutes: "date.getUTCMinutes",
  getSeconds: "date.getSeconds",
  getUTCSeconds: "date.getUTCSeconds",
  getMilliseconds: "date.getMilliseconds",
  getUTCMilliseconds: "date.getUTCMilliseconds",
  getTimezoneOffset: "date.getTimezoneOffset",
};

const DATE_METHOD_HINT =
  "getTime(), valueOf(), toISOString(), the local/UTC calendar getters, getTimezoneOffset(), and UTC setters on a local Date are supported; local-time setters and locale/string formatters have no lowering";

const DATE_UTC_SETTERS: Readonly<
  Record<string, { fn: IrLibFn; min: number; max: number; slots: number }>
> = {
  setUTCFullYear: { fn: "date.setUTCFullYear", min: 1, max: 3, slots: 3 },
  setUTCMonth: { fn: "date.setUTCMonth", min: 1, max: 2, slots: 2 },
  setUTCDate: { fn: "date.setUTCDate", min: 1, max: 1, slots: 1 },
  setUTCHours: { fn: "date.setUTCHours", min: 1, max: 4, slots: 4 },
  setUTCMinutes: { fn: "date.setUTCMinutes", min: 1, max: 3, slots: 3 },
  setUTCSeconds: { fn: "date.setUTCSeconds", min: 1, max: 2, slots: 2 },
  setUTCMilliseconds: { fn: "date.setUTCMilliseconds", min: 1, max: 1, slots: 1 },
};

/** The Date slice: statics plus TimeClip millisecond scalars. UTC setters
 * write the new scalar back onto a local or parameter. Construction lives
 * in lowerNew; identity and local-time setters remain fenced. */
export function lowerDateCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  const loc = locOf(call);
  if (lowerer.stdlibGlobalMember(access, "Date") === "now") {
    if (call.arguments.length !== 0) {
      lowerer.noLowering(`Date.now with ${call.arguments.length} arguments`, call);
    }
    return { kind: "libCall", fn: "date.now", args: [], type: F64, loc };
  }
  // Date.parse uses the same bounded date-string parser as
  // new Date(dateString).getTime(); keep their NaN and TimeClip behavior
  // identical for the ISO timestamps used by CLI applications.
  if (lowerer.stdlibGlobalMember(access, "Date") === "parse") {
    if (call.arguments.length !== 1 || ts.isSpreadElement(call.arguments[0]!)) {
      lowerer.noLowering(`Date.parse with ${call.arguments.length} arguments`, call);
    }
    const input = lowerer.lowerExprExpecting(call.arguments[0]!, STRING);
    return { kind: "libCall", fn: "date.parse", args: [input], type: F64, loc };
  }
  // Date.UTC(year[, month[, date[, hours[, minutes[, seconds[, ms]]]]]]):
  // a pure function of its numbers — the runtime's MakeDay/MakeTime/
  // TimeClip. Omitted trailing arguments complete with the spec's
  // defaults (month 0, date 1, time parts 0); tsc pins every present
  // argument to number, so the seven-f64 ABI is exact.
  if (lowerer.stdlibGlobalMember(access, "Date") === "UTC") {
    if (
      call.arguments.length < 1 ||
      call.arguments.length > 7 ||
      call.arguments.some((a) => ts.isSpreadElement(a))
    ) {
      lowerer.noLowering(`Date.UTC with ${call.arguments.length} arguments`, call);
    }
    const defaults = [0, 0, 1, 0, 0, 0, 0]; // year is always present (arity ≥ 1)
    const args: IrExpr[] = [];
    for (let i = 0; i < 7; i++) {
      const a = call.arguments[i];
      args.push(
        a !== undefined
          ? lowerer.lowerExprExpecting(a, F64)
          : { kind: "numLit", value: defaults[i]!, type: F64, loc },
      );
    }
    return { kind: "libCall", fn: "date.utc", args, type: F64, loc };
  }
  if (lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind !== "date") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const utcSetter = own(DATE_UTC_SETTERS, name);
  if (utcSetter) return lowerUtcDateSetter(lowerer, call, access, name, utcSetter);
  if (call.arguments.length !== 0) {
    lowerer.noLowering(`Date.prototype.${name} with arguments`, call, DATE_METHOD_HINT);
  }
  const raw = lowerer.lowerExpr(access.expression);
  const receiver: IrExpr =
    raw.type.kind === "dyn"
      ? { kind: "libCall", fn: "date.checkedValue", args: [raw], type: { kind: "date" }, loc }
      : raw;
  if (receiver.type.kind !== "date")
    lowerer.badType(access.expression, lowerer.typeOf(access.expression));
  if (name === "getTime" || name === "valueOf") {
    return {
      kind: "libCall",
      fn: name === "getTime" ? "date.getTime" : "date.valueOf",
      args: [receiver],
      type: F64,
      loc,
    };
  }
  if (name === "toISOString") {
    return { kind: "libCall", fn: "date.toISOStringValue", args: [receiver], type: STRING, loc };
  }
  const fn = own(DATE_GETTER_FNS, name);
  if (fn !== undefined) {
    return { kind: "libCall", fn, args: [receiver], type: F64, loc };
  }
  lowerer.noLowering(
    `Date.prototype.${name}`,
    call,
    DATE_METHOD_HINT,
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

/** JS `new Date` is a native handle. A UTC setter mutates that handle;
 * the call's number result is the new time value. */
function nativeDateReceiver(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  const expr = access.expression;
  if (ts.isIdentifier(expr)) {
    const local = lowerer.resolveLocal(expr);
    if (local?.type.kind === "date") return null;
    if (local?.type.kind === "dyn") {
      return { kind: "varRef", localId: local.id, type: DYN, loc: locOf(expr) };
    }
  }
  const recv = lowerer.lowerExpr(expr);
  return recv.type.kind === "dyn" ? recv : null;
}

function dynUtcDateSetter(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  name: string,
  recv: IrExpr,
): IrExpr {
  const loc = locOf(call);
  return {
    kind: "dynInvoke",
    recv,
    method: name,
    calleeName: access.getText(),
    args: call.arguments
      .filter((arg): arg is ts.Expression => !ts.isSpreadElement(arg))
      .map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
    type: DYN,
    loc,
  };
}

type UtcSetterSpec = { fn: IrLibFn; min: number; max: number; slots: number };

function rejectSpreadUtcSetter(
  lowerer: Lowerer,
  call: ts.CallExpression,
  name: string,
): void {
  if (!call.arguments.some((arg) => ts.isSpreadElement(arg))) return;
  lowerer.noLowering(`Date.prototype.${name}`, call, "UTC setters do not accept a spread");
}

function rejectUtcSetterArity(
  lowerer: Lowerer,
  call: ts.CallExpression,
  name: string,
  spec: UtcSetterSpec,
): void {
  const count = call.arguments.length;
  if (count >= spec.min && count <= spec.max) return;
  lowerer.noLowering(`Date.prototype.${name} with ${count} arguments`, call, DATE_METHOD_HINT);
}

function scalarDateLocal(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  name: string,
) {
  if (!ts.isIdentifier(access.expression)) {
    lowerer.noLowering(
      `Date.prototype.${name}`,
      call,
      "UTC setters update a local or parameter Date; other receivers have no lowering",
    );
  }
  const local = lowerer.resolveLocal(access.expression);
  if (local?.type.kind === "date") return local;
  lowerer.noLowering(
    `Date.prototype.${name}`,
    call,
    "UTC setters update a local or parameter Date; other receivers have no lowering",
  );
}

function noteDateWriteback(lowerer: Lowerer, localId: string): void {
  const paramIndex = lowerer.ctx.paramIndexByLocal?.get(localId);
  if (paramIndex === undefined || lowerer.ctx.dateWriteback !== undefined) return;
  lowerer.ctx.dateWriteback = { localId, index: paramIndex };
}

function scalarUtcArgs(
  lowerer: Lowerer,
  localId: string,
  args: readonly ts.Expression[],
  slots: number,
  loc: ReturnType<typeof locOf>,
): IrExpr[] {
  const libArgs: IrExpr[] = [{ kind: "varRef", localId, type: DATE_T, loc }];
  for (let i = 0; i < slots; i++) {
    const arg = args[i];
    libArgs.push(
      arg !== undefined
        ? lowerer.lowerExprExpecting(arg, F64)
        : { kind: "numLit", value: 0, type: F64, loc },
    );
  }
  if (slots > 1) libArgs.push({ kind: "numLit", value: args.length - 1, type: F64, loc });
  return libArgs;
}

function assignScalarUtcDate(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  name: string,
  spec: UtcSetterSpec,
): IrExpr {
  const loc = locOf(call);
  const local = scalarDateLocal(lowerer, call, access, name);
  local.mutable = true;
  noteDateWriteback(lowerer, local.id);
  const args = call.arguments.filter((arg): arg is ts.Expression => !ts.isSpreadElement(arg));
  return {
    kind: "assignExpr",
    localId: local.id,
    value: {
      kind: "libCall",
      fn: spec.fn,
      args: scalarUtcArgs(lowerer, local.id, args, spec.slots, loc),
      type: DATE_T,
      loc,
    },
    type: DATE_T,
    loc,
  };
}

/** `date.setUTC*(...)` on a local or parameter: the lib call returns the
 * new scalar, and the binding is updated so a later getTime sees it.
 * A parameter records write-back so the caller assigns the returned scalar.
 * A native date handle is updated in place instead. */
function lowerUtcDateSetter(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  name: string,
  spec: UtcSetterSpec,
): IrExpr {
  rejectSpreadUtcSetter(lowerer, call, name);
  const native = nativeDateReceiver(lowerer, access);
  if (native) return dynUtcDateSetter(lowerer, call, access, name, native);
  rejectUtcSetterArity(lowerer, call, name, spec);
  return assignScalarUtcDate(lowerer, call, access, name, spec);
}
