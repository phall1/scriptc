import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { F64, type IrExpr, type SrcLoc, STRING, VOID } from "../../../ir/ir.js";
import { READLINE_DOCUMENTED_OPTIONS, fenceOrDropOptionKey } from "../surfaces.js";

/** True when `node`'s checker type is readline's Interface (stdlib
 * provenance + the enclosing "readline" ambient module — the name alone
 * is too generic). The interface maps to an f64 handle, so the IR type
 * cannot discriminate it from a plain number. */
function isReadlineTyped(lowerer: Lowerer, node: ts.Expression): boolean {
  const t = lowerer.checker.getTypeAtLocation(node);
  const sym = t.getAliasSymbol() ?? t.getSymbol();
  if (sym?.name !== "Interface") return false;
  return lowerer.checker.declarationsOf(sym).some((d) => {
    if (!ts.isClassDeclaration(d) && !ts.isInterfaceDeclaration(d)) return false;
    if (!lowerer.isStdlibFile(d.getSourceFile())) return false;
    let up: ts.Node | undefined = d.parent;
    while (up) {
      if (ts.isModuleDeclaration(up) && ts.isStringLiteral(up.name)) {
        return up.name.text === "readline" || up.name.text === "node:readline";
      }
      up = up.parent;
    }
    return false;
  });
}

/** Method calls on readline Interface receivers: `rl.question(query, cb)`
 * writes the query to stdout and delivers the next stdin line's text to
 * the callback (one (answer: string) parameter, or none); `rl.close()`
 * fires the 'close' listeners synchronously (Node's inline emit) and
 * releases the loop; `rl.on("close", cb)` registers a zero-arg
 * listener. Everything else the lib declares (on("line"), prompt,
 * setPrompt, ...) fences member-qualified. Null for non-Interface
 * receivers. */
export function lowerReadlineMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (!isReadlineTyped(lowerer, access.expression)) return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  if (name === "question" && call.arguments.length === 2) {
    const receiver = lowerer.lowerExprExpecting(access.expression, F64);
    const query = lowerer.lowerExprExpecting(call.arguments[0]!, STRING);
    const cb = lowerer.lowerExpr(call.arguments[1]!);
    if (cb.type.kind !== "func" || cb.type.ret.kind !== "void" || cb.type.params.length > 1) {
      lowerer.unsupported(
        "SC1090",
        call.arguments[1]!,
        "question callbacks with more than one parameter or a return value",
      );
    }
    const param = cb.type.params[0];
    if (param !== undefined && param.kind !== "string") {
      lowerer.unsupported(
        "SC1090",
        call.arguments[1]!,
        `question callbacks whose parameter is not 'string' (got '${lowerer.fmt(param)}')`,
      );
    }
    return { kind: "libCall", fn: "rl.question", args: [receiver, query, cb], type: VOID, loc };
  }
  if (name === "close" && call.arguments.length === 0) {
    const receiver = lowerer.lowerExprExpecting(access.expression, F64);
    return { kind: "libCall", fn: "rl.close", args: [receiver], type: VOID, loc };
  }
  if (name === "on" && call.arguments.length === 2) {
    const evT = lowerer.typeOf(call.arguments[0]!);
    const event = evT.isStringLiteralType() ? evT.value : null;
    if (event !== "close") {
      lowerer.noLowering(
        `readline.Interface.on(${event === null ? "non-literal event" : `"${event}"`}, ...)`,
        call.arguments[0]!,
        '"close" is the supported readline event (question(query, cb) is the line consumer)',
      );
    }
    if (!ts.isExpressionStatement(call.parent)) {
      lowerer.unsupported(
        "SC1090",
        call,
        "chaining readline listener registration (the result is void here — register each listener as its own statement)",
      );
    }
    const receiver = lowerer.lowerExprExpecting(access.expression, F64);
    const cb = lowerer.lowerExpr(call.arguments[1]!);
    if (cb.type.kind !== "func" || cb.type.ret.kind !== "void" || cb.type.params.length > 0) {
      lowerer.unsupported(
        "SC1090",
        call.arguments[1]!,
        "close listeners with parameters or a return value (use ())",
      );
    }
    return { kind: "libCall", fn: "rl.onClose", args: [receiver, cb], type: VOID, loc };
  }
  lowerer.noLowering(
    `readline.Interface.${name}`,
    call,
    'question(query, cb), close(), and on("close", cb) are the supported Interface members',
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

// readline.createInterface({ input: process.stdin, output:
// process.stdout }): exactly that options shape — the runtime reads
// fd 0 and writes prompts to stdout, so any OTHER stream would be a
// lie. `terminal` is accepted only as the literal false (the pipe
// behavior this implements); other members fence by name.
export function lowerReadlineCreateCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
): IrExpr {
  const optsNode = expr.arguments.length === 1 ? expr.arguments[0] : undefined;
  if (!optsNode || !ts.isObjectLiteralExpression(optsNode)) {
    lowerer.noLowering(
      "createInterface with this argument shape",
      expr,
      "the supported form is createInterface({ input: process.stdin, output: process.stdout })",
    );
  }
  let sawInput = false;
  for (const p of optsNode.properties) {
    if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) {
      lowerer.noLowering(
        "createInterface with this options shape",
        p,
        "spreads, computed keys, and shorthand options have no lowering — write each member inline",
      );
    }
    const member = p.name.text;
    const streamOf = (node: ts.Expression): string | null =>
      ts.isPropertyAccessExpression(node) ? lowerer.stdlibGlobalMember(node, "process") : null;
    if (member === "input") {
      if (streamOf(p.initializer) !== "stdin") {
        lowerer.noLowering(
          "createInterface with a non-stdin input",
          p.initializer,
          "process.stdin is the one supported input stream",
        );
      }
      sawInput = true;
    } else if (member === "output") {
      if (streamOf(p.initializer) !== "stdout") {
        lowerer.noLowering(
          "createInterface with a non-stdout output",
          p.initializer,
          "process.stdout is the one supported output stream",
        );
      }
    } else if (member === "terminal") {
      const t = lowerer.typeOf(p.initializer);
      if (!(t.flags & ts.TypeFlags.BooleanLiteral) || lowerer.checker.typeToString(t) !== "false") {
        lowerer.noLowering(
          "createInterface with terminal enabled",
          p.initializer,
          "terminal line editing has no lowering — the pipe behavior is what compiles",
        );
      }
    } else if (member === "crlfDelay") {
      // Infinity states the lowered behavior: the splitter holds a
      // trailing \r until the next chunk decides \r\n vs \r, with no
      // time limit (scr_readline.c) — Node's crlfDelay: Infinity.
      // Finite delays would need a timer the splitter does not have.
      if (!ts.isIdentifier(p.initializer) || p.initializer.text !== "Infinity") {
        lowerer.noLowering(
          "createInterface with a finite crlfDelay",
          p.initializer,
          "the lowered splitter always joins \\r\\n across chunks (Node's crlfDelay: Infinity) — Infinity is the accepted value",
        );
      }
    } else if (member === "completer") {
      lowerer.noLowering(
        "createInterface with a completer",
        p,
        "tab completion needs an interactive terminal — the lowered interface reads piped lines (terminal: false)",
      );
    } else {
      fenceOrDropOptionKey(
        lowerer,
        p,
        member,
        "createInterface",
        READLINE_DOCUMENTED_OPTIONS,
        "input, output, terminal: false, and crlfDelay: Infinity are the supported options",
      );
      // An undocumented key, dropped like Node drops it.
    }
  }
  if (!sawInput) {
    lowerer.noLowering(
      "createInterface without an input stream",
      optsNode,
      "pass { input: process.stdin, output: process.stdout }",
    );
  }
  return { kind: "libCall", fn: "rl.create", args: [], type: F64, loc };
}
