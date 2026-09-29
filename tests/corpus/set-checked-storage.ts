function opaque(value: unknown): unknown { return value; }
const source = new Set<unknown>([1, "one", 0n]);
const record = opaque({ values: source }) as { values: Set<unknown> };
console.log(record.values === source);
record.values.add(2);
const roundTrip = opaque(source) as Set<unknown>;
console.log(roundTrip === source, source.size, source.has(2), source.has(0n));
source.delete(1);
console.log(roundTrip.size, roundTrip.has(1));
console.log(String(opaque(source)), Object.prototype.toString.call(opaque(source)));
console.log("set");
