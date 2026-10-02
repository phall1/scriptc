/* IR ↔ JSON. Numeric literals preserve JavaScript's complete number domain:
 * JSON's null/zero spellings must not erase NaN, infinities or negative zero. */
import type { IrModule } from "./ir.js";

// Version 13 adds the NaN sentinel. Older readers interpret unknown tags
// as negative infinity, so accepting a newer document would miscompile it.
export const IR_VERSION = 13 as const;

/** Compiler artifacts use compact JSON to keep large graphs below the host's
 * string size limit. API consumers can retain the readable default. */
export function serializeModule(mod: IrModule, compact = false): string {
  const replacer = (_key: string, value: unknown): unknown => {
    if (typeof value !== "number") return value;
    if (!Number.isFinite(value)) {
      return { $nonfinite: Number.isNaN(value) ? "nan" : value > 0 ? "inf" : "-inf" };
    }
    // JSON.stringify(-0) prints "0", silently losing the sign a numLit's
    // f64 semantics depend on (String(-0) is "0" but 1/-0 is -Infinity) —
    // the same sentinel mechanism carries it.
    if (Object.is(value, -0)) {
      return { $nonfinite: "-0" };
    }
    return value;
  };
  if (!compact) return JSON.stringify(mod, replacer, 2);
  // A replacer reads through live native views. Serializing the complete
  // function array through one view refreshes every function capsule for
  // each element, making large compiler artifacts quadratic. The sentinel
  // replacer is key-independent, so encode each function as its own root.
  const header = JSON.stringify({ ...mod, functions: [] }, replacer);
  const slot = '"functions":[]';
  const offset = header.indexOf(slot);
  const functions = mod.functions.map((fn) => JSON.stringify(fn, replacer) ?? "null").join(",");
  return header.slice(0, offset) + '"functions":[' + functions + "]" + header.slice(offset + slot.length);
}

export function deserializeModule(json: string): IrModule {
  const mod = JSON.parse(json, (_key, value: unknown) => {
    if (typeof value === "object" && value !== null && "$nonfinite" in value) {
      const tag = (value as { $nonfinite: string }).$nonfinite;
      if (tag === "inf") return Infinity;
      if (tag === "-inf") return -Infinity;
      if (tag === "-0") return -0;
      if (tag === "nan") return NaN;
      throw new Error(`Invalid IR number sentinel: ${String(tag)}`);
    }
    return value;
  }) as IrModule;
  if (mod.irVersion !== IR_VERSION) {
    throw new Error(
      `IR version mismatch: file has ${String(mod.irVersion)}, compiler expects ${IR_VERSION}`,
    );
  }
  return mod;
}
