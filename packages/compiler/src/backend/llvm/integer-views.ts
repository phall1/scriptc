import type { IrExpr, IrFunction, IrStmt } from "../../ir/ir.js";
import { everyExprChild, everyStmtChild } from "../../ir/traverse.js";
import { byteNumberAccess } from "../../ir/byte-numbers.js";

/** Keep a computed ToUint32 view beside an ordinary number when integer
 * consumers in loops can reuse it. The number remains authoritative for floating
 * arithmetic, signed zero, returns and zero-iteration loops. Only explicit
 * local stores maintain these views; captures and implicit binders stay on
 * the ordinary path. No range or integer assumption is made about inputs. */
export function findIntegerViews(fn: IrFunction): Set<string> {
  const wanted = new Set<string>();
  if (fn.async || fn.generator) return wanted;
  const initialized = new Set(fn.params.map((p) => p.localId));
  const excluded = new Set([...(fn.captures ?? []), ...(fn.classCaptures ?? [])].map((c) => c.localId));
  let loopDepth = 0;
  const operand = (expr: IrExpr): void => {
    if (loopDepth > 0 && expr.kind === "varRef" && expr.type.kind === "f64") wanted.add(expr.localId);
  };
  const expr = (node: IrExpr): boolean => {
    if (node.kind === "bin" && (node.op === "&" || node.op === "|" || node.op === "^" ||
        node.op === "<<" || node.op === ">>" || node.op === ">>>")) {
      operand(node.left);
      operand(node.right);
    } else if (node.kind === "unary" && node.op === "~") operand(node.operand);
    else if (node.kind === "libCall" && (node.fn === "math.imul" || node.fn === "math.clz32")) {
      for (const arg of node.args) operand(arg);
    } else if (node.kind === "bytesIntrinsic") {
      const numeric = byteNumberAccess(node);
      if (numeric?.write && !numeric.floating && numeric.width <= 4) operand(node.args[numeric.valueArg]!);
    }
    return everyExprChild(node, expr, stmt);
  };
  const stmt = (node: IrStmt): boolean => {
    const loop = node.kind === "for" || node.kind === "forOf" || node.kind === "while" || node.kind === "doWhile";
    if (loop) loopDepth++;
    if (node.kind === "varDecl") initialized.add(node.localId);
    if (node.kind === "forOf") excluded.add(node.localId);
    // Canonical induction is maintained separately by the loop emitter.
    if (node.kind === "for" && node.init?.kind === "varDecl") excluded.add(node.init.localId);
    if (node.kind === "bytesSet" && node.arr.type.kind === "bytes" &&
        node.arr.type.elem !== "f32" && node.arr.type.elem !== "f64" && node.arr.type.elem !== "u8c") operand(node.value);
    const result = everyStmtChild(node, expr, stmt);
    if (loop) loopDepth--;
    return result;
  };
  // A conversion observed only after a floating loop must not add work to
  // each iteration. Expression results still carry their existing views.
  fn.body.every(stmt);
  const eligible = new Set(fn.locals.filter((local) => local.type.kind === "f64" &&
    !local.boxed && !local.tdz && initialized.has(local.id) && !excluded.has(local.id)).map((local) => local.id));
  for (const id of wanted) if (!eligible.has(id)) wanted.delete(id);
  return wanted;
}
