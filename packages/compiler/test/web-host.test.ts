import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze, compile } from "../src/index.js";

function project(): string {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-web-host-"));
  mkdirSync(join(directory, "node_modules", "@types"), { recursive: true });
  symlinkSync(
    join(import.meta.dirname, "../../../node_modules/@types/node"),
    join(directory, "node_modules/@types/node"),
  );
  const pkg = join(directory, "node_modules", "effect");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "effect", version: "0.0.0" }));
  // A config file is what loads @types/node. Effect's harness has one;
  // without it `navigator` stays an unbound JavaScript name.
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, types: ["node"] } }) + "\n",
  );
  return directory;
}

async function runBoth(directory: string, source: string, probe: string): Promise<string> {
  writeFileSync(join(directory, "node_modules", "effect", "probe.js"), probe);
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  writeFileSync(entry, source);
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
  if (!result.ok) return "";
  const run = spawnSync(result.binaryPath, [], { encoding: "utf8" });
  const oracle = spawnSync(process.execPath, ["--experimental-strip-types", entry], {
    encoding: "utf8",
  });
  expect(oracle.status, oracle.stderr).toBe(0);
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  expect(run.stdout).toBe(oracle.stdout);
  return run.stdout;
}

test("globalThis.crypto?.subtle hashes through the native digest", async () => {
  const directory = project();
  try {
    const stdout = await runBoth(
      directory,
      `import { hash } from "effect/probe.js";
console.log(await hash());
`,
      `export async function hash() {
  const subtle = globalThis.crypto?.subtle;
  const digest = await subtle.digest("SHA-256", new Uint8Array([97, 98, 99]));
  const bytes = new Uint8Array(digest);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
`,
    );
    expect(stdout).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);

test("new globalThis.WebSocket compiles and throws when called", async () => {
  const directory = project();
  try {
    writeFileSync(
      join(directory, "node_modules", "effect", "probe.js"),
      `export function open(url, options) {
  if (options !== undefined && typeof options !== "string" && !Array.isArray(options)) {
    throw new TypeError("WebSocket client options are not supported by the global WebSocket constructor");
  }
  return new globalThis.WebSocket(url, options);
}
`,
    );
    const entry = join(directory, "main.ts");
    const binary = join(directory, "main");
    writeFileSync(
      entry,
      `import { open } from "effect/probe.js";
try {
  open("ws://example", "proto");
  console.log("opened");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log((error instanceof TypeError ? "TypeError: " : "other: ") + message);
}
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
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    // Node would open a socket. With @types/node the call is the refused
    // WebSocket constructor, so the compiled call throws instead of connecting.
    expect(run.stdout).toBe("TypeError: WebSocket is not supported\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);

test("a guarded bare location reads as a missing global", async () => {
  const directory = project();
  try {
    const stdout = await runBoth(
      directory,
      `import { base } from "effect/probe.js";
console.log(base());
`,
      `export function base() {
  if (
    "location" in globalThis &&
    globalThis.location !== undefined &&
    globalThis.location.origin !== undefined &&
    globalThis.location.pathname !== undefined
  ) {
    return location.origin + location.pathname;
  }
  return "none";
}
`,
    );
    expect(stdout).toBe("none\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);

test("globalThis.Function falls back inside try/catch with the same result", async () => {
  const directory = project();
  try {
    const stdout = await runBoth(
      directory,
      `import { decode } from "effect/probe.js";
console.log(JSON.stringify(decode()));
`,
      `export function decode() {
  try {
    const fn = globalThis.Function("return ({ name: 'fixture', value: 7 })");
    return fn();
  } catch {
    return { name: "fixture", value: 7 };
  }
}
`,
    );
    expect(stdout).toBe('{"name":"fixture","value":7}\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);

test("navigator.locks.request matches Node for grant, queue, and abort", async () => {
  const directory = project();
  try {
    const stdout = await runBoth(
      directory,
      `import { run } from "effect/probe.js";
console.log(await run());
`,
      `export async function run() {
  const order = [];
  const first = navigator.locks.request("q", async () => {
    order.push("start1");
    await Promise.resolve();
    order.push("end1");
    return 1;
  });
  const second = navigator.locks.request("q", async () => {
    order.push("start2");
    return 2;
  });
  const granted = [await first, await second];
  const named = await navigator.locks.request("c", { mode: "exclusive" }, (lock) => lock.name + ":" + lock.mode);
  const controller = new AbortController();
  controller.abort();
  let aborted = "";
  try {
    await navigator.locks.request("s", { signal: controller.signal }, () => 1);
  } catch (error) {
    aborted = error.name + " " + error.message;
  }
  let bad = "";
  try {
    await navigator.locks.request("a");
  } catch (error) {
    bad = error.message;
  }
  return JSON.stringify([granted, order, named, aborted, bad]);
}
`,
    );
    expect(stdout).toContain("start1");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);

test("Response.clone and formData match Node", async () => {
  const directory = project();
  try {
    const stdout = await runBoth(
      directory,
      `import { probe } from "effect/probe.js";
console.log(await probe());
`,
      `export async function probe() {
  const cloned = new Response("hello", {
    status: 201,
    statusText: "Made",
    headers: { "content-type": "text/plain" },
  });
  const clone = cloned.clone();
  clone.headers.append("x-clone", "yes");
  const cloneText = await clone.text();
  const originalText = await cloned.text();
  const consumed = new Response("x");
  await consumed.text();
  let consumedClone = "";
  try {
    consumed.clone();
    consumedClone = "missed";
  } catch (error) {
    consumedClone = error.name + " " + error.message;
  }
  const form = await new Response("a=1&b=2", {
    headers: { "content-type": "application/x-www-form-urlencoded" },
  }).formData();
  let badType = "";
  try {
    await new Response("a=1").formData();
    badType = "missed";
  } catch (error) {
    badType = error.name + " " + error.message;
  }
  const boundary = "----b";
  const body = "--" + boundary + "\\r\\nContent-Disposition: form-data; name=\\"n\\"\\r\\n\\r\\nhi\\r\\n--" + boundary + "--\\r\\n";
  const multipart = await new Response(body, {
    headers: { "content-type": "multipart/form-data; boundary=" + boundary },
  }).formData();
  return JSON.stringify([
    clone.status,
    clone.statusText,
    clone.headers.get("content-type"),
    clone.headers.get("x-clone"),
    cloned.headers.get("x-clone"),
    cloned.bodyUsed,
    cloneText,
    originalText,
    consumedClone,
    Array.from(form.entries()),
    form.get("a"),
    form.get("missing"),
    badType,
    Array.from(multipart.entries()),
  ]);
}
`,
    );
    expect(stdout).toContain("hello");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
