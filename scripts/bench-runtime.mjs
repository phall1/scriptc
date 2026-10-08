/* Runtime performance A/B harness for compiled programs.
 *
 * Builds every workload in benchmarks/runtime/workloads.json with one or two
 * scriptc checkouts, verifies each executable against Node byte-for-byte
 * (stdout, stderr, exit status), then times interleaved launches and reports
 * per-workload medians with bootstrap confidence intervals for the
 * candidate/baseline ratio. Executables that diverge from Node are never
 * timed. A per-host advisory lock serializes measurements so concurrent
 * agents on one machine do not disturb each other's numbers. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const suiteRoot = join(repoRoot, "benchmarks/runtime");

const { values } = parseArgs({
  options: {
    candidate: { type: "string", default: repoRoot },
    baseline: { type: "string" },
    workloads: { type: "string" },
    runs: { type: "string", default: "15" },
    warmup: { type: "string", default: "2" },
    timeout: { type: "string", default: "120" },
    json: { type: "string" },
    "no-lock": { type: "boolean", default: false },
    "keep": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(`Usage: node scripts/bench-runtime.mjs [--candidate=<checkout>] [--baseline=<checkout>]
       [--workloads=a,b] [--runs=11] [--warmup=2] [--timeout=120] [--json=<file>] [--no-lock] [--keep]

Each checkout must have a built CLI (packages/cli/dist/bootstrap.js) and native
artifacts for this host. Without --baseline, reports absolute times only.`);
  process.exit(0);
}
const runs = Number(values.runs);
const warmup = Number(values.warmup);
const timeoutMs = Number(values.timeout) * 1000;
assert.ok(Number.isInteger(runs) && runs >= 3 && runs <= 200, "--runs must be 3..200");
assert.ok(Number.isInteger(warmup) && warmup >= 0 && warmup <= 20, "--warmup must be 0..20");

const manifest = JSON.parse(readFileSync(join(suiteRoot, "workloads.json"), "utf8"));
const selected = values.workloads ? new Set(values.workloads.split(",")) : null;
const workloads = manifest.workloads.filter((w) => selected === null || selected.has(w.name));
if (selected) {
  for (const name of selected)
    assert.ok(
      manifest.workloads.some((w) => w.name === name),
      `unknown workload ${name}`,
    );
}

const work = mkdtempSync(
  join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-bench-runtime-"),
);

/* ── inputs for file-processing applications ──────────────────────────── */
function generateInput(kind) {
  const path = join(work, `${kind}.input`);
  if (kind === "log-summary") {
    writeFileSync(
      path,
      Array.from(
        { length: 300_000 },
        (_, i) =>
          `/route/${i % 37}?request=${i} ${i % 13 === 0 ? 500 : 200} ${i % 250} ${200 + (i % 4000)}`,
      ).join("\n") + "\n",
    );
  } else if (kind === "inventory-report") {
    writeFileSync(
      path,
      Array.from({ length: 300_000 }, (_, i) =>
        ["sku-" + i, "category-" + (i % 17), "product " + i, i % 40, 199 + (i % 5000)].join("\t"),
      ).join("\n") + "\n",
    );
  } else throw new Error(`unknown input kind ${kind}`);
  return path;
}

/* ── advisory lock ─────────────────────────────────────────────────────── */
const lockDir = join(
  process.platform === "win32" ? tmpdir() : "/tmp",
  "scriptc-bench-runtime.lock",
);
function acquireLock() {
  const started = Date.now();
  let announced = false;
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, "pid"), String(process.pid));
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner = NaN;
      try {
        owner = Number(readFileSync(join(lockDir, "pid"), "utf8"));
      } catch {}
      let alive = false;
      if (Number.isInteger(owner)) {
        try {
          process.kill(owner, 0);
          alive = true;
        } catch {}
      }
      if (!alive && Date.now() - started > 2000) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (!announced) {
        process.stderr.write(`waiting for benchmark lock held by pid ${owner}\n`);
        announced = true;
      }
      spawnSync("sleep", ["2"]);
    }
  }
}
function releaseLock() {
  rmSync(lockDir, { recursive: true, force: true });
}

/* ── process helpers ───────────────────────────────────────────────────── */
function run(command, args, options = {}) {
  const start = process.hrtime.bigint();
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? timeoutMs,
    env: options.env ?? process.env,
    cwd: options.cwd,
  });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  if (result.error && result.error.code !== "ETIMEDOUT") throw result.error;
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
    signal: result.signal,
    timedOut: result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM",
    ms,
  };
}

function peakRss(binary, args) {
  if (process.platform !== "darwin" && process.platform !== "linux") return null;
  if (!existsSync("/usr/bin/time")) return null;
  const timeArgs =
    process.platform === "darwin" ? ["-l", binary, ...args] : ["-f", "rss_kib=%M", binary, ...args];
  const result = run("/usr/bin/time", timeArgs);
  const match =
    process.platform === "darwin"
      ? /(\d+)\s+maximum resident set size/.exec(result.stderr)
      : /rss_kib=(\d+)/.exec(result.stderr);
  if (!match) return null;
  return Number(match[1]) * (process.platform === "darwin" ? 1 : 1024);
}

/* ── statistics ────────────────────────────────────────────────────────── */
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
function bootstrapRatio(candidate, baseline, resamples = 2000) {
  const random = makeRandom(0x5eed);
  const ratios = [];
  const pick = (xs) =>
    Array.from({ length: xs.length }, () => xs[Math.floor(random() * xs.length)]);
  for (let i = 0; i < resamples; i++) ratios.push(median(pick(candidate)) / median(pick(baseline)));
  ratios.sort((a, b) => a - b);
  return {
    low: ratios[Math.floor(resamples * 0.025)],
    high: ratios[Math.floor(resamples * 0.975)],
  };
}

/* ── build ─────────────────────────────────────────────────────────────── */
function cliFor(root) {
  const cli = join(resolve(root), "packages/cli/dist/bootstrap.js");
  statSync(cli);
  return cli;
}
function revision(root) {
  const r = run("git", ["-C", root, "rev-parse", "--short", "HEAD"], { timeout: 10_000 });
  const dirty = run("git", ["-C", root, "status", "--porcelain", "--untracked-files=no"], {
    timeout: 10_000,
  });
  return r.stdout.trim() + (dirty.stdout.trim() ? "+dirty" : "");
}
function build(label, root, workload) {
  const cli = cliFor(root);
  const out = join(work, label, workload.name);
  mkdirSync(dirname(out), { recursive: true });
  const cache = join(work, label, ".cache");
  mkdirSync(cache, { recursive: true });
  const env = { ...process.env, SCRIPTC_CACHE_DIR: cache };
  delete env.SCRIPTC_NO_CACHE;
  delete env.SCRIPTC_TIMING;
  const entry = join(suiteRoot, workload.entry);
  const result = run(process.execPath, [cli, "build", entry, "--optimization=release", "-o", out], {
    env,
    timeout: 900_000,
  });
  if (result.status !== 0)
    return {
      ok: false,
      error: (result.stderr || result.stdout).slice(0, 4000),
      buildMs: result.ms,
    };
  return { ok: true, binary: out, bytes: statSync(out).size, buildMs: result.ms };
}

/* ── main ──────────────────────────────────────────────────────────────── */
const contenders = [
  ...(values.baseline ? [{ label: "baseline", root: resolve(values.baseline) }] : []),
  { label: "candidate", root: resolve(values.candidate) },
];
const report = {
  schema: 1,
  date: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, node: process.version },
  runs,
  contenders: contenders.map((c) => ({ ...c, revision: revision(c.root) })),
  workloads: [],
};

try {
  const inputs = new Map();
  for (const w of workloads)
    if (w.input && !inputs.has(w.input)) inputs.set(w.input, generateInput(w.input));

  // Builds and the Node oracle run outside the lock: they do not need a
  // quiet machine, and holding the lock while compiling would serialize
  // every agent's slowest phase.
  const prepared = [];
  for (const w of workloads) {
    const args = w.args.map((a) => (a === "{input}" ? inputs.get(w.input) : a));
    // The application workloads are ESM without a package.json "type"; Node's
    // reparse warning is an oracle artifact, not program output.
    const oracle = run(process.execPath, [
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      join(suiteRoot, w.entry),
      ...args,
    ]);
    const entry = { name: w.name, args, results: {} };
    if (oracle.status !== 0 || oracle.timedOut) {
      entry.error = `node oracle failed (status ${oracle.status}): ${oracle.stderr.slice(0, 2000)}`;
      prepared.push(entry);
      continue;
    }
    for (const c of contenders) {
      const built = build(c.label, c.root, w);
      const result = { build_ms: Math.round(built.buildMs) };
      entry.results[c.label] = result;
      if (!built.ok) {
        result.status = "build-failed";
        result.error = built.error;
        continue;
      }
      result.bytes = built.bytes;
      result.binary = built.binary;
      const check = run(built.binary, args);
      if (check.timedOut) {
        result.status = "timeout";
        continue;
      }
      if (
        check.stdout !== oracle.stdout ||
        check.stderr !== oracle.stderr ||
        check.status !== oracle.status
      ) {
        result.status = "mismatch";
        result.error = `expected status ${oracle.status}, got ${check.status}; stdout ${check.stdout === oracle.stdout ? "matches" : "differs"}; stderr ${check.stderr === oracle.stderr ? "matches" : "differs"}`;
        continue;
      }
      result.status = "ok";
      result.samples = [];
    }
    entry.node_ms = Math.round(oracle.ms);
    prepared.push(entry);
    process.stderr.write(`prepared ${w.name}\n`);
  }

  if (!values["no-lock"]) acquireLock();
  try {
    for (const entry of prepared) {
      const live = contenders.filter((c) => entry.results[c.label]?.status === "ok");
      if (live.length === 0) continue;
      for (const c of live)
        for (let i = 0; i < warmup; i++) run(entry.results[c.label].binary, entry.args);
      const random = makeRandom(entry.name.length * 7919);
      for (let r = 0; r < runs; r++) {
        const order = [...live];
        if (order.length === 2 && random() < 0.5) order.reverse();
        for (const c of order) {
          const result = entry.results[c.label];
          const sample = run(result.binary, entry.args);
          if (sample.timedOut || sample.status !== 0) {
            result.status = sample.timedOut ? "timeout" : "unstable-exit";
            break;
          }
          result.samples.push(Math.round(sample.ms * 100) / 100);
        }
      }
      for (const c of live) {
        const result = entry.results[c.label];
        if (result.status !== "ok") continue;
        result.median_ms = Math.round(median(result.samples) * 100) / 100;
        result.peak_rss_bytes = peakRss(result.binary, entry.args);
      }
      const base = entry.results.baseline;
      const cand = entry.results.candidate;
      if (base?.status === "ok" && cand?.status === "ok") {
        const ci = bootstrapRatio(cand.samples, base.samples);
        entry.ratio = Math.round((cand.median_ms / base.median_ms) * 10000) / 10000;
        entry.ci95 = [Math.round(ci.low * 10000) / 10000, Math.round(ci.high * 10000) / 10000];
        entry.verdict = ci.high < 1 ? "faster" : ci.low > 1 ? "slower" : "neutral";
        entry.size_ratio = Math.round((cand.bytes / base.bytes) * 10000) / 10000;
      }
      process.stderr.write(`measured ${entry.name}\n`);
    }
  } finally {
    if (!values["no-lock"]) releaseLock();
  }
  for (const entry of prepared) {
    for (const result of Object.values(entry.results)) delete result.binary;
    report.workloads.push(entry);
  }
  const ratios = report.workloads.filter((w) => w.ratio !== undefined).map((w) => w.ratio);
  if (ratios.length > 0)
    report.geomean_ratio =
      Math.round(Math.exp(ratios.reduce((s, r) => s + Math.log(r), 0) / ratios.length) * 10000) /
      10000;
} finally {
  if (!values.keep) rmSync(work, { recursive: true, force: true });
}

if (values.json) writeFileSync(values.json, JSON.stringify(report, null, 2) + "\n");

/* ── summary table ─────────────────────────────────────────────────────── */
const pct = (r) => `${r < 1 ? "" : "+"}${((r - 1) * 100).toFixed(1)}%`;
const lines = [];
if (values.baseline) {
  lines.push(
    "| workload | baseline ms | candidate ms | change | 95% CI | verdict | size | node ms |",
  );
  lines.push("| --- | ---: | ---: | ---: | --- | --- | ---: | ---: |");
} else {
  lines.push("| workload | median ms | status | bytes | peak RSS MiB | node ms |");
  lines.push("| --- | ---: | --- | ---: | ---: | ---: |");
}
for (const w of report.workloads) {
  const b = w.results.baseline;
  const c = w.results.candidate;
  if (w.error) {
    lines.push(`| ${w.name} | ${w.error.split("\n")[0]} |`);
  } else if (values.baseline) {
    const show = (r) => (r?.status === "ok" ? r.median_ms.toFixed(1) : (r?.status ?? "-"));
    lines.push(
      `| ${w.name} | ${show(b)} | ${show(c)} | ${w.ratio ? pct(w.ratio) : "-"} | ${w.ci95 ? `${pct(w.ci95[0])} .. ${pct(w.ci95[1])}` : "-"} | ${w.verdict ?? "-"} | ${w.size_ratio ? pct(w.size_ratio) : "-"} | ${w.node_ms} |`,
    );
  } else {
    lines.push(
      `| ${w.name} | ${c?.median_ms?.toFixed(1) ?? "-"} | ${c?.status ?? "-"} | ${c?.bytes ?? "-"} | ${c?.peak_rss_bytes ? (c.peak_rss_bytes / 1048576).toFixed(1) : "-"} | ${w.node_ms} |`,
    );
  }
}
if (report.geomean_ratio !== undefined)
  lines.push("", `geomean change: ${pct(report.geomean_ratio)}`);
console.log(lines.join("\n"));
const broken = report.workloads.some(
  (w) => w.error || Object.values(w.results).some((r) => r.status !== "ok"),
);
process.exitCode = broken ? 1 : 0;
