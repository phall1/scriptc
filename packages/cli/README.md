# scriptc

Compile ordinary TypeScript and JavaScript to small, fast native executables or WASI WebAssembly modules — no Node, no V8, no JavaScript engine in the artifact.

```console
$ cat fib.ts
function fib(n: number): number {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}
console.log(fib(30));

$ scriptc run fib.ts
832040

$ scriptc build fib.ts -o fib && ./fib
832040
```

## Install

```console
$ npm install -g scriptc
```

Requires Node.js 24. Executable builds require a platform linker driver and SDK/sysroot. On supported macOS, Linux, and Windows hosts, LLVM executables use the matching optional helper and precompiled runtime pack, so the driver only links; select that driver with `SCRIPTC_LINKER`. Runtime development with `--sanitize` additionally needs a C compiler. `--emit=ir|llvm` requires only Node, while `--emit=asm|obj` requires neither an external compiler nor a linker.

Builds use a bounded persistent cache. Unchanged source can reuse the validated frontend result and LLVM program objects. Library identity getters occupy a separate LLVM module, so an identity change can reuse the large program object. Runtime objects come from the installed pack. Executable cache entries verify their native dependencies; FFI builds relink against current external inputs. Set `SCRIPTC_NO_CACHE=1` to bypass the cache or `SCRIPTC_CACHE_DIR` to select its location. An existing POSIX override must already be private.

## Commands

- `scriptc build <file.ts>` — compile to a native executable or selected target artifact
- `scriptc run <file.ts>` — compile and run
- `scriptc coverage <file.ts>` — what compiles statically, and why the rest doesn't

`scriptc build app.ts --emit=ir|llvm|asm|obj` selects serialized typed IR, textual LLVM IR, target assembly, or a relocatable program object as the one primary artifact. `--emit=exe` is the default. Assembly/object emission uses the matching helper on supported macOS, Linux, and Windows hosts (and produces WASI artifacts when that target is selected). Objects retain undefined `scr_*` runtime references plus the `scr_runtime_abi_v4` compatibility marker; they are not library archives. External consumption is experimental and requires the exact matching runtime. `scriptc build app.ts --print=native-link-info -o app.o` prints the versioned JSON target/runtime/link recipe without performing a link. `--emit=asm|obj --sanitize` is rejected until ASan pipeline parity is available.

For embedder-hosted modules that are not installed npm packages, coverage can map an exact bare specifier to a local declaration with repeatable `--external-types <specifier=file.d.ts>` options. This is analysis-only: the types unblock application measurement, while runtime module uses remain reported as blockers.

No annotations, no dialect, no special stdlib: the same TypeScript you run on Node, type-checked by the real TypeScript compiler. Programs outside the static tier can opt into `--dynamic`, which embeds a small JavaScript engine (~620KB) for the parts that can't be static; everything else fails the build with a specific error code and usually a rewrite hint.

WebAssembly is available as a production LLVM target: `SCRIPTC_TARGET=wasm32-wasi scriptc build app.ts`. It emits a WASI Preview 1 `.wasm` module, and `scriptc run` supplies a WASI host. The complete executable language tier—including async, generators, timers, and `--dynamic`—is supported. APIs needing capabilities WASI P1 does not expose (network sockets/fetch, child processes, OS signals, and filesystem watching), sanitizer builds, native FFI, and library-mode archive builds are rejected with `SC3002`.

Native code can be called through an explicit, link-time C ABI manifest: declare the function signature in TypeScript, bind it to a C symbol, and build with `--ffi <manifest.json>`. See the [Native FFI guide](https://scriptc.dev/ffi).

Docs: [scriptc.dev](https://scriptc.dev)
