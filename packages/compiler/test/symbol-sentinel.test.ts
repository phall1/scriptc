import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function runJs(source: string): Promise<{ stdout: string; stderr: string; status: number | null }> {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-symbol-"));
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
    if (!result.ok) return { stdout: "", stderr: "", status: 1 };
    const run = spawnSync(result.binaryPath, [], { encoding: "utf8", timeout: 30_000 });
    return { stdout: run.stdout, stderr: run.stderr, status: run.status };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("a symbol sentinel return can also be the payload", async () => {
  const run = await runJs(`
const Empty = Symbol.for("effect/MutableList/Empty");
class Box {
  poll() {
    let polled = Empty;
    polled = 1;
    return polled;
  }
}
const box = new Box();
console.log(box.poll() === Empty ? "empty" : String(box.poll()));
`);
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  expect(run.stdout).toBe("1\n");
});

test("a symbol field can later hold a published number", async () => {
  const run = await runJs(`
const Absent = Symbol.for("effect/PubSub/AbsentValue");
class Slot {
  value = Absent;
  publish(value) {
    this.value = value;
  }
  poll() {
    const elem = this.value;
    this.value = Absent;
    return elem;
  }
}
const slot = new Slot();
slot.publish(0);
const elem = slot.poll();
console.log(elem === Absent ? "absent" : String(elem));
`);
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  expect(run.stdout).toBe("0\n");
});

test("pollUpTo collects a payload that the checker types as the sentinel", async () => {
  const run = await runJs(`
const Empty = Symbol.for("effect/MutableList/Empty");
class Box {
  poll() {
    let polled = Empty;
    polled = 1;
    return polled;
  }
  pollUpTo(n) {
    const builder = [];
    let i = 0;
    while (i !== n) {
      const a = this.poll();
      if (a === Empty) {
        i = n;
      } else {
        builder.push(a);
        i += 1;
      }
    }
    return builder;
  }
}
const box = new Box();
console.log(JSON.stringify(box.pollUpTo(1)));
`);
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  expect(run.stdout).toBe("[1]\n");
});

test("an object node stores a number beside a symbol sentinel", async () => {
  const run = await runJs(`
const Absent = Symbol.for("effect/PubSub/AbsentValue");
const head = { value: Absent, next: null };
const node = { value: 0, next: null };
head.next = node;
const elem = head.next.value;
console.log(elem === Absent ? "absent" : String(elem));
`);
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  expect(run.stdout).toBe("0\n");
});
