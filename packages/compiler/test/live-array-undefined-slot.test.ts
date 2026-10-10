import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

test("a checked-dynamic write can store undefined in a number array", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-live-array-undefined-"));
  const pkg = join(directory, "node_modules", "effect");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "effect", version: "0.0.0" }));
  writeFileSync(
    join(pkg, "probe.d.ts"),
    `export function clearSlot<A extends number>(message: A): A;
`,
  );
  writeFileSync(
    join(pkg, "probe.js"),
    `export function clearSlot(message) {
  const box = { array: [message] };
  const value = box.array[0];
  box.array[0] = undefined;
  return value;
}
`,
  );
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  writeFileSync(
    entry,
    `import { clearSlot } from "effect/probe.js";
console.log(JSON.stringify(clearSlot(7)));
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
    expect(run.stdout).toBe("7\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
