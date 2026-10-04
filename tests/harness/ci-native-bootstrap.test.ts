import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { load } from "js-yaml";
import { nativeBootstrapPlan, runBootstrapAndPackageChecks, runNativeBootstrapChecks } from "../../scripts/ci-native-bootstrap.mjs";

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test("CI partitions both bootstrap lanes without dropping or duplicating phase contracts", async () => {
  const workflow = load(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8")) as {
    jobs: {
      bootstrap: {
        strategy: { matrix: { flavor: string[]; phase: string[] } };
        env: Record<string, string>;
      };
      test: { needs: string[]; steps: { run: string }[] };
    };
  };
  const bootstrap = workflow.jobs.bootstrap;
  expect(bootstrap.env.SCRIPTC_BOOTSTRAP_PHASE).toBe("${{ matrix.phase }}");
  expect(bootstrap.env.SCRIPTC_SAN).toBe("${{ matrix.flavor == 'san' && '1' || '' }}");
  expect(bootstrap.strategy.matrix.flavor.toSorted()).toEqual(["plain", "san"]);
  for (const flavor of bootstrap.strategy.matrix.flavor) {
    const completed: string[] = [];
    let packageOwners = 0;
    for (const phase of bootstrap.strategy.matrix.phase) {
      const plan = nativeBootstrapPlan({ phase, sanitize: flavor === "san" });
      // Each CI job must own one expensive phase on its own runner.
      expect(plan.phases).toHaveLength(1);
      if (plan.packageChecks) packageOwners++;
      await runNativeBootstrapChecks(plan, {
        commands: async () => { completed.push("commands"); },
        rebuild: async () => { completed.push("rebuild"); },
      });
    }
    expect(completed.toSorted()).toEqual(["commands", "rebuild"]);
    expect(packageOwners).toBe(flavor === "plain" ? 1 : 0);
  }
  expect(workflow.jobs.test.needs).toContain("bootstrap");
  expect(workflow.jobs.test.steps.some((step) => step.run.includes('test "${{ needs.bootstrap.result }}" = success'))).toBe(true);
});

test("direct bootstrap invocations retain both phases and the plain package checks", async () => {
  for (const sanitize of [false, true]) {
    const plan = nativeBootstrapPlan({ sanitize });
    const commands = latch();
    const rebuild = latch();
    const completed: string[] = [];
    await runNativeBootstrapChecks(plan, {
      commands: async () => { commands.release(); await rebuild.promise; completed.push("commands"); },
      rebuild: async () => { rebuild.release(); await commands.promise; completed.push("rebuild"); },
    });
    expect(completed.toSorted()).toEqual(["commands", "rebuild"]);
    expect(plan.packageChecks).toBe(!sanitize);
  }
});

test("bootstrap phase failures drain their siblings and preserve both errors", async () => {
  const completed = latch();
  const commandFailure = new Error("command probe failed");
  const rebuildFailure = new Error("self rebuild failed");
  let rebuilt = false;
  const result = runNativeBootstrapChecks(nativeBootstrapPlan(), {
    commands: () => { completed.release(); throw commandFailure; },
    rebuild: async () => { await completed.promise; rebuilt = true; throw rebuildFailure; },
  });
  await expect(result).rejects.toMatchObject({ errors: [commandFailure, rebuildFailure] });
  expect(rebuilt).toBe(true);
});

test("invalid bootstrap phase selection fails before any contracts can be skipped", () => {
  for (const phase of ["", "command", "seed", "commands,rebuild", " all "]) {
    expect(() => nativeBootstrapPlan({ phase })).toThrow("SCRIPTC_BOOTSTRAP_PHASE must be all, commands, or rebuild");
  }
});

test("a missing phase callback fails instead of silently passing its contracts", async () => {
  await expect(runNativeBootstrapChecks(nativeBootstrapPlan({ phase: "rebuild" }), {
    commands: async () => {},
  })).rejects.toMatchObject({ errors: [expect.any(TypeError)] });
});

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
