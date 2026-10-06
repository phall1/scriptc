import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { builtinImportOf } from "./module-bindings.js";

export function isConsoleLog(lowerer: Lowerer, call: ts.CallExpression): boolean {
  return consoleCallMember(lowerer, call) === "log";
}

/** The console member of a `console.<member>(...)` call, for the lowered
 * set: "log"/"info"/"debug" (stdout — Node's info and debug ARE log
 * under other names), and "error"/"warn" (both stderr — Node's warn IS
 * error under another name; the output is identical). Provenance-checked
 * like every stdlib global. Null for anything else (console.table, a
 * user's own console binding, ...). */
export function consoleCallMember(
  lowerer: Lowerer,
  call: ts.CallExpression,
): "log" | "info" | "debug" | "error" | "warn" | null {
  if (call.questionDotToken) return null;
  if (ts.isIdentifier(call.expression)) {
    const imported = builtinImportOf(lowerer, call.expression);
    return imported?.module === "console" && isConsoleOutputMember(imported.member)
      ? imported.member
      : null;
  }
  if (!ts.isPropertyAccessExpression(call.expression)) return null;
  const access = call.expression;
  if (access.questionDotToken || call.questionDotToken) return null;
  const name = access.name.text;
  if (!isConsoleOutputMember(name)) return null;
  return lowerer.isStdlibGlobal(access.expression, "console") ||
    lowerer.builtinNamespaceModuleOf(access.expression) === "console"
    ? name
    : null;
}

function isConsoleOutputMember(name: string): name is "log" | "info" | "debug" | "error" | "warn" {
  return (
    name === "log" || name === "info" || name === "debug" || name === "error" || name === "warn"
  );
}
