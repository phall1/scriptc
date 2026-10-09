/* Representation-aware union projections shared by the emitter and the
 * helper generators (walkers, dyn). A tagged union is a `%ScrUnion` box; a
 * nullable union (nullable-unions.ts) is the arm pointer itself: NULL for
 * its NULL-encoded unit arm and, in `C | null | undefined`, the immortal
 * NULLABLE_NULL sentinel for `null`. Every structural read of a union value
 * goes through here. */
import type { BlockBuilder } from "./blocks.js";
import { NULLABLE_NULL, type NullableUnion } from "./nullable-unions.js";

/** The i32 tag of a union value. */
export function emitUnionTag(B: BlockBuilder, nullable: NullableUnion | null, u: string): string {
  const t = B.tmp();
  if (nullable) {
    const isNull = B.tmp();
    B.line(`${isNull} = icmp eq ptr ${u}, null`);
    if (nullable.nullTag < 0) {
      B.line(`${t} = select i1 ${isNull}, i32 ${nullable.unitTag}, i32 ${nullable.refTag}`);
      return t;
    }
    const isNullArm = B.tmp(),
      present = B.tmp();
    B.line(`${isNullArm} = icmp eq ptr ${u}, ${NULLABLE_NULL}`);
    B.line(`${present} = select i1 ${isNullArm}, i32 ${nullable.nullTag}, i32 ${nullable.refTag}`);
    B.line(`${t} = select i1 ${isNull}, i32 ${nullable.unitTag}, i32 ${present}`);
    return t;
  }
  const p = B.tmp();
  B.line(`${p} = getelementptr inbounds %ScrUnion, ptr ${u}, i64 0, i32 1`);
  B.line(`${t} = load i32, ptr ${p}`);
  return t;
}

/** i1: a nullable union value holds its reference arm (neither NULL nor
 * the `null` sentinel). */
export function emitNullablePresent(B: BlockBuilder, nullable: NullableUnion, u: string): string {
  const present = B.tmp();
  B.line(`${present} = icmp ne ptr ${u}, null`);
  if (nullable.nullTag < 0) return present;
  const notNullArm = B.tmp(),
    both = B.tmp();
  B.line(`${notNullArm} = icmp ne ptr ${u}, ${NULLABLE_NULL}`);
  B.line(`${both} = and i1 ${present}, ${notNullArm}`);
  return both;
}

/** i1: a nullable union value holds the arm `tag` (`negated`: does not). */
export function emitNullableIsTag(
  B: BlockBuilder,
  nullable: NullableUnion,
  u: string,
  tag: number,
  negated: boolean,
): string {
  if (tag === nullable.refTag) {
    const present = emitNullablePresent(B, nullable, u);
    if (!negated) return present;
    const t = B.tmp();
    B.line(`${t} = xor i1 ${present}, true`);
    return t;
  }
  const t = B.tmp();
  const target = tag === nullable.nullTag ? NULLABLE_NULL : "null";
  B.line(`${t} = icmp ${negated ? "ne" : "eq"} ptr ${u}, ${target}`);
  return t;
}

/** The BORROWED payload pointer of a reference arm. */
export function emitUnionPeek(B: BlockBuilder, nullable: NullableUnion | null, u: string): string {
  if (nullable) return u;
  const p = B.tmp();
  const t = B.tmp();
  B.line(`${p} = getelementptr inbounds %ScrUnion, ptr ${u}, i64 0, i32 5`);
  B.line(`${t} = load ptr, ptr ${p}`);
  return t;
}

/** Text-template forms for helpers written as raw LLVM lines: `%out`
 * receives the tag / payload of `u`. */
export function unionTagLines(nullable: NullableUnion | null, u: string, out: string): string[] {
  if (nullable && nullable.nullTag < 0)
    return [
      `  ${out}.isnull = icmp eq ptr ${u}, null`,
      `  ${out} = select i1 ${out}.isnull, i32 ${nullable.unitTag}, i32 ${nullable.refTag}`,
    ];
  if (nullable)
    return [
      `  ${out}.isnull = icmp eq ptr ${u}, null`,
      `  ${out}.isnullarm = icmp eq ptr ${u}, ${NULLABLE_NULL}`,
      `  ${out}.present = select i1 ${out}.isnullarm, i32 ${nullable.nullTag}, i32 ${nullable.refTag}`,
      `  ${out} = select i1 ${out}.isnull, i32 ${nullable.unitTag}, i32 ${out}.present`,
    ];
  return [
    `  ${out}.p = getelementptr inbounds %ScrUnion, ptr ${u}, i64 0, i32 1`,
    `  ${out} = load i32, ptr ${out}.p`,
  ];
}

export function unionPeekLines(nullable: NullableUnion | null, u: string, out: string): string[] {
  // A plain copy of the pointer (NULL included) under the template's name.
  if (nullable) return [`  ${out} = getelementptr i8, ptr ${u}, i64 0`];
  return [
    `  ${out}.p = getelementptr inbounds %ScrUnion, ptr ${u}, i64 0, i32 5`,
    `  ${out} = load ptr, ptr ${out}.p`,
  ];
}
