import { expect, test } from "vitest";
import { runBootstrapAndPackageChecks } from "../../scripts/ci-native-bootstrap.mjs";

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test("package checks wait for publication and overlap the running bootstrap", async () => {
  const published = latch();
  const checked = latch();
  let ready = false;
  const events: string[] = [];
  await runBootstrapAndPackageChecks({
    bootstrap: async () => {
      events.push("building seed");
      expect(events).toEqual(["building seed"]);
      ready = true;
      published.release();
      await checked.promise;
      events.push("bootstrap complete");
    },
    packageReady: () => ready,
    poll: () => published.promise,
    packageChecks: async () => { events.push("checking package"); checked.release(); },
  });
  expect(events).toEqual(["building seed", "checking package", "bootstrap complete"]);
});

test("a bootstrap failure before publication ends the package wait", async () => {
  const failure = new Error("seed failed");
  await expect(runBootstrapAndPackageChecks({
    bootstrap: async () => { throw failure; },
    packageReady: () => false,
    poll: () => Promise.resolve(),
    packageChecks: async () => { throw new Error("package checks must not start"); },
  })).rejects.toMatchObject({ errors: [failure, expect.objectContaining({ message: expect.stringContaining("before its native package was ready") })] });
});

test("package failures drain the running bootstrap and preserve both errors", async () => {
  const checked = latch();
  const seedFailure = new Error("self rebuild failed");
  const packageFailure = new Error("installation failed");
  let finished = false;
  await expect(runBootstrapAndPackageChecks({
    bootstrap: async () => { await checked.promise; finished = true; throw seedFailure; },
    packageReady: () => true,
    packageChecks: async () => { checked.release(); throw packageFailure; },
  })).rejects.toMatchObject({ errors: [seedFailure, packageFailure] });
  expect(finished).toBe(true);
});
