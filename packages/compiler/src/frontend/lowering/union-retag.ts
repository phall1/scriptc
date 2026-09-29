import { InternalCompilerError } from "../../errors.js";
import { BOOL, F64, STRING, isUnitType, typeEquals } from "../../ir/ir.js";
import type { IrExpr, IrFunction, IrRecordShape, IrStmt, IrType, IrUnionDef, SrcLoc } from "../../ir/ir.js";
import type { WidthLift } from "./width-lift.js";

type Literal = string | number | boolean;

export interface UnionRetagRoute {
  tag: number;
  lift: WidthLift;
  values: Literal[];
}

export type UnionRetagArm =
  | { kind: "trap" }
  | { kind: "direct"; route: UnionRetagRoute }
  | { kind: "discriminant"; field: string; fieldType: IrType; routes: UnionRetagRoute[] };

/** Read only data fields whose literal comparisons have a native ABI.
 * Accessors and optional/dynamic slots must not acquire an implicit read
 * or an unchecked interpretation while selecting a destination layout. */
function discriminantField(shape: IrRecordShape | undefined, field: string): IrType | null {
  if (field.startsWith("%") || !shape || shape.tuple) return null;
  if (shape.fields.some((entry) => entry.name === `%get:${field}` || entry.name === `%set:${field}`)) return null;
  const type = shape.fields.find((entry) => entry.name === field)?.type;
  return type && (type.kind === "string" || type.kind === "f64" || type.kind === "bool") ? type : null;
}

function matchesLiteral(type: IrType, value: Literal): boolean {
  if (type.kind === "string") return typeof value === "string";
  if (type.kind === "bool") return typeof value === "boolean";
  return type.kind === "f64" && typeof value === "number" && Number.isFinite(value);
}

/** Check the metadata independently of the width relation. A missing or
 * ambiguous literal cannot justify choosing the first compatible arm.
 * JSON keys distinguish 1, "1", true and "true", including unusual strings. */
function discriminantOwners(
  union: IrUnionDef,
  shapeOf: (id: string) => IrRecordShape | undefined,
): Map<string, number> | null {
  const discriminant = union.discriminant;
  if (!discriminant) return null;
  const owners = new Map<string, number>();
  const tags = new Set<number>();
  for (const entry of discriminant.cases) {
    const arm = union.arms[entry.tag];
    if (!Number.isInteger(entry.tag) || !arm || arm.kind !== "record" || tags.has(entry.tag)) return null;
    tags.add(entry.tag);
    const type = discriminantField(shapeOf(arm.shapeId), discriminant.field);
    if (!type || entry.values.length === 0) return null;
    for (const value of entry.values) {
      if (!matchesLiteral(type, value)) return null;
      const key = JSON.stringify(value);
      const previous = owners.get(key);
      if (previous !== undefined && previous !== entry.tag) return null;
      owners.set(key, entry.tag);
    }
  }
  for (let tag = 0; tag < union.arms.length; tag++) {
    if (union.arms[tag]!.kind === "record" && !tags.has(tag)) return null;
  }
  return owners;
}

/** Pure conversion planning. A source storage tag need not denote just
 * one semantic variant: refinements can coalesce recursive record layouts.
 * When both unions name the same discriminant, its values select target
 * tags, and every selected payload conversion must independently validate.
 * Planning never interns a helper or caches a recursive assumption. */
export function planUnionRetag(
  from: IrUnionDef,
  to: IrUnionDef,
  shapeOf: (id: string) => IrRecordShape | undefined,
  widthLift: (src: IrType, dst: IrType) => WidthLift | null,
  trappable?: ReadonlySet<number>,
): UnionRetagArm[] | null {
  const result: UnionRetagArm[] = [];
  const target: IrType = { kind: "union", unionId: to.id };
  const discriminant = from.discriminant;
  const useDiscriminant = discriminant !== undefined && discriminant.field === to.discriminant?.field;
  const owners = useDiscriminant ? discriminantOwners(to, shapeOf) : null;
  if (useDiscriminant && (owners === null || discriminantOwners(from, shapeOf) === null)) return null;
  for (let tag = 0; tag < from.arms.length; tag++) {
    const source = from.arms[tag]!;
    const identity = to.arms.findIndex((arm) => typeEquals(arm, source));
    if (isUnitType(source)) {
      result.push(identity < 0 ? { kind: "trap" } : {
        kind: "direct", route: { tag: identity, lift: { how: "copy" }, values: [] },
      });
      continue;
    }
    // A checker-proven absent arm retains any exact representation, as
    // before. Otherwise the narrowing path needs no structural conversion.
    if (identity < 0 && trappable?.has(tag)) {
      result.push({ kind: "trap" });
      continue;
    }
    if (useDiscriminant && discriminant && owners && source.kind === "record") {
      const entry = discriminant.cases.find((candidate) => candidate.tag === tag);
      const fieldType = discriminantField(shapeOf(source.shapeId), discriminant.field);
      if (!entry || !fieldType) return null;
      const routes: UnionRetagRoute[] = [];
      for (const value of entry.values) {
        // Narrowing can remove semantic cases without changing a storage
        // arm. Retain that exact representation for omitted literals, while
        // explicit owners still select their own payload layouts.
        const destination = owners.get(JSON.stringify(value)) ?? (identity >= 0 ? identity : undefined);
        if (destination === undefined) return null;
        const existing = routes.find((route) => route.tag === destination);
        if (existing) {
          if (!existing.values.includes(value)) existing.values.push(value);
          continue;
        }
        const lift = widthLift(source, to.arms[destination]!);
        if (lift === null) return null;
        routes.push({ tag: destination, lift, values: [value] });
      }
      if (routes.length === 1) result.push({ kind: "direct", route: routes[0]! });
      else result.push({ kind: "discriminant", field: discriminant.field, fieldType, routes });
      continue;
    }
    if (identity >= 0) {
      result.push({ kind: "direct", route: { tag: identity, lift: { how: "copy" }, values: [] } });
      continue;
    }
    // Unannotated unions retain the unique-width-arm rule. A discriminant
    // present on just one side cannot establish correspondence.
    const lift = widthLift(source, target);
    if (!lift || lift.how !== "liftWrap") return null;
    const inner = widthLift(source, lift.arm);
    if (!inner) return null;
    result.push({ kind: "direct", route: { tag: lift.tag, lift: inner, values: [] } });
  }
  return result;
}

function typeError(message: string, loc: SrcLoc): IrStmt {
  return {
    kind: "throw",
    value: {
      kind: "libCall", fn: "error.new",
      args: [{ kind: "strLit", value: message, type: STRING, loc }],
      type: { kind: "object", className: "%TypeError" }, loc,
    },
    loc,
  };
}

function literalTest(field: IrExpr, literal: Literal, loc: SrcLoc): IrExpr {
  if (typeof literal === "string") {
    return {
      kind: "strEq", negated: false, left: field,
      right: { kind: "strLit", value: literal, type: STRING, loc }, type: BOOL, loc,
    };
  }
  const right: IrExpr = typeof literal === "number"
    ? { kind: "numLit", value: literal, type: F64, loc }
    : { kind: "boolLit", value: literal, type: BOOL, loc };
  return { kind: "bin", op: "===", left: field, right, type: BOOL, loc };
}

/** Emit the already validated routes using ordinary typed IR. Each field
 * read uses the source shape; each result uses its own destination shape.
 * Identity routes retain the original payload and width routes copy it.
 * The caller interns the helper before invoking this build phase. */
export function buildUnionRetag(
  name: string,
  from: IrUnionDef,
  to: IrUnionDef,
  plan: UnionRetagArm[],
  loc: SrcLoc,
  applyLift: (lift: WidthLift, value: IrExpr, dst: IrType) => IrExpr,
  formatType: (type: IrType) => string,
): IrFunction {
  if (plan.length !== from.arms.length) throw new InternalCompilerError("lowerer bug: incomplete union retag plan");
  const fromType: IrType = { kind: "union", unionId: from.id };
  const toType: IrType = { kind: "union", unionId: to.id };
  const input: IrExpr = { kind: "varRef", localId: "u.0", type: fromType, loc };
  const fn: IrFunction = {
    name, params: [{ localId: "u.0", name: "u", type: fromType }], returnType: toType,
    locals: [{ id: "u.0", name: "u", type: fromType, mutable: false }], body: [], loc,
  };
  for (let tag = 0; tag < from.arms.length; tag++) {
    const arm = from.arms[tag]!;
    const armPlan = plan[tag]!;
    const statements: IrStmt[] = [];
    if (armPlan.kind === "trap") {
      const what = isUnitType(arm) ? (arm.kind === "undefinedT" ? "undefined" : "null") : `a '${formatType(arm)}' value`;
      statements.push(typeError(`${what} is not representable in the target union (a value narrowed or asserted past it still held it)`, loc));
    } else {
      const payload: IrExpr = isUnitType(arm)
        ? { kind: "unitLit", unit: arm.kind === "undefinedT" ? "undefined" : "null", type: arm, loc }
        : { kind: "unionNarrow", unionId: from.id, tag, value: input, type: arm, loc };
      if (armPlan.kind === "direct") {
        const route = armPlan.route;
        statements.push({
          kind: "return", value: {
            kind: "unionWrap", unionId: to.id, tag: route.tag,
            value: applyLift(route.lift, payload, to.arms[route.tag]!), type: toType, loc,
          }, loc,
        });
      } else {
        if (arm.kind !== "record") throw new InternalCompilerError("lowerer bug: discriminant on non-record arm");
        // Capture once after testing the source tag. Reusing a field read
        // would repeatedly retain the payload and would obscure ownership.
        const localId = `kind.${tag}`;
        fn.locals.push({ id: localId, name: "kind", type: armPlan.fieldType, mutable: false });
        statements.push({
          kind: "varDecl", localId,
          init: { kind: "recordGet", obj: payload, shapeId: arm.shapeId, field: armPlan.field, type: armPlan.fieldType, loc }, loc,
        });
        const field: IrExpr = { kind: "varRef", localId, type: armPlan.fieldType, loc };
        for (const route of armPlan.routes) {
          let cond: IrExpr | null = null;
          for (const literal of route.values) {
            const test = literalTest(field, literal, loc);
            cond = cond === null ? test : { kind: "logical", op: "||", left: cond, right: test, type: BOOL, loc };
          }
          if (cond === null) throw new InternalCompilerError("lowerer bug: empty discriminant route");
          statements.push({
            kind: "if", cond,
            then: [{ kind: "return", value: {
              kind: "unionWrap", unionId: to.id, tag: route.tag,
              value: applyLift(route.lift, payload, to.arms[route.tag]!), type: toType, loc,
            }, loc }], else_: null, loc,
          });
        }
        statements.push(typeError(`invalid '${armPlan.field}' discriminant in union conversion`, loc));
      }
    }
    fn.body.push({
      kind: "if", cond: { kind: "unionIsTag", unionId: from.id, tag, negated: false, value: input, type: BOOL, loc },
      then: statements, else_: null, loc,
    });
  }
  fn.body.push({
    kind: "throw", value: { kind: "strLit", value: "scriptc: internal error: invalid union tag", type: STRING, loc }, loc,
  });
  return fn;
}
