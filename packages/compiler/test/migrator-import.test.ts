import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze, compile } from "../src/index.js";

function project(): string {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-migrator-"));
  mkdirSync(join(directory, "node_modules", "@types"), { recursive: true });
  symlinkSync(
    join(import.meta.dirname, "../../../node_modules/@types/node"),
    join(directory, "node_modules/@types/node"),
  );
  const pkg = join(directory, "node_modules", "effect");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "effect", version: "0.0.0" }));
  writeFileSync(
    join(pkg, "Function.js"),
    `export const dual = function (arity, body) {
  switch (arity) {
    case 2:
      return function (a, b) {
        if (arguments.length >= 2) return body(a, b);
        return function (self) { return body(self, a); };
      };
    default:
      throw new RangeError("bad arity");
  }
};
`,
  );
  writeFileSync(
    join(pkg, "Option.js"),
    `import { dual } from "./Function.js";
const isNone = (self) => self._tag === "None";
export const match = /*#__PURE__*/dual(2, (self, { onNone, onSome }) => isNone(self) ? onNone() : onSome(self.value));
export const fromNullishOr = (value) => value == null ? { _tag: "None" } : { _tag: "Some", value };
`,
  );
  return directory;
}

test("data-last Option.match flatMaps like Node", async () => {
  const directory = project();
  try {
    writeFileSync(
      join(directory, "node_modules", "effect", "probe.js"),
      `import { fromNullishOr, match } from "./Option.js";
export function load(files) {
  return files.map((file) => fromNullishOr(file.match(/^(\\d+)_(.+)$/))).flatMap(match({
    onNone: () => [],
    onSome: ([basename, id, name]) => [[Number(id), name]]
  }));
}
`,
    );
    const entry = join(directory, "main.ts");
    const binary = join(directory, "main");
    writeFileSync(
      entry,
      `import { load } from "effect/probe.js";
console.log(JSON.stringify(load(["1_init.js", "nope", "2_add.ts"])));
`,
    );
    const coverage = analyze(entry, { npmStatic: ["effect"] });
    const fences = [...coverage.coverage.diagnostics, ...(coverage.coverage.runtimeFences ?? [])];
    expect(fences, JSON.stringify(fences)).toEqual([]);
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
    const oracle = spawnSync(process.execPath, ["--experimental-strip-types", entry], {
      encoding: "utf8",
    });
    expect(oracle.status, oracle.stderr).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(oracle.stdout);
    expect(run.stdout).toBe('[[1,"init.js"],[2,"add.ts"]]\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);

test("computed import in an uncalled migrator loader compiles", async () => {
  const directory = project();
  try {
    writeFileSync(
      join(directory, "node_modules", "effect", "probe.js"),
      `import { fromNullishOr, match } from "./Option.js";
export function fromFileSystem(files) {
  return files.map((file) => fromNullishOr(file.match(/^(?:.*\\/)?(\\d+)_([^.]+)\\.(js|ts)$/))).flatMap(match({
    onNone: () => [],
    onSome: ([basename, id, name]) => [[Number(id), name, import(basename)]]
  }));
}
`,
    );
    const entry = join(directory, "main.ts");
    const binary = join(directory, "main");
    writeFileSync(
      entry,
      `import { fromFileSystem } from "effect/probe.js";
console.log(JSON.stringify(fromFileSystem(["nope", "also-nope"])));
`,
    );
    const coverage = analyze(entry, { npmStatic: ["effect"] });
    const fences = [...coverage.coverage.diagnostics, ...(coverage.coverage.runtimeFences ?? [])];
    expect(fences, JSON.stringify(fences)).toEqual([]);
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
    const oracle = spawnSync(process.execPath, ["--experimental-strip-types", entry], {
      encoding: "utf8",
    });
    expect(oracle.status, oracle.stderr).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(oracle.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
