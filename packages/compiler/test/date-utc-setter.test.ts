import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

test("UTC date setters update the local and string 'in' stays inside its guard", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-date-set-"));
  const pkg = join(directory, "node_modules", "effect");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "effect", version: "0.0.0" }));
  writeFileSync(
    join(pkg, "probe.d.ts"),
    `export function wall(): string;
export function viaHelper(): string;
export function year99(): string;
export function fromInvalid(): string;
export function monthRoll(): string;
export function guard(input: string | { timeZoneId: string }): string;
`,
  );
  writeFileSync(
    join(pkg, "probe.js"),
    `function apply(date, year, month, day) {
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(0, 0, 0, 0);
}
export function wall() {
  const date = new Date(0);
  date.setUTCFullYear(2025, 10, 2);
  date.setUTCHours(1, 30, 0, 0);
  return date.toISOString();
}
export function viaHelper() {
  const date = new Date(0);
  apply(date, 2025, 10, 2);
  return date.toISOString();
}
export function year99() {
  const date = new Date(0);
  date.setUTCFullYear(99);
  return date.toISOString();
}
export function fromInvalid() {
  const date = new Date(NaN);
  date.setUTCFullYear(2020);
  return date.toISOString();
}
export function monthRoll() {
  const date = new Date(Date.UTC(2020, 0, 31, 5, 6, 7, 8));
  date.setUTCMonth(1);
  return date.toISOString();
}
export function guard(input) {
  if (typeof input === "object" && input !== null && "timeZoneId" in input) return input.timeZoneId;
  return "other";
}
`,
  );
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  writeFileSync(
    entry,
    `import { fromInvalid, guard, monthRoll, viaHelper, wall, year99 } from "effect/probe.js";
console.log(wall());
console.log(viaHelper());
console.log(year99());
console.log(fromInvalid());
console.log(monthRoll());
console.log(guard("UTC"));
console.log(guard({ timeZoneId: "EST" }));
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
    expect(run.stdout).toBe(
      [
        "2025-11-02T01:30:00.000Z",
        "2025-11-02T00:00:00.000Z",
        "0099-01-01T00:00:00.000Z",
        "2020-01-01T00:00:00.000Z",
        "2020-03-02T05:06:07.008Z",
        "other",
        "EST",
        "",
      ].join("\n"),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
