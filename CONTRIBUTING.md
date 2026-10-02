# Contributing to scriptc

## Setup

Use the Node.js version in [.node-version](./.node-version) and install pnpm. From the repository root, install dependencies and build the workspace:

```console
$ pnpm install && pnpm -r build
```

The workspace build compiles the TypeScript packages and checks the compatibility inventory. It does not rebuild packaged native artifacts and needs no local LLVM installation.

## Tests

The test corpus runs each program under Node.js and as a compiled native binary, then compares stdout, stderr, and exit codes byte-for-byte. Run focused tests while developing; use `pnpm test:sandbox` for the full validation gate. Both the plain and sanitized lanes must pass. The sanitized lane enables AddressSanitizer and the runtime reference-count audit.

The Sandbox gate loads configuration from the shell and `.env.local`, checks Vercel authentication and project access, and uploads the working tree to disposable Linux Sandboxes. On macOS, it also runs the Darwin-native contracts locally; Linux hosts run their supported native-clang contracts locally.

### Sandbox authentication

`VERCEL_OIDC_TOKEN` is preferred. To load a project-scoped token, link the checkout to its Vercel project with `vercel link`, then run `vercel env pull`. For access-token authentication, set `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID`.

By default, the gate uses `vercel/sandbox/universal` and installs the repository-pinned Node.js, pnpm, LLVM, and workspace dependencies. To use an optional prebuilt image, build it with `pnpm test:sandbox:image` and set `SCRIPTC_SANDBOX_IMAGE` to its fully qualified VCR reference. Team and project selection never come from the image reference.

The legacy VCR command used by `pnpm test:sandbox:image` requires `VERCEL_TOKEN` or an existing Vercel CLI login for authentication. OIDC claims can still provide its team and project scope.

### Local fallback

When Vercel Sandbox credentials are unavailable, run `SCRIPTC_TEST_WORKERS=4 pnpm test`, then `SCRIPTC_TEST_WORKERS=4 SCRIPTC_SAN=1 pnpm test`. The worker limit avoids oversubscribing the host. Full local suites queue behind an advisory lock per lane.

See the [test harness guide](./tests/harness/README.md) for focused checks, platform lanes, and test caches.

## Native artifacts

When changing native assembly or object emission, runtime-pack selection, or the C runtime, rebuild the relevant native artifacts explicitly. Install CMake, Ninja, the pinned LLVM 22 development package, and Zig 0.16.0 on the target host. Run the matching `@scriptc/llvm-<platform>` and `@scriptc/runtime-<platform>` packages' `build:native` scripts. The macOS full test suite also needs those generated artifacts.

## Documentation

The docs site is a standalone pnpm workspace under `docs/`. Install its dependencies with `pnpm --dir docs install` and start it with `pnpm --dir docs dev`. Reuse an existing dev server when one is running.

Content lives in `docs/content/docs`. Keep shared layout and runtime behavior in `@vercel/geistdocs`; local adapters belong under `docs/src`. Follow the authoring conventions in [AGENTS.md](./AGENTS.md).

Before landing docs or compatibility output changes, run `NEXT_DIST_DIR=.next-check pnpm --dir docs check`. The separate output directory keeps the production build from corrupting a running dev server's `.next` state. This gate checks compatibility drift, TypeScript, the production build, and HTTP routes.

## Releases

Releases are maintainer-run. See [RELEASING.md](./RELEASING.md).
