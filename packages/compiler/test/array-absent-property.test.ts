import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

test("a missing property on a number array reads undefined inside its guard", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-array-prop-"));
  const pkg = join(directory, "node_modules", "effect");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "effect", version: "0.0.0" }));
  writeFileSync(
    join(pkg, "probe.d.ts"),
    `export function toPull(take: number[] | { _tag: string; value: number }): number[] | number;
`,
  );
  writeFileSync(
    join(pkg, "probe.js"),
    `function isTagged(u) {
  return typeof u === "object" && u !== null && u._tag === "Exit";
}
export function toPull(take) {
  return isTagged(take) ? take.value : take;
}
`,
  );
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  writeFileSync(
    entry,
    `import { toPull } from "effect/probe.js";
const batch = toPull([1, 2, 3]);
console.log(Array.isArray(batch) ? batch.join(",") : String(batch));
console.log(String(toPull({ _tag: "Exit", value: 9 })));
`,
  );
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
    const run = spawnSync(result.binaryPath, [], { encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("1,2,3\n9\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
