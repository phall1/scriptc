import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

const source = `
function optionsFrom(endpoint) {
  return {
    identifier: endpoint.identifier,
    path: endpoint.path,
  };
}
function makeProto(options) {
  function Endpoint() {}
  return Object.assign(Endpoint, options);
}
const Proto = {
  middleware(middleware) {
    return makeProto({
      ...optionsFrom(this),
      middlewares: middleware,
    });
  },
};
const endpoint = Object.assign(function Endpoint() {}, {
  identifier: "read",
  path: "/hello",
});
Object.setPrototypeOf(endpoint, Proto);
const out = endpoint.middleware("checked");
console.log(out.identifier + ":" + out.path + ":" + out.middlewares);
`;

test("a JavaScript spread of an unknown object keeps the source keys", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-unknown-spread-"));
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
    expect(run.stdout).toBe("read:/hello:checked\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
