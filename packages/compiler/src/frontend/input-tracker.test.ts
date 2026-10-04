import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import {
  FrontendInputTracker,
  frontendInputsStillMatch,
  frontendInputsSemanticallyMatch,
  trackedAccessibleEntries,
  trackedDirectoryExists,
  trackedFileExists,
  markFrontendInputsUnstable,
  trackedReadFile,
  validFrontendInputSnapshot,
} from "./input-tracker.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const scratch: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("source priority retains every dependency and leaves earlier snapshots unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const source = join(dir, "z-source.ts");
  const declaration = join(dir, "a-types.d.ts");
  const candidate = join(dir, "missing.ts");
  await writeFile(source, "export const value = 1;");
  await writeFile(declaration, "declare const value: number;");
  const tracker = new FrontendInputTracker();
  tracker.run(() => {
    trackedReadFile(declaration);
    trackedFileExists(candidate);
    trackedReadFile(source);
  });
  const ordinary = tracker.snapshot();
  const prioritized = tracker.snapshot(new Map([[source, ""]]));
  expect(prioritized.probes[0]?.path).toBe(source);
  expect(prioritized.probes).toHaveLength(ordinary.probes.length);
  expect(prioritized.probes).toEqual(expect.arrayContaining(ordinary.probes));
  expect(tracker.snapshot()).toEqual(ordinary);
  expect(frontendInputsStillMatch(prioritized)).toBe(true);
  await writeFile(declaration, "declare const value: string;");
  expect(frontendInputsStillMatch(prioritized)).toBe(false);
  await writeFile(declaration, "declare const value: number;");
  await writeFile(candidate, "export {};");
  expect(frontendInputsStillMatch(prioritized)).toBe(false);
});

async function semanticFixture() {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const source = join(dir, "source.ts");
  const dependency = join(dir, "types.d.ts");
  const previous = "export const value = 1;\n";
  await writeFile(source, previous);
  await writeFile(dependency, "declare const dependency: number;\n");
  const tracker = new FrontendInputTracker();
  tracker.run(() => { trackedReadFile(source); trackedReadFile(dependency); });
  return { dir, source, dependency, previous, snapshot: tracker.snapshot(new Map([[source, ""]])), sources: new Map([[source, previous]]) };
}

test("semantic reuse reads unchanged dependencies once and revalidates accepted sources", async () => {
  const f = await semanticFixture();
  const current = `// comment\n${f.previous}`;
  await writeFile(f.source, current);
  const reads = vi.mocked(fs.readFileSync).mockClear();
  const equivalent = vi.fn(() => true);
  const result = frontendInputsSemanticallyMatch(f.snapshot, f.sources, equivalent);
  expect(result?.changed).toEqual([{ path: f.source, previous: f.previous, current }]);
  expect(result?.currentSources).toEqual(new Map([[f.source, current]]));
  expect(equivalent).toHaveBeenCalledOnce();
  expect(reads.mock.calls.filter(([path]) => path === f.dependency)).toHaveLength(1);
  expect(reads.mock.calls.filter(([path]) => path === f.source)).toHaveLength(2);
  expect(frontendInputsStillMatch(f.snapshot)).toBe(false);
  expect(result !== null && frontendInputsStillMatch(result.snapshot)).toBe(true);
});

test("semantic rejection stops before unrelated content reads", async () => {
  const f = await semanticFixture();
  await writeFile(f.source, "export const value = 2;\n");
  const reads = vi.mocked(fs.readFileSync).mockClear();
  expect(frontendInputsSemanticallyMatch(f.snapshot, f.sources, () => false)).toBeNull();
  expect(reads.mock.calls.filter(([path]) => path === f.dependency)).toHaveLength(0);
});

test("semantic validation refuses missing sources and mismatched stored source text", async () => {
  const f = await semanticFixture();
  const equivalent = vi.fn(() => true);
  expect(frontendInputsSemanticallyMatch(f.snapshot, new Map([[f.source, "different"]]), equivalent)).toBeNull();
  await rm(f.source);
  expect(frontendInputsSemanticallyMatch(f.snapshot, f.sources, equivalent)).toBeNull();
  expect(equivalent).not.toHaveBeenCalled();
});

test("semantic validation rejects source changes during equivalence checking", async () => {
  const f = await semanticFixture();
  await writeFile(f.source, `// comment\n${f.previous}`);
  const result = frontendInputsSemanticallyMatch(f.snapshot, f.sources, () => {
    fs.writeFileSync(f.source, "export const value = 2;\n");
    return true;
  });
  expect(result).toBeNull();
});

test("semantic validation checks non-source content and missing resolution candidates", async () => {
  const f = await semanticFixture();
  await writeFile(f.source, `// comment\n${f.previous}`);
  await writeFile(f.dependency, "declare const dependency: string;\n");
  expect(frontendInputsSemanticallyMatch(f.snapshot, f.sources, () => true)).toBeNull();
  await writeFile(f.dependency, "declare const dependency: number;\n");
  const candidate = join(f.dir, "new-module.ts");
  const tracker = new FrontendInputTracker();
  tracker.run(() => trackedFileExists(candidate));
  const snapshot = { ...f.snapshot, probes: [...f.snapshot.probes, ...tracker.snapshot().probes] };
  await writeFile(candidate, "export {};\n");
  expect(frontendInputsSemanticallyMatch(snapshot, f.sources, () => true)).toBeNull();
});

test("tracked frontend reads invalidate on byte edits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const file = join(dir, "entry.ts");
  await writeFile(file, "export const answer = 1;\n");

  const tracker = new FrontendInputTracker();
  tracker.run(() => expect(trackedReadFile(file)).toContain("answer"));
  const snapshot = tracker.snapshot();
  expect(validFrontendInputSnapshot(snapshot)).toBe(true);
  expect(frontendInputsStillMatch(snapshot)).toBe(true);

  await writeFile(file, "export const answer = 2;\n");
  expect(frontendInputsStillMatch(snapshot)).toBe(false);
});

test("failed frontend reads invalidate when the same file becomes readable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const file = join(dir, "unreadable.ts");
  await writeFile(file, "export const repaired = true;\n");
  await chmod(file, 0o000);

  const tracker = new FrontendInputTracker();
  const result = tracker.run(() => trackedReadFile(file));
  if (result !== null) {
    // Windows and privileged test users may not enforce POSIX mode bits.
    await chmod(file, 0o600);
    return;
  }
  const snapshot = tracker.snapshot();
  expect(snapshot.probes).toContainEqual({ op: "read-error", path: file });
  expect(frontendInputsStillMatch(snapshot)).toBe(true);

  await chmod(file, 0o600);
  expect(frontendInputsStillMatch(snapshot)).toBe(false);
});

test("failed resolution candidates invalidate when a file appears", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const candidate = join(dir, "dependency.ts");

  const tracker = new FrontendInputTracker();
  tracker.run(() => expect(trackedFileExists(candidate)).toBe(false));
  const snapshot = tracker.snapshot();
  expect(frontendInputsStillMatch(snapshot)).toBe(true);

  await writeFile(candidate, "export const loaded = true;\n");
  expect(frontendInputsStillMatch(snapshot)).toBe(false);
});

test("a candidate appearing during the frontend prevents cache publication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const candidate = join(dir, "dependency.ts");

  const tracker = new FrontendInputTracker();
  tracker.run(() => expect(trackedFileExists(candidate)).toBe(false));
  await writeFile(candidate, "export const loaded = true;\n");
  tracker.run(() => expect(trackedReadFile(candidate)).toContain("loaded"));

  const snapshot = tracker.snapshot();
  expect(snapshot.stable).toBe(false);
  expect(validFrontendInputSnapshot(snapshot)).toBe(false);
  expect(frontendInputsStillMatch(snapshot)).toBe(false);
});

test("an opaque host query can decline frontend cache publication", () => {
  const tracker = new FrontendInputTracker();
  tracker.run(() => markFrontendInputsUnstable());
  const snapshot = tracker.snapshot();
  expect(snapshot.stable).toBe(false);
  expect(validFrontendInputSnapshot(snapshot)).toBe(false);
});

test("directory enumeration invalidates workspace discovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const packages = join(dir, "packages");
  await mkdir(packages);

  const tracker = new FrontendInputTracker();
  tracker.run(() => expect(trackedAccessibleEntries(packages)?.directories).toEqual([]));
  const snapshot = tracker.snapshot();
  await mkdir(join(packages, "new-member"));
  expect(frontendInputsStillMatch(snapshot)).toBe(false);
});

test("compiler outputs do not invalidate a fresh output directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const generatedRoot = join(dir, "generated");
  const outDir = join(generatedRoot, "nested");
  const generated = join(outDir, "entry.lib.c");

  const tracker = new FrontendInputTracker();
  tracker.run(() => {
    expect(trackedAccessibleEntries(dir)?.directories).toEqual([]);
    expect(trackedDirectoryExists(generatedRoot)).toBe(false);
    expect(trackedDirectoryExists(outDir)).toBe(false);
    expect(trackedAccessibleEntries(outDir)).toBeNull();
  });
  const snapshot = tracker.snapshot();
  const exclusions = {
    outputPaths: [generated],
    outputDirectories: [dir, generatedRoot, outDir],
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(generated, "/* generated */\n");
  expect(frontendInputsStillMatch(snapshot, exclusions)).toBe(true);

  await writeFile(join(outDir, "new-source.ts"), "export const appeared = true;\n");
  expect(frontendInputsStillMatch(snapshot, exclusions)).toBe(false);
});

test("failed directory enumeration invalidates when the operation starts succeeding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const packages = join(dir, "packages");
  await writeFile(packages, "not a directory\n");

  const tracker = new FrontendInputTracker();
  tracker.run(() => expect(trackedAccessibleEntries(packages)).toBeNull());
  const snapshot = tracker.snapshot();
  expect(snapshot.probes).toContainEqual({ op: "entries-error", path: packages });
  expect(frontendInputsStillMatch(snapshot)).toBe(true);

  await rm(packages);
  await mkdir(packages);
  expect(frontendInputsStillMatch(snapshot)).toBe(false);
});

test("failed directory enumeration invalidates when access is restored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const packages = join(dir, "packages");
  await mkdir(packages);
  await writeFile(join(packages, "member.ts"), "export const member = true;\n");
  await chmod(packages, 0o000);

  try {
    const tracker = new FrontendInputTracker();
    const result = tracker.run(() => trackedAccessibleEntries(packages));
    if (result !== null) return; // Windows and privileged users may ignore POSIX mode bits.

    const snapshot = tracker.snapshot();
    expect(snapshot.probes).toContainEqual({ op: "entries-error", path: packages });
    expect(frontendInputsStillMatch(snapshot)).toBe(true);

    await chmod(packages, 0o700);
    expect(frontendInputsStillMatch(snapshot)).toBe(false);
  } finally {
    await chmod(packages, 0o700);
  }
});

test("synchronous tracking restores parents after throws and propagates unstable inputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const first = join(dir, "first.ts");
  const second = join(dir, "second.ts");
  await writeFile(first, "export const first = 1;");
  await writeFile(second, "export const second = 2;");
  const parent = new FrontendInputTracker();
  const child = new FrontendInputTracker();
  parent.runSynchronous(() => {
    expect(() => child.runSynchronous(() => {
      trackedReadFile(first);
      markFrontendInputsUnstable();
      throw new Error("interrupted");
    })).toThrow("interrupted");
    trackedReadFile(second);
  });
  expect(parent.snapshot().probes.filter((probe) => probe.op === "file").map((probe) => probe.path)).toEqual([first, second]);
  expect(parent.snapshot().stable).toBe(false);
  const before = parent.snapshot();
  trackedFileExists(join(dir, "outside.ts"));
  expect(parent.snapshot()).toEqual(before);
});
