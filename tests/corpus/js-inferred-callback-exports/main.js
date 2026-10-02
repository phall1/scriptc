import * as Facade from "./facade.js";
import decorated from "./internal.js";
console.log(decorated(4), decorated.fromState(4));
function transform(callback) { return { callback }; }
const getter = transform(Facade.toDate);
const date = getter.callback(0);
console.log(date instanceof Date, date.toISOString());

/** @param {string} value @return {number} */
function parse(value) {
  if (value === "invalid") return;
  switch (value) {
    case "two": return 2;
    default: return undefined;
  }
}
/** @param {string} value @return {number|string} */
const format = function(value) { return value === "text" ? "value" : parse(value); };
console.log(format("invalid"), format("unknown"), format("two"), format("text"));
const asyncFormat = async value => parse(value);
async function main() {
  console.log(await asyncFormat("invalid"), await asyncFormat("two"));
}
main();
