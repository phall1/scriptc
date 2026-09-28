import vm from "node:vm";
import ts5 from "typescript5";

/** The Node client's compile-time evaluator. Only source text and the
 * resulting value cross this boundary; TS5 ASTs never enter the frontend.
 * Every invocation gets fresh globals and a bounded execution window. */
export function evaluateNodeComptime(source: string, timeoutMs: number): unknown {
  const js = ts5.transpileModule(`(${source})()`, {
    compilerOptions: { target: ts5.ScriptTarget.ESNext },
  }).outputText;
  // Shadow V8's otherwise silent per-context console. The capture walk
  // rejects direct console references before evaluation.
  return vm.runInNewContext(js, { console: undefined }, { timeout: timeoutMs });
}
