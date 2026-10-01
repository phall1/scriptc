import { execFile } from "node:child_process";
import { globSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { shardSelect } from "./shard.js";

const exec = promisify(execFile);
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const fixtures = globSync(join(import.meta.dirname, "../fixtures/effect/*.ts")).sort();
const cases = shardSelect(fixtures, (file) => basename(file));

async function run(command: string, args: string[]) {
  try {
    const { stdout, stderr } = await exec(command, args, { encoding: "utf8", timeout: 30_000 });
    return { stdout, stderr, status: 0 };
  } catch (error) {
    const result = error as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof result.code !== "number") throw error;
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.code };
  }
}

test.for(cases)("published Effect %s matches Node statically", async (entry) => {
  const dir = await mkdtemp("/tmp/scriptc-effect-");
  try {
    const reference = await run(process.execPath, ["--no-warnings", entry]);
    expect(reference.status).toBe(0);
    expect(reference.stdout.trim().length).toBeGreaterThan(0);
    const result = await compile(entry, {
      outDir: dir, outPath: join(dir, "program"), backend: "llvm", dynamic: false,
      npmStatic: ["effect", "fast-check", "pure-rand"], sanitize,
    });
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
}, 240_000);
