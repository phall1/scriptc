import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { contentDigest, NativeCache, openNativeCache } from "./cache.js";

const directories: string[] = [];
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "scriptc-native-cache-test-"));
  directories.push(path);
  return path;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("cache hits require an intact payload and digest", () => {
  const cache = new NativeCache(directory());
  const key = contentDigest("program identity");
  const content = Buffer.from([0, 10, 128, 255]);
  cache.write("object", key, content);
  expect(cache.read("object", key)).toEqual(content);
  const path = join(cache.root, "object", key);
  writeFileSync(path, Buffer.from([0, 10, 128, 254]));
  expect(cache.read("object", key)).toBeNull();
  cache.write("object", key, content);
  rmSync(path + ".sha256");
  expect(cache.read("object", key)).toBeNull();
});

test("a failed cache publication does not fail the build or replace unrelated files", () => {
  const cache = new NativeCache(directory());
  const occupied = join(cache.root, "object");
  writeFileSync(occupied, "keep");
  expect(() => cache.write("object", contentDigest("key"), "payload")).not.toThrow();
  expect(readFileSync(occupied, "utf8")).toBe("keep");
});

test("eviction removes oldest complete entries and leaves unrelated paths alone", () => {
  const cache = new NativeCache(directory());
  const oldKey = contentDigest("old");
  const newKey = contentDigest("new");
  cache.write("frontend", oldKey, "a".repeat(700));
  cache.write("object", newKey, "b".repeat(700));
  utimesSync(join(cache.root, "frontend", oldKey), new Date(0), new Date(0));
  const unrelated = join(cache.root, "object", "unrelated");
  writeFileSync(unrelated, "keep");
  vi.stubEnv("SCRIPTC_CACHE_MAX_MB", String(1000 / (1024 * 1024)));
  cache.prune();
  expect(cache.read("frontend", oldKey)).toBeNull();
  expect(cache.read("object", newKey)?.length).toBe(700);
  expect(readFileSync(unrelated, "utf8")).toBe("keep");
});

test("private-directory admission and cache disable options fail closed", () => {
  vi.stubEnv("SCRIPTC_NO_CACHE", "0");
  vi.stubEnv("SCRIPTC_CACHE_DIR", directory());
  const inspect = vi.fn(() => false);
  expect(openNativeCache(inspect)).toBeNull();
  expect(inspect).toHaveBeenCalledWith(process.env["SCRIPTC_CACHE_DIR"], false);
  const rootOnly = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
  expect(openNativeCache(rootOnly)).toBeNull();
  expect(openNativeCache(() => true)).toBeInstanceOf(NativeCache);
  vi.stubEnv("SCRIPTC_NO_CACHE", "1");
  const disabled = vi.fn(() => true);
  expect(openNativeCache(disabled)).toBeNull();
  expect(disabled).not.toHaveBeenCalled();
});
