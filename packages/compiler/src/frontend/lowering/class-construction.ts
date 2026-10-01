import { BOOL, DYN, STRING, typeEquals, typeKey, type IrExpr, type IrFunction, type IrStmt, type IrType, type SrcLoc } from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import { everyStmtList, transformExpr, transformStmtList } from "../../ir/traverse.js";
import { dynUndefinedExpr, type Lowerer } from "./lowerer.js";
import type { ParamShape } from "./lower-calls.js";
import { classPrototypeData } from "./class-prototypes.js";

const PREFIX = "%class.construct:";

/** Checked construction dispatches to emitted native constructor thunks. */
export function checkedClassConstruction(lowerer: Lowerer, callee: IrExpr, args: IrExpr[], loc: SrcLoc): IrExpr {
  const name = `${PREFIX}${args.length}`;
  if (!lowerer.liftedFns.some((fn) => fn.name === name)) {
    const params = [callee, ...args].map((_, index) => ({ localId: `p.${index}`, name: `p${index}`, type: DYN }));
    lowerer.liftedFns.push({ name, params, locals: params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
      returnType: DYN, body: [{ kind: "return", value: { kind: "libCall", fn: "bytes.construct", args: [
        varRef("p.0", DYN, loc), { kind: "dynArrLit", elems: params.slice(1).map((param) => varRef(param.localId, DYN, loc)), type: DYN, loc },
        { kind: "strLit", value: "constructor", type: STRING, loc },
      ], type: DYN, loc }, loc }], loc });
  }
  return { kind: "call", callee: name, args: [callee, ...args], type: DYN, loc };
}

function constructorArguments(lowerer: Lowerer, params: ParamShape[], incoming: IrExpr[], loc: SrcLoc): IrExpr[] | null {
  const args: IrExpr[] = [];
  let index = 0;
  for (const param of params) {
    if ((param.mode === "dynRest" || param.mode === "arguments") && param.type.kind === "dyn") {
      args.push({ kind: "dynArrLit", elems: param.mode === "arguments" ? incoming : incoming.slice(index), type: DYN, loc });
      index = incoming.length;
    } else if (param.mode === "rest" && param.type.kind === "array") {
      const elems = incoming.slice(index).map((value) => lowerer.coerceToExpected(value, param.type.kind === "array" ? param.type.elem : DYN));
      if (elems.some((value) => !typeEquals(value.type, param.type.kind === "array" ? param.type.elem : DYN))) return null;
      args.push({ kind: "arrayLit", elems, type: param.type, loc });
      index = incoming.length;
    } else {
      if (param.mode !== "required" && param.mode !== "omittable") return null;
      const value = incoming[index++] ?? param.callDefault ?? dynUndefinedExpr(loc);
      const converted = lowerer.coerceToExpected(value, param.type);
      if (!typeEquals(converted.type, param.type)) return null;
      args.push(converted);
    }
  }
  return args;
}

export class ClassConstructionDispatch {
  private readonly constructors = new Set<string>();
  private readonly completed = new Map<string, Set<string>>();
  private prototypeHelper: IrFunction | null = null;
  private readonly prototypes = new Set<string>();

  process(lowerer: Lowerer, functions: readonly IrFunction[]): boolean {
    const discover = (type: IrType): void => {
      if (type.kind === "classval") this.constructors.add(type.className);
      else if (type.kind === "union") lowerer.unions.get(type.unionId)?.arms.forEach(discover);
    };
    const prototypeReads = new Set<IrFunction>();
    for (const fn of functions) everyStmtList(fn.body, { stmt: () => true, expr: (expr) => {
      if (expr.kind === "dynFrom") discover(expr.value.type);
      if (expr.kind === "libCall" && expr.fn === "dyn.classBasePrototype") prototypeReads.add(fn);
      return true;
    } });
    let changed = false;
    for (const fn of functions) {
      if (fn === this.prototypeHelper || !prototypeReads.has(fn)) continue;
      fn.body = transformStmtList(fn.body, { stmt: (stmt) => stmt, expr: (expr) => {
        if (expr.kind !== "libCall" || expr.fn !== "dyn.classBasePrototype") return expr;
        if (!this.prototypeHelper) {
          const loc = expr.loc;
          this.prototypeHelper = { name: "%class.basePrototype", params: [{ localId: "value", name: "value", type: DYN }],
            locals: [{ id: "value", name: "value", type: DYN, mutable: false }], returnType: DYN, loc,
            body: [{ kind: "return", value: { ...expr, args: [varRef("value", DYN, loc)] }, loc }] };
          lowerer.liftedFns.push(this.prototypeHelper);
          changed = true;
        }
        return { kind: "call", callee: this.prototypeHelper.name, args: expr.args, type: DYN, loc: expr.loc };
      } });
    }
    if (this.prototypeHelper) for (const name of this.constructors) {
      if (this.prototypes.has(name)) continue;
      this.prototypes.add(name);
      const info = lowerer.classes.get(name);
      if (!info) continue;
      const loc = this.prototypeHelper.loc;
      const type: IrType = { kind: "classval", className: name };
      const value = varRef("value", DYN, loc);
      const prototype = classPrototypeData(lowerer, info, loc, { kind: "dynCheck", value, type, loc });
      if (!prototype) continue;
      const resolved = transformExpr(prototype, { stmt: (stmt) => stmt, expr: (expr) =>
        expr.kind === "libCall" && expr.fn === "dyn.classBasePrototype"
          ? { kind: "call", callee: this.prototypeHelper!.name, args: expr.args, type: DYN, loc: expr.loc } : expr });
      this.prototypeHelper.body.unshift({ kind: "if", cond: { kind: "libCall", fn: "dyn.classIs", args: [value,
        { kind: "strLit", value: typeKey(type), type: STRING, loc }], type: BOOL, loc },
        then: [{ kind: "return", value: resolved, loc }], else_: null, loc });
      changed = true;
    }
    for (const fn of functions) {
      if (!fn.name.startsWith(PREFIX)) continue;
      let completed = this.completed.get(fn.name);
      if (!completed) this.completed.set(fn.name, completed = new Set());
      const loc = fn.loc;
      for (const name of this.constructors) {
        if (completed.has(name)) continue;
        completed.add(name);
        const info = lowerer.classes.get(name);
        if (!info || info.generic || info.def.runtime) continue;
        const args = constructorArguments(lowerer, info.ctorParams, fn.params.slice(1).map((param) => varRef(param.localId, DYN, loc)), loc);
        if (!args) continue;
        const type: IrType = { kind: "classval", className: name };
        const callee = varRef("p.0", DYN, loc);
        const value: IrExpr = { kind: "newValue", callee: { kind: "dynCheck", value: callee, type, loc }, args, type: { kind: "object", className: name }, loc };
        const body: IrStmt[] = [{ kind: "return", value: lowerer.coerceToExpected(value, DYN), loc }];
        fn.body.unshift({ kind: "if", cond: { kind: "libCall", fn: "dyn.classIs", args: [callee,
          { kind: "strLit", value: typeKey(type), type: STRING, loc }], type: BOOL, loc }, then: body, else_: null, loc });
        lowerer.noteEdge(`%${name}.constructor`);
        changed = true;
      }
    }
    return changed;
  }
}
