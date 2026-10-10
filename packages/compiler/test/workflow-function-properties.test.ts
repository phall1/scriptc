import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// Workflow.make returns `function Workflow() {}` after assigning _tag,
// schemas, and idempotencyKey onto that same function.
const workflowSource = `import { Schema } from "effect";
import { Workflow, DurableDeferred } from "effect/workflow";
const workflow = Workflow.make("Fixture", { payload: { id: Schema.String }, success: Schema.Number, idempotencyKey: payload => payload.id });
const deferred = DurableDeferred.make("approval", { success: Schema.Boolean });
console.log(JSON.stringify([workflow._tag, workflow.idempotencyKey({ id: "a" }), Schema.decodeUnknownSync(workflow.payloadSchema)({ id: "a" }), deferred.name]));
`;

async function compileAndMatch(source: string, expected: string): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-workflow-fn-"));
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

test("workflow fields assigned onto the function stay readable", async () => {
  await compileAndMatch(workflowSource, '["Fixture","a",{"id":"a"},"approval"]\n');
}, 180_000);
