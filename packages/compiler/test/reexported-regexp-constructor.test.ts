import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

test("a re-exported RegExp constructor builds, tests, and stringifies", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-re-regexp-"));
  const pkg = join(directory, "node_modules", "effect");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "effect",
      version: "0.0.0",
      exports: { "./RegExp": "./RegExp.js" },
    }),
  );
  writeFileSync(join(pkg, "RegExp.js"), "export const RegExp = globalThis.RegExp;\n");
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  writeFileSync(
    entry,
    `import * as RegExp from "effect/RegExp";
const observed: unknown[] = [];
const pattern = new RegExp.RegExp("hello", "i");
observed.push(pattern);
observed.push(pattern.test("Hello World"));
observed.push(pattern.test("goodbye"));
console.log(JSON.stringify(observed));
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
    expect(run.stdout).toBe("[{},true,false]\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
