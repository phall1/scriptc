# effect-scriptc-compat pin for scriptc 0.3.0 and Effect 4.0.4

These files are the harness diff against `phall1/effect-scriptc-compat` commit `9b46de22a823ce20978140919d870d31833e34c4`. Pushing branch `effect-4.0.4-scriptc-0.3` (commit `3d2df354d6311b1fca27c6b064022ecdf58c46f2`) to that repository returned HTTP 403 for `cursor[bot]`, so the patch lives here.

Apply it onto a checkout of that commit:

```sh
git clone https://github.com/phall1/effect-scriptc-compat.git
cd effect-scriptc-compat
git checkout 9b46de22a823ce20978140919d870d31833e34c4
cp -R /path/to/scriptc/harness/effect-scriptc-compat/. .
```

`APPLY.md` is not part of the harness. The copied `README.md`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `toolchain.json`, `scripts/generate.ts`, `scripts/map.ts`, `tests/integration.test.ts`, `docs/github-actions-shards.md`, and `cases/additional-cases.json`, `cases/namespace-cases.json`, and `cases/manifest.json` are.

The five observability fixtures whose Node stdout gained Effect 4.0.4 `telemetry.sdk.*` resource attributes are updated in those catalogs: `module-observability--otlp`, `module-observability--otlplogger`, `module-observability--otlpmetrics`, `namespace-observability`, and `namespace-observability-otlpresource`. The native binaries already matched Node; the checked-in `expectedStdout` strings were the drift.

The pin expects a scriptc executable that prints `0.3.0`. Point `SCRIPTC` at a build of `phall1/scriptc` branch `effect-compat-0.3`. Effect is `4.0.4`. scriptc 0.3 is native-only: when `scriptc build --dynamic` reports an unknown option, the map does not retry.
