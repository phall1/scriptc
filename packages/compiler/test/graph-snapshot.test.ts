import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// Graph.hydrate walks snapshot nodes and edges. The loop variable is a
// record stored as T | undefined; reading .index must use that record.
const graphSnapshotSource = `import * as Graph from "effect/Graph"
const graph = Graph.fromSnapshot({
  type: "directed",
  nodes: [{ index: 2, data: "A" }, { index: 5, data: "B" }],
  edges: [{ index: 3, source: 2, target: 5, data: 1 }]
})
console.log(JSON.stringify([Graph.toSnapshot(graph).edges[0].index]))
`;

test("Graph.fromSnapshot keeps the edge index", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-graph-snapshot-"));
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  mkdirSync(directory, { recursive: true });
  symlinkSync(
    join(import.meta.dirname, "../../../../effect-scriptc-compat/node_modules"),
    join(directory, "node_modules"),
    "dir",
  );
  writeFileSync(entry, graphSnapshotSource);
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
    expect(run.stdout).toBe("[3]\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
