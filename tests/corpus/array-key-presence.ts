const values: (number | undefined)[] = [1, , undefined];
values.length = 5;
values[-1] = 7;
values[1.5] = undefined;
values[4294967295] = 9;
const keys = ["0", "1", "2", "3", "length", "map", "constructor", "hasOwnProperty", "~effect/Hash", "-1", "1.5", "4294967295", "01", "-0", "", "0\0"];
for (const key of keys) console.log(JSON.stringify(key), key in values);
console.log("literal", "0" in values, "1" in values, "length" in values, "~effect/Hash" in values);
console.log("numeric", 0 in values, 1 in values, -1 in values, 1.5 in values, 4294967295 in values);

const events: string[] = [];
function key(): string { events.push("key"); values.length = 0; return "0"; }
function receiver(): (number | undefined)[] { events.push("receiver"); return values; }
console.log("order", key() in receiver(), events.join(","));
events.length = 0;
console.log("literal receiver", "absent" in receiver(), events.join(","));

function checkedHas(value: unknown, name: string): boolean {
  return typeof value === "object" && value !== null && name in value;
}
console.log("checked", checkedHas(JSON.parse("[1,null]"), "map"), checkedHas(JSON.parse("[1,null]"), "~effect/Hash"));

Object.defineProperty(Array.prototype, "inheritedArrayKey", { value: undefined, configurable: true });
console.log("inherited", "inheritedArrayKey" in values);
delete (Array.prototype as any).inheritedArrayKey;
console.log("deleted inherited", "inheritedArrayKey" in values);
