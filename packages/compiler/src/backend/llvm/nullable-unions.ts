import {
  isUnitType,
  type IrClassDef,
  type IrModule,
  type IrType,
  type IrUnionDef,
} from "../../ir/ir.js";
import { everyModuleNode } from "../../ir/traverse.js";

/** A union of exactly one reference arm and one unit arm (`C | undefined`,
 * `C | null`) whose VALUES are the reference pointer itself: NULL is the
 * unit arm, anything else is the reference arm's instance. No union box
 * ever exists for such a type: wraps move the payload, narrowing borrows
 * it, retain/release/trace are the arm's NULL-tolerant entry points, and
 * every container, field, capture, parameter, and return slot holds the
 * plain pointer. Every other union keeps the tagged `%ScrUnion` box. */
export interface NullableUnion {
  unionId: string;
  refTag: number;
  unitTag: number;
  arm: NullableRefArm;
}

/** The module-scope immortal sentinel standing for the ABSENT state of a
 * nullable union's record field slot (an omitted optional property). */
export const NULLABLE_ABSENT = "@sc_nullable_absent";

/** The reference arms whose instances are never NULL and whose emitted
 * retain/release/trace entry points all tolerate NULL. */
export type NullableRefArm =
  | { kind: "object"; className: string }
  | { kind: "record"; shapeId: string };

/** The representation decision for every union of one module. It is a
 * pure function of the module, so serialized-IR and in-memory emission
 * agree. */
export class NullableUnions {
  private readonly byId = new Map<string, NullableUnion>();

  constructor(mod: IrModule) {
    const emitted = new Set<string>();
    for (const cls of mod.classes ?? []) if (!cls.runtime) emitted.add(cls.name);
    const records = new Set<string>();
    for (const shape of mod.records ?? []) records.add(shape.id);
    const boxed = boxedUnionIds(mod);
    for (const def of mod.unions ?? []) {
      if (boxed.has(def.id)) continue;
      const nullable = nullableShape(def, emitted, records);
      if (nullable) this.byId.set(def.id, nullable);
    }
  }

  get(unionId: string): NullableUnion | null {
    return this.byId.get(unionId) ?? null;
  }

  of(type: IrType): NullableUnion | null {
    return type.kind === "union" ? this.get(type.unionId) : null;
  }

  has(unionId: string): boolean {
    return this.byId.has(unionId);
  }

  get size(): number {
    return this.byId.size;
  }

  /** The reference arm of every nullable union, by union id. */
  armTypes(): Map<string, IrType> {
    const result = new Map<string, IrType>();
    for (const [id, nullable] of this.byId) result.set(id, nullable.arm);
    return result;
  }

  /** The union table restricted to tagged-box unions: the stack-box
   * optimizations (stack wraps, stack map/array reads, local union storage)
   * only apply to boxes. */
  boxedUnions(unions: ReadonlyMap<string, IrUnionDef>): Map<string, IrUnionDef> {
    const result = new Map<string, IrUnionDef>();
    for (const [id, def] of unions) if (!this.byId.has(id)) result.set(id, def);
    return result;
  }
}

function nullableShape(
  def: IrUnionDef,
  emittedClasses: ReadonlySet<string>,
  records: ReadonlySet<string>,
): NullableUnion | null {
  if (def.arms.length !== 2) return null;
  const unitTag = def.arms.findIndex(isUnitType);
  if (unitTag < 0) return null;
  const refTag = 1 - unitTag;
  const arm = def.arms[refTag]!;
  if (arm.kind === "object" && emittedClasses.has(arm.className))
    return { unionId: def.id, refTag, unitTag, arm: { kind: "object", className: arm.className } };
  if (arm.kind === "record" && records.has(arm.shapeId))
    return { unionId: def.id, refTag, unitTag, arm: { kind: "record", shapeId: arm.shapeId } };
  return null;
}

/** Unions the runtime itself inspects as tagged boxes keep that
 * representation: Map keys and Set elements hash and compare union keys by
 * tag and payload inside the C map. */
function boxedUnionIds(mod: IrModule): Set<string> {
  const boxed = new Set<string>();
  const mark = (t: IrType): void => {
    if (t.kind === "union") boxed.add(t.unionId);
  };
  everyModuleNode(mod, {
    expr: () => true,
    stmt: () => true,
    type: (t) => {
      if (t.kind === "map") mark(t.key);
      else if (t.kind === "set") mark(t.elem);
      return true;
    },
  });
  return boxed;
}

/** Emitted classes keyed by name, for callers that only hold the class
 * list (nullable class fields). */
export function emittedClassNames(classes: readonly IrClassDef[]): Set<string> {
  const names = new Set<string>();
  for (const cls of classes) if (!cls.runtime) names.add(cls.name);
  return names;
}
