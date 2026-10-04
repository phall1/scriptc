function transform(input: string, suffix: string): string {
  return input.trim().toUpperCase() + suffix;
}
function matches(input: string, prefix: string, suffix: string): boolean {
  return input.startsWith(prefix) && input.endsWith(suffix);
}
const source = [" one ", " two ", " three "];
let combined = "";
for (const value of source) {
  const transformed = transform(value, ":");
  combined += transformed;
}
console.log(combined);
let changing = "a";
for (let index = 0; index < 4; index++) {
  changing = transform(changing, String(index));
  console.log(changing, matches(changing, "A", String(index)));
}
function conditional(input: string, left: string, right: string, choose: boolean): string {
  return input + (choose ? left : right);
}
console.log(conditional("start", "left", "right", true));
console.log(conditional("start", "left", "right", false));
function shortCircuit(input: string, suffix: string): string {
  return input || suffix;
}
console.log(shortCircuit("", "fallback"), shortCircuit("kept", "ignored"));
function nested(input: string, count: number): string {
  if (count === 0) return input.slice(0);
  return transform(nested(input, count - 1), ".");
}
console.log(nested(" value ", 3));
function build(input: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < input.length; index++) {
    const part = input.slice(index);
    if (part.startsWith("b")) continue;
    values.push(part.trim());
  }
  return values;
}
console.log(build("abc ").join("|"));
function windows(input: string): string {
  let output = "";
  for (let index = 0; index < input.length; index++) {
    try {
      const part = input.substring(index, index + 2);
      if (part === "cd") break;
      output += part;
    } finally {
      output += ":";
    }
  }
  return output;
}
console.log(windows("abcdef"));
function defaults(input: string, prefix = "", suffix = ""): string {
  return prefix + input + suffix;
}
console.log(defaults("plain"), defaults("inside", "[", "]"));
function many(input: string, ...suffixes: string[]): string {
  let result = input;
  for (const suffix of suffixes) result = transform(result, suffix);
  return result;
}
console.log(many(" start ", ":a", ":b", ":c"));
