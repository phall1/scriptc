import { execFile } from "node:child_process";
import { globSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import type { CompileResult } from "@scriptc/compiler";
import { balancedShardSelect } from "./shard.js";
import fixtureCosts from "./effect4-costs.json";

const exec = promisify(execFile);
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const fixtures = globSync(join(import.meta.dirname, "../fixtures/effect4/*.ts")).filter((file) => !file.endsWith(".d.ts")).sort();
// Recorded plain/sanitizer fixture seconds guide scheduling only. New fixtures
// receive an estimate and remain in every complete matrix partition.
const costs: Record<string, number> = fixtureCosts;
const cases = balancedShardSelect(fixtures, (file) => basename(file), (file) => costs[basename(file)] ?? 40);
const concurrent = process.env["SCRIPTC_EFFECT_TEST_CONCURRENCY"] === "2";

async function run(command: string, args: string[]) {
  try {
    const { stdout, stderr } = await exec(command, args, { encoding: "utf8", timeout: 60_000 });
    return { stdout, stderr, status: 0 };
  } catch (error) {
    const result = error as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof result.code !== "number") throw error;
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.code };
  }
}

test.for(cases)("published Effect 4 %s matches Node statically", { concurrent, timeout: 600_000 }, async (entry) => {
  const dir = await mkdtemp("/tmp/scriptc-effect4-");
  try {
    const reference = await run(process.execPath, ["--no-warnings", entry]);
    expect(reference.status).toBe(0);
    expect(reference.stdout.trim().length).toBeGreaterThan(0);
    const options = {
      outDir: dir, outPath: join(dir, "program"), backend: "llvm", optimization: "dev", dynamic: false,
      npmStatic: ["effect", "@effect/platform-node", "@effect/platform-node-shared", "undici"], sanitize,
    };
    // Published cluster graphs need more heap than Node's default. Compile
    // each fixture in an isolated process so successive graphs release all
    // checker state and the worker's memory stays bounded.
    const source = new URL("../../packages/compiler/src/index.ts", import.meta.url).href;
    const child = `import { compile } from ${JSON.stringify(source)};
      import { writeFileSync } from "node:fs";
      const result = await compile(process.argv[1], JSON.parse(process.argv[2]));
      writeFileSync(process.argv[3], JSON.stringify(result));`;
    const resultPath = join(dir, "compile.json");
    await exec(process.execPath, ["--max-old-space-size=8192", "--import", "tsx", "--input-type=module", "--eval", child, entry, JSON.stringify(options), resultPath], { timeout: 540_000 });
    const result = JSON.parse(await readFile(resultPath, "utf8")) as CompileResult;
    if (!result.ok) throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const actual = await run(result.binaryPath, []);
    if (sanitize) actual.stderr = actual.stderr.split("\n").filter((line) =>
      !line.startsWith("scriptc RC audit skipped:") &&
      !/^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext/.test(line),
    ).join("\n");
    expect(actual).toEqual(reference);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
