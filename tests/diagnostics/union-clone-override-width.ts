type Payload = { tag: "number"; value: number } | { tag: "text"; value: string };
type WiderPayload = { tag: "number"; value: number; extra: boolean } | { tag: "text"; value: string; extra: boolean };
type Container = { kind: "left"; payload: Payload; left: number } | { kind: "right"; payload: Payload; right: number };

function copy(source: Container, payload: WiderPayload): boolean {
  // Retagging the override into source.payload would discard extra and
  // copy its record. The inferred spread result keeps the wider payload.
  const result = { ...source, payload };
  return result.payload.extra;
}
console.log(copy({ kind: "left", payload: { tag: "number", value: 1 }, left: 2 }, { tag: "text", value: "kept", extra: true }));
