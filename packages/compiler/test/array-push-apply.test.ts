import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// Statement.compile copies a parameter list with `binds.push.apply`.
// The method is a property read, then Function.prototype.apply.
const pushApplySource = `const binds = [];
console.log(String(binds.push.apply(binds, [3, 4])));
console.log(JSON.stringify(binds));
const plain = {};
console.log(String(plain.push));
const custom = [];
custom.push = function () { return 5; };
console.log(String(custom.push.apply(custom, [1])));
console.log(JSON.stringify(custom));
`;

const sqlClientSource = `import * as SqlClient from "effect/sql/SqlClient"
import { Statement } from "effect/sql"
import { Reactivity } from "effect/reactivity"
import { Effect } from "effect"
const program = Effect.gen(function*() {
  const sql = yield* SqlClient.make({acquirer: Effect.die("Unexpected connection acquisition"), compiler: Statement.makeCompilerSqlite(), spanAttributes: []})
  const statement = sql\`SELECT \${sql("name")} FROM \${sql("items")} WHERE id = \${7}\`
  return [statement.compile(), sql.safe === sql, sql.withoutTransforms().unsafe("SELECT ?", [3]).compile()]
}).pipe(Effect.provide(Reactivity.layer))
console.log(JSON.stringify(Effect.runSync(program)))
`;

async function compileAndMatch(
  source: string,
  expected: string,
  entryName: string,
  linkEffect: boolean,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-push-apply-"));
  const entry = join(directory, entryName);
  const binary = join(directory, "main");
  mkdirSync(directory, { recursive: true });
  if (linkEffect) {
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
      ...(linkEffect ? { npmStatic: ["effect"] } : {}),
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

test("an array push extracted for apply appends the argument list", async () => {
  await compileAndMatch(
    pushApplySource,
    "2\n[3,4]\nundefined\n5\n[]\n",
    "main.js",
    false,
  );
}, 120_000);

test("a sql client compiles a statement that applies push to its binds", async () => {
  await compileAndMatch(
    sqlClientSource,
    '[["SELECT \\"name\\" FROM \\"items\\" WHERE id = ?",[7]],true,["SELECT ?",[3]]]\n',
    "main.ts",
    true,
  );
}, 180_000);
