import { everyModuleNode } from "../ir/traverse.js";
import type { LlvmUnsupportedError } from "./llvm/emitter.js";
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import { moduleUsesFetch, moduleEmbedsBuiltin, type IrModule, type SrcLoc } from "../ir/ir.js";

/** The LLVM backend's tier refusal as a diagnostic. SC3xxx = backend
 * coverage (the program is fine — this backend doesn't compile it yet);
 * the parenthesized kind tag is machine-readable for the differential
 * harness's histogram. */
export function llvmRefusalDiag(err: LlvmUnsupportedError, entryPath: string): ScrDiagnostic {
  return {
    code: "SC3001",
    message: err.message,
    loc: err.loc ?? { file: entryPath, start: 0, end: 0 },
  };
}

/** A valid program surface that the selected execution target cannot host.
 * SC3xxx stays the backend/target-coverage family: source semantics are
 * valid, but this target deliberately refuses them instead of emitting a
 * binary that traps later. */
export function targetRefusalDiag(target: string, surface: string, loc: SrcLoc): ScrDiagnostic {
  return {
    code: "SC3002",
    message: `${target} target does not support ${surface}`,
    loc,
  };
}

/** APIs that require host capabilities absent from portable WASI Preview 1.
 * These are target diagnostics, not backend-tier gaps: the same language IR
 * (including async, generators, and the dynamic island) is otherwise valid.
 * Keep the fine-grained walk first so diagnostics point at the API use; the
 * embedded-module checks are the entry-anchored safety net for island code. */
export function moduleWasiUnavailableSurface(mod: IrModule): { surface: string; loc: SrcLoc } | null {
  const entryLoc: SrcLoc = { file: mod.sourceFile, start: 0, end: 0 };
  const prefixes: readonly (readonly [string, string])[] = [
    ["cp.", "child processes (WASI Preview 1 has no process-spawning API)"],
    ["child.", "child processes (WASI Preview 1 has no process-spawning API)"],
    ["spawnRes.", "child processes (WASI Preview 1 has no process-spawning API)"],
    ["net.", "network sockets (WASI Preview 1 has no socket API)"],
    ["http.", "network sockets (WASI Preview 1 has no socket API)"],
    ["https.", "network sockets (WASI Preview 1 has no socket API)"],
    ["http2.", "network sockets (WASI Preview 1 has no socket API)"],
    ["h2.", "network sockets (WASI Preview 1 has no socket API)"],
    ["dgram.", "network sockets (WASI Preview 1 has no socket API)"],
    ["dns.", "network sockets (WASI Preview 1 has no socket API)"],
    ["tls.", "network sockets (WASI Preview 1 has no socket API)"],
    ["fetch.", "network-backed fetch (WASI Preview 1 has no socket API)"],
    ["fs.watch", "filesystem watching (WASI Preview 1 has no notification API)"],
    ["watcher.", "filesystem watching (WASI Preview 1 has no notification API)"],
  ];
  const kinds: ReadonlyMap<string, string> = new Map([
    ["child", "child processes (WASI Preview 1 has no process-spawning API)"],
    ["spawnRes", "child processes (WASI Preview 1 has no process-spawning API)"],
    ["childStream", "child processes (WASI Preview 1 has no process-spawning API)"],
    ["childWriter", "child processes (WASI Preview 1 has no process-spawning API)"],
    ["netServer", "network sockets (WASI Preview 1 has no socket API)"],
    ["netSocket", "network sockets (WASI Preview 1 has no socket API)"],
    ["http2Session", "network sockets (WASI Preview 1 has no socket API)"],
    ["http2Stream", "network sockets (WASI Preview 1 has no socket API)"],
    ["dgramSocket", "network sockets (WASI Preview 1 has no socket API)"],
    ["fsWatcher", "filesystem watching (WASI Preview 1 has no notification API)"],
    ["httpReq", "network sockets (WASI Preview 1 has no socket API)"],
    ["httpRes", "network sockets (WASI Preview 1 has no socket API)"],
    ["httpClientReq", "network sockets (WASI Preview 1 has no socket API)"],
    ["secureCtx", "network sockets (WASI Preview 1 has no socket API)"],
  ]);
  let found: { surface: string; loc: SrcLoc } | null = null;
  everyModuleNode(mod, {
    type: (node, loc) => {
      const surface = kinds.get(node.kind);
      if (surface === undefined) return true;
      found = { surface, loc };
      return false;
    },
    stmt: () => true,
    expr: (node) => {
      if (node.kind !== "libCall") return true;
      const loc = node.loc;
      if (node.fn === "process.kill" || node.fn === "process.killNum" ||
          node.fn === "process.onSignal" || node.fn === "process.offSignal") {
        found = { surface: "OS signals (WASI Preview 1 has no signal API)", loc };
        return false;
      }
      if (node.fn === "os.networkInterfaces") {
        found = { surface: "network-interface enumeration (WASI Preview 1 has no interface API)", loc };
        return false;
      }
      for (const [prefix, surface] of prefixes) {
        if (node.fn.startsWith(prefix)) {
          found = { surface, loc };
          return false;
        }
      }
      return true;
    },
  });
  if (found !== null) return found;

  if (moduleUsesFetch(mod)) {
    return { surface: "network-backed fetch (WASI Preview 1 has no socket API)", loc: entryLoc };
  }
  for (const builtin of ["node:http", "node:https", "node:net", "node:tls"]) {
    if (moduleEmbedsBuiltin(mod, builtin)) {
      return { surface: `${builtin} networking (WASI Preview 1 has no socket API)`, loc: entryLoc };
    }
  }
  return null;
}
