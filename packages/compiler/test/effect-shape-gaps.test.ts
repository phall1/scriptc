import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze, compile } from "../src/index.js";

const dateProgram = `
console.log(new Date(0).toJSON("ignored"));
console.log(new Date(NaN).toJSON());
`;

const optionsProbe = `
export function build(options) {
  let n = 0;
  if (options.until) n += options.until(1);
  if (options.while) n += options.while(1);
  return n;
}
`;

const optionsProgram = `
import { build } from "options-fixture/probe.js";

console.log(build({ while: (value: number) => value + 2 }));
console.log(build({ schedule: 1 }));
`;

const errorProbe = `
export function described() {
  const error = new Error("boom");
  error.extra = "x";
  const current = error instanceof Error ? { ...error, name: error.name, message: error.message } : error;
  return Object.keys(error).sort().join(",") + "\\n" + Object.keys(current).sort().join(",") + ":" + current.name + ":" + current.message + ":" + current.extra;
}
`;

const errorProgram = `
import { described } from "error-spread-fixture/probe.js";

console.log(described());
`;

async function matchesNode(name: string, probe: string, program: string): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), `scriptc-${name}-`));
  const pkg = join(directory, "node_modules", name);
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name, version: "0.0.0", type: "module" }),
  );
  writeFileSync(join(pkg, "probe.js"), probe);
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  writeFileSync(entry, program);
  try {
    const coverage = analyze(entry, { npmStatic: [name] });
    const fences = [...coverage.coverage.diagnostics, ...(coverage.coverage.runtimeFences ?? [])];
    expect(fences, JSON.stringify(fences)).toEqual([]);
    const result = await compile(entry, {
      outDir: directory,
      outPath: binary,
      outputKind: "exe",
      optimization: "dev",
      npmStatic: [name],
    });
    expect(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const run = spawnSync(result.binaryPath, [], { encoding: "utf8", timeout: 30_000 });
    const oracle = spawnSync(process.execPath, ["--experimental-strip-types", entry], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(oracle.status, oracle.stderr).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(oracle.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("Date toJSON matches Node for valid and invalid dates", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-date-json-"));
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  writeFileSync(entry, dateProgram);
  try {
    const coverage = analyze(entry);
    const fences = [...coverage.coverage.diagnostics, ...(coverage.coverage.runtimeFences ?? [])];
    expect(fences, JSON.stringify(fences)).toEqual([]);
    const result = await compile(entry, {
      outDir: directory,
      outPath: binary,
      outputKind: "exe",
      optimization: "dev",
    });
    expect(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const run = spawnSync(result.binaryPath, [], { encoding: "utf8", timeout: 30_000 });
    const oracle = spawnSync(process.execPath, ["--experimental-strip-types", entry], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(oracle.status, oracle.stderr).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(oracle.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a missing option method is not called", async () => {
  await matchesNode("options-fixture", optionsProbe, optionsProgram);
});

test("Object.keys and object spread of Error match Node", async () => {
  await matchesNode("error-spread-fixture", errorProbe, errorProgram);
});

const wrapperProbe = `
export function kind(value) {
  for (const valueOf of [Number.prototype.valueOf, Boolean.prototype.valueOf, String.prototype.valueOf]) {
    try {
      Reflect.apply(valueOf, value, []);
      return "yes";
    } catch {
      continue;
    }
  }
  return "no";
}
`;

const wrapperProgram = `
import { kind } from "primitive-wrapper-fixture/probe.js";

console.log(kind({ a: 1 }));
console.log(kind(true));
console.log(kind(1));
console.log(kind("ab"));
`;

test("boxed primitive valueOf probes match Node", async () => {
  await matchesNode("primitive-wrapper-fixture", wrapperProbe, wrapperProgram);
});

const callbackProbe = `
export function joined(transform) {
  return ["a", "b"].map(transform).join(",");
}
export function kept(predicate) {
  return [1, 2, 3, 4].filter(predicate).join(",");
}
export function visited(visit) {
  ["x", "y"].forEach(visit);
}
`;

const callbackProgram = `
import { joined, kept, visited } from "array-callback-fixture/probe.js";

const seen: string[] = [];
visited((part: string) => {
  seen.push(part);
});
console.log(joined((part: string) => part.toUpperCase()));
console.log(kept((value: number) => value % 2 === 0));
console.log(seen.join(","));
`;

test("unknown array callbacks match Node", async () => {
  await matchesNode("array-callback-fixture", callbackProbe, callbackProgram);
});

const memberProbe = `
export function compileGet(nodes) {
  return (s) => {
    const op = nodes[0];
    return op.get(s);
  };
}
export function fromIterator(iterator) {
  const iter = iterator();
  const state = iter.next();
  return state.done ? "done" : state.value;
}
export function compileSet(nodes) {
  return (a) => {
    for (let i = nodes.length - 1; i >= 0; i--) a = nodes[i].set(a);
    return a;
  };
}
`;

const memberProgram = `
import { compileGet, compileSet, fromIterator } from "member-call-fixture/probe.js";

const step: { _tag: string; get: unknown; kind: unknown; set: unknown } = {
  _tag: "Iso",
  get: (s: number) => s + 1,
  kind: "Iso",
  set: (a: number) => a + 2,
};
console.log(compileGet([step])(3));
console.log(compileSet([step])(3));
console.log(fromIterator(() => [7][Symbol.iterator]()));
`;

test("record field calls and generator next match Node", async () => {
  await matchesNode("member-call-fixture", memberProbe, memberProgram);
});

const symbolProbe = `
export function keys(registered) {
  const local = Symbol("local");
  return (Symbol.keyFor(registered) ?? "none") + ":" + (Symbol.keyFor(local) ?? "none");
}
export function octet(part) {
  return Number.parseInt(part, 16);
}
`;

const symbolProgram = `
import { keys, octet } from "symbol-parse-fixture/probe.js";

console.log(keys(Symbol.for("effect")));
console.log(octet("0a"));
console.log(octet("zz"));
`;

test("Symbol.keyFor and Number.parseInt of unknown values match Node", async () => {
  await matchesNode("symbol-parse-fixture", symbolProbe, symbolProgram);
});

const setProbe = `
export function segment(input) {
  let failures;
  function go(i) {
    if (failures?.has(i)) return false;
    failures ??= new Set();
    failures.add(i);
    return true;
  }
  const first = go(input.length);
  const second = go(input.length);
  return first + ":" + second;
}
`;

const setProgram = `
import { segment } from "set-failure-fixture/probe.js";

console.log(segment("ab"));
`;

test("a lazily created Set accepts add and has", async () => {
  await matchesNode("set-failure-fixture", setProbe, setProgram);
});

const bufferProbe = `
export function find(chunk, needle, fromIndex) {
  return Buffer.prototype.indexOf.call(chunk, needle, fromIndex);
}
`;

const bufferProgram = `
import { find } from "buffer-search-fixture/probe.js";

const chunk = new Uint8Array([1, 2, 3, 2, 3]);
const needle = new Uint8Array([2, 3]);
console.log(find(chunk, needle, 0));
console.log(find(chunk, needle, 2));
console.log(find(chunk, new Uint8Array([9]), 0));
`;

test("Buffer.prototype.indexOf.call matches Node", async () => {
  await matchesNode("buffer-search-fixture", bufferProbe, bufferProgram);
});

const formProbe = `
export function build(pairs) {
  const out = new FormData();
  for (const pair of pairs) out.append(pair[0], pair[1]);
  const parts = [];
  for (const pair of out.entries()) parts.push(pair[0] + "=" + pair[1]);
  return parts.join("&");
}
export function isBlob(value) {
  return typeof Blob !== "undefined" && value instanceof Blob;
}
`;

const formProgram = `
import { build, isBlob } from "form-data-fixture/probe.js";

console.log(build([["a", "1"], ["b", "2"]]));
console.log(isBlob("x"));
console.log(isBlob({ a: 1 }));
`;

test("empty FormData append and entries match Node", async () => {
  await matchesNode("form-data-fixture", formProbe, formProgram);
});

const searchProgram = `
console.log("a.b".search("."));
console.log("abc".search("b"));
console.log("abc".search(/b/));
let bad = "no";
try {
  "a".search("[");
} catch (e) {
  bad = e instanceof SyntaxError ? "syntax" : "other";
}
console.log(bad);
`;

test("String.prototype.search compiles a string pattern as a RegExp", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-string-search-"));
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  writeFileSync(entry, searchProgram);
  try {
    const coverage = analyze(entry);
    const fences = [...coverage.coverage.diagnostics, ...(coverage.coverage.runtimeFences ?? [])];
    expect(fences, JSON.stringify(fences)).toEqual([]);
    const result = await compile(entry, {
      outDir: directory,
      outPath: binary,
      outputKind: "exe",
      optimization: "dev",
    });
    expect(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const run = spawnSync(result.binaryPath, [], { encoding: "utf8", timeout: 30_000 });
    const oracle = spawnSync(process.execPath, ["--experimental-strip-types", entry], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(oracle.status, oracle.stderr).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(oracle.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const headerSearchProbe = `
export function dot(value) {
  return value.search(".");
}
export function hit(self, key) {
  const found = [];
  const modify = (key) => {
    if (typeof key === "string") {
      if (key in self) found.push("s:" + key);
    } else {
      for (const name of Object.keys(self)) {
        if (name.search(key) !== -1) found.push("r:" + name);
      }
    }
  };
  if (Array.isArray(key)) {
    for (let i = 0; i < key.length; i++) modify(key[i]);
  } else modify(key);
  return found.join(",");
}
`;

const headerSearchProgram = `
import { dot, hit } from "header-search-fixture/probe.js";

const headers = { authorization: "1", "content-type": "2" };
console.log(dot("a.b"));
console.log(dot("abc"));
console.log(hit(headers, /auth/));
console.log(hit(headers, "content-type"));
console.log(hit(headers, ["content-type", /auth/]));
console.log(hit(headers, /nope/));
`;

test("header name search matches Node for strings and regular expressions", async () => {
  await matchesNode("header-search-fixture", headerSearchProbe, headerSearchProgram);
});

const cookieProbe = `
export function attribute(part) {
  const equalIndex = part.indexOf("=");
  const key = equalIndex === -1 ? part : part.slice(0, equalIndex);
  const value = equalIndex === -1 ? undefined : part.slice(equalIndex + 1).trim();
  if (value === undefined) return key.toLowerCase() + ":missing";
  return key.toLowerCase() + ":" + value.trim().replace(/^\\./, "").toLowerCase();
}
export function maybeTrim(flag, text) {
  const value = flag ? text : undefined;
  return value.trim();
}
`;

const cookieProgram = `
import { attribute, maybeTrim } from "cookie-trim-fixture/probe.js";

console.log(attribute("Domain=.Example.COM"));
console.log(attribute("Secure"));
console.log(attribute("SameSite=Lax"));
console.log(maybeTrim(true, " Ab "));
let threw = "no";
try {
  maybeTrim(false, "x");
} catch (e) {
  threw = e instanceof Error ? e.message : "other";
}
console.log(threw);
`;

test("nullable string trim and toLowerCase match Node", async () => {
  await matchesNode("cookie-trim-fixture", cookieProbe, cookieProgram);
});

const tryProbe = `
function isFunction(input) {
  return typeof input === "function";
}
export function attempt(evaluate) {
  if (isFunction(evaluate)) {
    try {
      return "fn:" + evaluate();
    } catch (e) {
      return "fn-threw";
    }
  }
  try {
    return "obj:" + evaluate.try();
  } catch (e) {
    return "obj:" + evaluate.catch(e);
  }
}
`;

const tryProgram = `
import { attempt } from "try-predicate-fixture/probe.js";

console.log(attempt(() => "direct"));
console.log(attempt({ try: () => "https://example.com", catch: (error: unknown) => String(error) }));
console.log(attempt({ try: () => { throw new Error("bad"); }, catch: (error: unknown) => error instanceof Error ? error.message : "other" }));
`;

test("isFunction folds so object and function attempts both match Node", async () => {
  await matchesNode("try-predicate-fixture", tryProbe, tryProgram);
});

const cookieDateProbe = `
const Proto = { kind: "cookie" };
export function stamp(name, when) {
  const options = { expires: when, path: "/" };
  const cookie = Object.assign(Object.create(Proto), {
    name,
    options: options ? options : undefined,
  });
  return cookie;
}
`;

const cookieDateProgram = `
import { stamp } from "cookie-date-fixture/probe.js";

const cookie = stamp("id", new Date(0));
console.log(cookie.kind);
console.log(cookie.name);
console.log(cookie.options.path);
console.log(cookie.options.expires.toISOString());
console.log(cookie.options.expires.getTime());
`;

test("Object.assign copies a record that holds a Date", async () => {
  await matchesNode("cookie-date-fixture", cookieDateProbe, cookieDateProgram);
});

const literalProbe = `
export function Literal(literal) {
  const out = {
    literal,
    transform(to) {
      return out.literal + ":" + String(to) + ":" + Literal(to).literal;
    },
  };
  return out;
}
`;

const literalProgram = `
import { Literal } from "literal-capture-fixture/probe.js";

console.log(Literal("a").transform("b"));
`;

test("a nested method can capture the const it initializes, including a recursive call", async () => {
  await matchesNode("literal-capture-fixture", literalProbe, literalProgram);
});

const fileProbe = `
export async function described(bytes) {
  const file = new globalThis.File([bytes], "note.txt", { type: "text/plain", lastModified: 5 });
  const copy = new Uint8Array(await file.arrayBuffer());
  return [file.name, file.type, String(file.lastModified), String(file.size), String(copy.length), String(copy[0])].join(" ");
}
`;

const fileProgram = `
import { described } from "file-fixture/probe.js";

console.log(await described(new Uint8Array([1, 2, 3])));
`;

test("new File records the name, type, time, and byte length", async () => {
  await matchesNode("file-fixture", fileProbe, fileProgram);
});

const replaceProbe = `
export function words(input) {
  const patterns = [/([a-z0-9])([A-Z])/g, /([A-Z])([A-Z][a-z])/g];
  let result = input;
  for (const regexp of patterns) result = result.replace(regexp, "$1 $2");
  return result;
}
export function expand(text, parsed) {
  return String(text).replace(parsed.token, () => parsed.value);
}
`;

const replaceProgram = `
import { expand, words } from "replace-fixture/probe.js";

console.log(words("camelCase"));
console.log(words("HTTPResponse"));
console.log(expand("hello NAME", { token: "NAME", value: "world" }));
console.log(expand("a.b", { token: ".", value: "X" }));
console.log(expand("a.b", { token: /a\\.b/, value: "z" }));
console.log(expand("n", { token: "n", value: 7 }));
`;

test("string replace accepts a RegExp search and a callback replacement", async () => {
  await matchesNode("replace-fixture", replaceProbe, replaceProgram);
});

const arrayExportProbe = `
export const Array = globalThis.Array;
`;

const arrayExportProgram = `
import * as Arrays from "array-export-fixture/probe.js";

console.log(Arrays.Array === globalThis.Array);
console.log(new Arrays.Array(1, 2).join(","));
`;

test("an exported Array constructor matches globalThis.Array", async () => {
  await matchesNode("array-export-fixture", arrayExportProbe, arrayExportProgram);
});

const cwdProbe = `
export function here() {
  let cwd = undefined;
  const process = globalThis.process;
  if (
    cwd === undefined &&
    "process" in globalThis &&
    typeof process === "object" &&
    process !== null &&
    typeof process.cwd === "function"
  ) {
    cwd = process.cwd();
  }
  return cwd;
}
`;

const cwdProgram = `
import { here } from "cwd-fixture/probe.js";

console.log(here() === process.cwd());
`;

test("a guarded process.cwd call matches Node", async () => {
  await matchesNode("cwd-fixture", cwdProbe, cwdProgram);
});

const pendingProbe = `
export function makeParser() {
  let pending;
  function reset() {
    pending = [];
  }
  function feed(chunk) {
    pending.push(chunk.slice(0, 1));
    const line = pending.length > 0 ? pending.join("") : "";
    pending = [];
    return line;
  }
  reset();
  return { feed };
}
`;

const pendingProgram = `
import { makeParser } from "pending-fixture/probe.js";

console.log(makeParser().feed("ab"));
`;

test("a let array assigned in a nested function accepts push and join", async () => {
  await matchesNode("pending-fixture", pendingProbe, pendingProgram);
});
