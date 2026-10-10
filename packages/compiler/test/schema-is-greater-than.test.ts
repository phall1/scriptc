import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// Model.Class collects its heritage before Filter's class expression
// (`class extends Pipeable.Class`) has lowered. Schema.isGreaterThan's
// type names that class. The repository then rejects id -1 as a SchemaError.
const sqlModelSource = `import * as SqlModel from "effect/sql/SqlModel"
import { SqlClient, Statement } from "effect/sql"
import { Model } from "effect/schema"
import { Reactivity } from "effect/reactivity"
import { Effect, Schema } from "effect"
class Item extends Model.Class<Item>("FixtureItem")({id: Schema.Number.check(Schema.isGreaterThan(0)), name: Schema.String}) {}
const program = Effect.gen(function*() {
  const sql = yield* SqlClient.make({acquirer: Effect.die("Unexpected database acquisition"), compiler: Statement.makeCompilerSqlite(), spanAttributes: []})
  const repository = yield* SqlModel.makeRepository(Item, {tableName: "items", idColumn: "id", spanPrefix: "fixture"}).pipe(Effect.provideService(SqlClient.SqlClient, sql))
  return yield* repository.findById(-1).pipe(Effect.catch(error => Effect.succeed([error._tag, Schema.isSchemaError(error)])))
}).pipe(Effect.provide(Reactivity.layer), Effect.withTracerEnabled(false))
console.log(JSON.stringify(Effect.runSync(program)))
`;

test("a sql model rejects a non-positive id before acquiring a connection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-sql-model-"));
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  mkdirSync(directory, { recursive: true });
  symlinkSync(
    join(import.meta.dirname, "../../../../effect-scriptc-compat/node_modules"),
    join(directory, "node_modules"),
    "dir",
  );
  writeFileSync(entry, sqlModelSource);
  try {
    const result = await compile(entry, {
      outDir: directory,
      outPath: binary,
      outputKind: "exe",
      optimization: "dev",
      npmStatic: ["effect"],
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
    expect(run.stdout).toBe('["SchemaError",true]\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
