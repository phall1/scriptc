import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

const source = `
function Base() {}
class Service extends Base {}
const self = Service;
const TypeId = "~effect/http-api/HttpApiMiddleware";
Object.defineProperty(Service, "stack", {
  get() {
    return "stack";
  },
});
self[TypeId] = TypeId;
self.error = "err";
console.log(self[TypeId] + ":" + Service.stack + ":" + self.error);
`;

test("computed assignment on a class constructor stores the static", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-class-key-"));
  const entry = join(directory, "main.js");
  const binary = join(directory, "main");
  writeFileSync(entry, source);
  try {
    const result = await compile(entry, {
      outDir: directory,
      outPath: binary,
      outputKind: "exe",
      optimization: "dev",
    });
    expect(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const run = spawnSync(result.binaryPath, [], { encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("~effect/http-api/HttpApiMiddleware:stack:err\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
