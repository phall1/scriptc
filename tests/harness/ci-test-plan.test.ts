import { expect, test } from "vitest";
import {
  ciTestPlan,
  corpusFiles,
  effectFiles,
  fileExclusions,
} from "../../scripts/ci-test-plan.mjs";
import { runCiTestPlan } from "../../scripts/ci-test.mjs";

test.for([1, 3, 5, 10])(
  "CI retains every suite with %i shards without mixing partition axes",
  (count) => {
    for (const flavor of ["plain", "san"]) {
      const plans = Array.from({ length: count }, (_, index) =>
        ciTestPlan({ shard: `${index + 1}/${count}`, flavor }),
      );
      const sideFiles = plans.flatMap((plan) =>
        plan.side.filter((task) => task.args.length === 2).map((task) => task.args[1]),
      );
      for (const file of fileExclusions.filter(
        (file) =>
          !corpusFiles.includes(file) &&
          !effectFiles.includes(file) &&
          !file.includes("native-driver") &&
          !file.includes("coverage") &&
          !file.includes("native-toolchain"),
      )) {
        expect(
          sideFiles.filter((selected) => selected === file),
          file,
        ).toHaveLength(1);
      }
      for (const plan of plans) {
        expect(plan.corpus.args).toEqual(["test", ...corpusFiles]);
        expect(plan.side[0]!.args).toContain(`--shard=${plan.corpus.env.SCRIPTC_TEST_SHARD}`);
        for (const file of fileExclusions)
          expect(plan.side[0]!.args).toContain(`--exclude=${file}`);
        const cache = plan.side.find((task) => task.name === "native-cache correctness");
        expect(Boolean(cache)).toBe(flavor === "plain");
        if (cache) {
          expect(cache.env.SCRIPTC_CACHE_TEST_SHARD).toBe(plan.corpus.env.SCRIPTC_TEST_SHARD);
          expect(cache.env.SCRIPTC_TEST_STABLE_TOOLCHAIN).toBe("0");
        }
        expect(plan.side.some((task) => task.name === "coverage sweep")).toBe(flavor === "plain");
      }
    }
  },
);

test.for([1, 2, 4, 8])(
  "CI overlaps reserved lanes within a budget of %i workers",
  async (workers) => {
    const plan = ciTestPlan({ shard: "1/10", flavor: "plain", workers });
    const events: string[] = [];
    let active = 0;
    let peak = 0;
    let finishCorpus!: () => void;
    const corpusWait = new Promise<void>((resolve) => {
      finishCorpus = resolve;
    });
    await runCiTestPlan(plan, async (task) => {
      const cost = Number(task.env.SCRIPTC_TEST_WORKERS);
      active += cost;
      peak = Math.max(peak, active);
      events.push(`start:${task.name}`);
      if (task === plan.corpus && workers > 1) await corpusWait;
      else await Promise.resolve();
      events.push(`end:${task.name}`);
      active -= cost;
      if (task === plan.side.at(-1)) finishCorpus();
    });
    expect(peak).toBeLessThanOrEqual(workers);
    expect(events.filter((event) => event.startsWith("start:")).sort()).toEqual(
      [plan.corpus, ...plan.side].map((task) => `start:${task.name}`).sort(),
    );
    for (let index = 1; index < plan.side.length; index++) {
      expect(events.indexOf(`start:${plan.side[index]!.name}`)).toBeGreaterThan(
        events.indexOf(`end:${plan.side[index - 1]!.name}`),
      );
    }
    if (workers === 1)
      expect(events.indexOf(`start:${plan.side[0]!.name}`)).toBeGreaterThan(
        events.indexOf(`end:${plan.corpus.name}`),
      );
    else
      expect(events.indexOf(`start:${plan.side[0]!.name}`)).toBeLessThan(
        events.indexOf(`end:${plan.corpus.name}`),
      );
  },
);

test("CI reports failures after running every scheduled suite", async () => {
  const plan = ciTestPlan({ shard: "1/10", flavor: "plain" });
  const seen: string[] = [];
  let failure: AggregateError | undefined;
  try {
    await runCiTestPlan(plan, async (task) => {
      seen.push(task.name);
      if (task === plan.corpus || task === plan.side[0]) throw new Error(task.name);
    });
  } catch (error) {
    failure = error as AggregateError;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure!.errors).toHaveLength(2);
  expect(seen.sort()).toEqual([plan.corpus, ...plan.side].map((task) => task.name).sort());
});

test("CI rejects malformed scheduling inputs", () => {
  for (const shard of [undefined, "", "0/10", "11/10", "2/x"])
    expect(() => ciTestPlan({ shard, flavor: "plain" })).toThrow();
  for (const workers of [0, -1, 1.5, NaN, Infinity])
    expect(() => ciTestPlan({ shard: "1/10", flavor: "plain", workers })).toThrow();
  expect(() => ciTestPlan({ shard: "1/10", flavor: "unknown" })).toThrow();
});
