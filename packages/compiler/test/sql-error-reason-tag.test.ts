import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// classifySqliteError returns one of several schema error classes.
// Their shared tag is assigned by the generated constructor.
const sqlErrorSource = `import * as M from "effect/sql/SqlError";
const reason = M.classifySqliteError({ code: "SQLITE_CONSTRAINT_UNIQUE", message: "duplicate" });
const error = new M.SqlError({ reason });
console.log(JSON.stringify([reason._tag, M.isSqlError(error), M.isSqlErrorReason(reason)]));
`;

async function compileAndMatch(source: string, expected: string): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-sql-error-"));
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  mkdirSync(directory, { recursive: true });
  symlinkSync(
    join(import.meta.dirname, "../../../../effect-scriptc-compat/node_modules"),
    join(directory, "node_modules"),
    "dir",
  );
  writeFileSync(entry, source);
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
    expect(run.stdout).toBe(expected);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("a sqlite unique violation reports its tag", async () => {
  await compileAndMatch(sqlErrorSource, '["UniqueViolation",true,true]\n');
}, 180_000);
