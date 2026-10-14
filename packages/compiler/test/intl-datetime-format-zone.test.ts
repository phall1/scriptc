import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

test("named Intl.DateTimeFormat offsets come from host zoneinfo", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-intl-zone-"));
  const pkg = join(directory, "node_modules", "effect");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "effect", version: "0.0.0" }));
  writeFileSync(
    join(pkg, "probe.d.ts"),
    `export function zoneName(zoneId: string): string;
export function zoneOffset(zoneId: string, millis: number): string;
export function wallIso(zoneId: string, millis: number): string;
export function invalidZone(): string;
`,
  );
  writeFileSync(
    join(pkg, "probe.js"),
    `function make(zoneId) {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    timeZoneName: "longOffset",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
    timeZone: zoneId,
  });
}
export function zoneName(zoneId) {
  return make(zoneId).resolvedOptions().timeZone;
}
export function zoneOffset(zoneId, millis) {
  return make(zoneId).formatToParts(millis).find((part) => part.type === "timeZoneName").value;
}
export function wallIso(zoneId, millis) {
  const parts = make(zoneId).formatToParts(millis).filter((part) => part.type !== "literal");
  const utc = Date.UTC(
    Number(parts[2].value),
    Number(parts[0].value) - 1,
    Number(parts[1].value),
    Number(parts[3].value),
    Number(parts[4].value),
    Number(parts[5].value),
    parts[6] && parts[6].type === "fractionalSecond" ? Number(parts[6].value) : 0,
  );
  return new Date(utc).toISOString();
}
export function invalidZone() {
  try {
    make("Not/AZone");
    return "no-throw";
  } catch (error) {
    return error.name;
  }
}
`,
  );
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  writeFileSync(
    entry,
    `import { invalidZone, wallIso, zoneName, zoneOffset } from "effect/probe.js";
const rows: Array<[string, number]> = [
  ["UTC", 1685955600000],
  ["America/New_York", 1762061400000],
  ["America/New_York", 1762065000000],
  ["America/New_York", 1741501800000],
  ["America/New_York", 1741505400000],
];
for (const [zone, millis] of rows) {
  console.log(zoneName(zone) + " " + zoneOffset(zone, millis) + " " + wallIso(zone, millis));
}
console.log(invalidZone());
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
        "UTC GMT+00:00 2023-06-05T09:00:00.000Z",
        "America/New_York GMT-04:00 2025-11-02T01:30:00.000Z",
        "America/New_York GMT-05:00 2025-11-02T01:30:00.000Z",
        "America/New_York GMT-05:00 2025-03-09T01:30:00.000Z",
        "America/New_York GMT-04:00 2025-03-09T03:30:00.000Z",
        "RangeError",
        "",
      ].join("\n"),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
