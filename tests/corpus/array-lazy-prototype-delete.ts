const proto = Object.getPrototypeOf(JSON.parse("[]"));
Object.defineProperty(proto, "map", { value: undefined, configurable: true });
delete proto.map;
console.log("map" in ([] as number[]));
function has(value: unknown): boolean {
  return typeof value === "object" && value !== null && "map" in value;
}
console.log(has(JSON.parse("[]")));
console.log("filter" in ([] as number[]));
