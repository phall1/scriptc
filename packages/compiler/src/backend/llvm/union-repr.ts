/* Representation-aware union projections shared by the emitter and the
 * helper generators (walkers, dyn). A tagged union is a `%ScrUnion` box; a
 * nullable union (nullable-unions.ts) is the arm pointer itself, NULL for
 * the unit arm. Every structural read of a union value goes through here. */
import type { BlockBuilder } from "./blocks.js";
import type { NullableUnion } from "./nullable-unions.js";

/** The i32 tag of a union value. */
export function emitUnionTag(B: BlockBuilder, nullable: NullableUnion | null, u: string): string {
  const t = B.tmp();
  if (nullable) {
    const isNull = B.tmp();
    B.line(`${isNull} = icmp eq ptr ${u}, null`);
    B.line(`${t} = select i1 ${isNull}, i32 ${nullable.unitTag}, i32 ${nullable.refTag}`);
    return t;
  }
  const p = B.tmp();
  B.line(`${p} = getelementptr inbounds %ScrUnion, ptr ${u}, i64 0, i32 1`);
  B.line(`${t} = load i32, ptr ${p}`);
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
  if (nullable)
    return [
      `  ${out}.isnull = icmp eq ptr ${u}, null`,
      `  ${out} = select i1 ${out}.isnull, i32 ${nullable.unitTag}, i32 ${nullable.refTag}`,
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
