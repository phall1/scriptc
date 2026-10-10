import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// `["a", {}]` is inferred as `{}[]` because a string is assignable to
// TypeScript's empty-object type. The empty record cannot store that string.
const mixedSource = `const result = {};
console.log(JSON.stringify(["a", result]));
`;

// Effect hides its declarations under npm-static, so parseHeader's return
// is the empty object it builds and the array's common type is that `{}`.
const cookiesSource = `import * as M from "effect/http/Cookies";
const cookie = M.makeCookieUnsafe("fixture", "hello", { httpOnly: true, sameSite: "lax", path: "/" });
const cookies = M.fromIterable([cookie]);
console.log(JSON.stringify([M.serializeCookie(cookie), M.toCookieHeader(cookies), M.parseHeader("a=1; b=two")]));
`;

async function compileAndMatch(source: string, effect: boolean, expected: string): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-empty-record-array-"));
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  mkdirSync(directory, { recursive: true });
  if (effect) {
    symlinkSync(
      join(import.meta.dirname, "../../../../effect-scriptc-compat/node_modules"),
      join(directory, "node_modules"),
      "dir",
    );
  }
  writeFileSync(entry, source);
  try {
    const result = await compile(entry, {
      outDir: directory,
      outPath: binary,
      outputKind: "exe",
      optimization: "dev",
      ...(effect ? { npmStatic: ["effect"] } : {}),
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
    expect(run.stdout).toBe(expected);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("a string next to an empty object stringifies as an array", async () => {
  await compileAndMatch(mixedSource, false, '["a",{}]\n');
}, 180_000);

test("cookie serialization stringifies strings beside the parsed header", async () => {
  await compileAndMatch(
    cookiesSource,
    true,
    '["fixture=hello; Path=/; HttpOnly; SameSite=Lax","fixture=hello",{"a":"1","b":"two"}]\n',
  );
}, 180_000);
