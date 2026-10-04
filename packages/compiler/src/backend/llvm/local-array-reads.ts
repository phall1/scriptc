import { isRefCounted, typeEquals, type IrExpr, type IrFunction, type IrStmt, type IrType, type IrUnionDef } from "../../ir/ir.js";
import { everyExprChild, everyStmtChild, everyStmtList } from "../../ir/traverse.js";
import type { LlvmEmitterContext } from "./expr-context.js";
import { isStableReceiverOperand } from "../../ir/analysis.js";

export interface LocalArrayRead {
  array: IrExpr;
  index: IrExpr;
  element: IrType;
  presentTag: number;
  missingTag: number;
  borrow?: boolean;
}

/** With no reference writes, user calls, callbacks or suspension, an
 * unboxed array parameter owns all its elements throughout the function.
 * Scalar field writes are allowed: they cannot remove an array edge. */
function preservesArrayElements(fn: IrFunction, functions: ReadonlyMap<string, IrFunction>, unions: ReadonlyMap<string, IrUnionDef>): boolean {
  return everyStmtList(fn.body, {
    expr: (e) => {
      switch (e.kind) {
        case "numLit": case "boolLit": case "strLit": case "varRef": case "bin": case "unary": case "incDec":
        case "toBool": case "logical": case "ternary": case "seqExpr": case "fieldGet": case "recordGet":
        case "unionNarrow": case "unionIsTag": return true;
        case "libCall": return e.fn === "error.nodeThrow" || isStableReceiverOperand(e, "");
        case "call": return optionalArrayRead(e, functions, unions) !== null;
        case "arrIntrinsic": return e.method === "length";
        default: return false;
      }
    },
    stmt: (s) => {
      switch (s.kind) {
        case "varDecl": case "exprStmt": case "return": case "if": case "for": case "while": case "doWhile":
        case "block": case "break": case "continue": return true;
        case "assign": case "fieldSet": case "recordSet": return !isRefCounted(s.value.type);
        default: return false;
      }
    },
  });
}

/** Recognize the complete optional-array-read body, not the helper's name.
 * Both operands will be evaluated once, in call argument order. */
function optionalArrayRead(call: IrExpr, functions: ReadonlyMap<string, IrFunction>, unions: ReadonlyMap<string, IrUnionDef>): LocalArrayRead | null {
  if (call.kind !== "call" || call.args.length !== 2 || call.type.kind !== "union") return null;
  const fn = functions.get(call.callee);
  if (!fn || fn.async || fn.generator || fn.captures || fn.classCaptures || fn.params.length !== 2 || fn.body.length !== 1 ||
      fn.locals.length !== 2 || fn.locals.some((l) => l.boxed || l.tdz)) return null;
  const [array, index] = fn.params;
  if (array!.type.kind !== "array" || index!.type.kind !== "f64") return null;
  const element = array!.type.elem;
  const arms = unions.get(call.type.unionId)?.arms;
  if (!isRefCounted(element) || element.kind === "union" || !arms || arms.length !== 2) return null;
  const presentTag = arms.findIndex((a) => typeEquals(a, element));
  const missingTag = arms.findIndex((a) => a.kind === "undefinedT");
  if (presentTag < 0 || missingTag < 0) return null;
  const ret = fn.body[0]!;
  if (ret.kind !== "return" || ret.value?.kind !== "ternary") return null;
  const { cond, then, else_: missing } = ret.value;
  const operand = (value: IrExpr, id: string): boolean => value.kind === "varRef" && value.localId === id;
  if (cond.kind !== "bin" || cond.op !== "===" || cond.left.kind !== "arrayState" ||
      !operand(cond.left.arr, array!.localId) || !operand(cond.left.index, index!.localId) ||
      cond.right.kind !== "numLit" || cond.right.value !== 1 ||
      then.kind !== "unionWrap" || then.unionId !== call.type.unionId || then.tag !== presentTag ||
      then.value.kind !== "arrayGet" || !operand(then.value.arr, array!.localId) || !operand(then.value.index, index!.localId) ||
      missing.kind !== "unionWrap" || missing.unionId !== call.type.unionId || missing.tag !== missingTag ||
      missing.value.kind !== "unitLit" || missing.value.unit !== "undefined") return null;
  return { array: call.args[0]!, index: call.args[1]!, element, presentTag, missingTag };
}

/** Only the box must stay local: a narrowed payload may escape normally.
 * Captures, aliases, reassignment and all other union consumers keep the
 * heap representation. Unknown future IR nodes cannot opt in implicitly. */
function projectionOnly(fn: IrFunction, id: string): boolean {
  let declarations = 0;
  function expr(node: IrExpr): boolean {
    if ((node.kind === "unionNarrow" || node.kind === "unionIsTag") && node.value.kind === "varRef" && node.value.localId === id) return true;
    switch (node.kind) {
      case "varRef": case "assignExpr": case "incDec": if (node.localId === id) return false; break;
      case "closure": case "classRef": if (node.captures?.includes(id)) return false; break;
    }
    return everyExprChild(node, expr, stmt);
  }
  function stmt(node: IrStmt): boolean {
    switch (node.kind) {
      case "varDecl": if (node.localId === id && ++declarations !== 1) return false; break;
      case "assign": case "forOf": case "rethrow": if (node.localId === id) return false; break;
    }
    return everyStmtChild(node, expr, stmt);
  }
  return fn.body.every(stmt) && declarations === 1;
}

export function findLocalArrayReads(fn: IrFunction, functions: ReadonlyMap<string, IrFunction>, unions: ReadonlyMap<string, IrUnionDef>): Map<string, LocalArrayRead> {
  const result = new Map<string, LocalArrayRead>();
  if (fn.async || fn.generator) return result;
  const locals = new Map(fn.locals.map((l) => [l.id, l]));
  const captures = new Set([...(fn.captures ?? []), ...(fn.classCaptures ?? [])].map((c) => c.localId));
  const params = new Set(fn.params.map((p) => p.localId));
  const borrow = preservesArrayElements(fn, functions, unions);
  everyStmtList(fn.body, { expr: () => true, stmt: (node) => {
    if (node.kind !== "varDecl" || !node.init) return true;
    const local = locals.get(node.localId);
    if (!local || local.mutable || local.boxed || local.tdz || captures.has(local.id) || params.has(local.id)) return true;
    const read = optionalArrayRead(node.init, functions, unions);
    if (read && projectionOnly(fn, local.id)) {
      if (borrow && read.array.kind === "varRef" && params.has(read.array.localId) && !locals.get(read.array.localId)?.boxed) read.borrow = true;
      result.set(local.id, read);
    }
    return true;
  } });
  return result;
}

/** A private stack box keeps the ordinary tag/projection ABI. Its payload
 * either borrows from an array parameter proven to keep it alive, or owns
 * one reference released on every lexical exit, including exceptions. The
 * box never reaches runtime code; LLVM can scalar-replace its slots. */
export function emitLocalArrayRead(host: LlvmEmitterContext, read: LocalArrayRead, localSlot: string): { slot: string; type: IrType } | null {
  const B = host.B;
  const array = host.emitStableReceiver(read.array, [read.index]);
  const integerIndex = host.emitIntegerLoopIndex(read.index);
  const index = host.emitExpr(read.index);
  const box = B.slot(), payload = B.slot(), tag = B.slot();
  B.entryAllocas.push(`${box} = alloca %ScrUnion`);
  B.entryAllocas.push(`${payload} = getelementptr inbounds %ScrUnion, ptr ${box}, i32 0, i32 5`);
  B.entryAllocas.push(`${tag} = getelementptr inbounds %ScrUnion, ptr ${box}, i32 0, i32 1`);
  // The dense path uses the existing ScrArr ABI. Sparse indices and
  // noncanonical numeric properties retain the runtime lookup semantics.
  const capPtr = B.tmp(), cap = B.tmp(), capNumber = B.tmp(), nonnegative = B.tmp(), belowCap = B.tmp(), inRange = B.tmp();
  B.line(`${capPtr} = getelementptr inbounds %ScrArr, ptr ${array.name}, i32 0, i32 2`);
  host.markMemoryPointer(capPtr, "array:header");
  B.line(`${cap} = load ${host.sizeType}, ptr ${capPtr}${host.fieldAliasAttachment(capPtr)}`);
  if (integerIndex) B.line(`${inRange} = icmp ult ${host.sizeType} ${integerIndex}, ${cap}`);
  else {
    B.line(`${capNumber} = uitofp ${host.sizeType} ${cap} to double`);
    B.line(`${nonnegative} = fcmp oge double ${index.name}, 0.0`);
    B.line(`${belowCap} = fcmp olt double ${index.name}, ${capNumber}`);
    B.line(`${inRange} = and i1 ${nonnegative}, ${belowCap}`);
  }
  const range = B.newLabel("local.array.range"), dense = B.newLabel("local.array.dense"), slow = B.newLabel("local.array.slow");
  const no = B.newLabel("local.array.missing"), join = B.newLabel("local.array.join");
  B.condBr(inRange, range, slow);
  B.startBlock(range);
  const offset = integerIndex ?? B.tmp(), roundTrip = B.tmp(), integral = B.tmp();
  if (integerIndex) B.br(dense);
  else {
    B.line(`${offset} = fptoui double ${index.name} to ${host.sizeType}`);
    B.line(`${roundTrip} = uitofp ${host.sizeType} ${offset} to double`);
    B.line(`${integral} = fcmp oeq double ${index.name}, ${roundTrip}`);
    B.condBr(integral, dense, slow);
  }
  B.startBlock(dense);
  const lenPtr = B.tmp(), len = B.tmp(), belowLen = B.tmp();
  B.line(`${lenPtr} = getelementptr inbounds %ScrArr, ptr ${array.name}, i32 0, i32 1`);
  host.markMemoryPointer(lenPtr, "array:header");
  B.line(`${len} = load ${host.sizeType}, ptr ${lenPtr}${host.fieldAliasAttachment(lenPtr)}`);
  B.line(`${belowLen} = icmp ult ${host.sizeType} ${offset}, ${len}`);
  const stateLabel = B.newLabel("local.array.state"), valueLabel = B.newLabel("local.array.value");
  B.condBr(belowLen, stateLabel, no);
  B.startBlock(stateLabel);
  const statesPtr = B.tmp(), states = B.tmp(), statePtr = B.tmp(), denseState = B.tmp(), densePresent = B.tmp();
  B.line(`${statesPtr} = getelementptr inbounds %ScrArr, ptr ${array.name}, i32 0, i32 8`);
  host.markMemoryPointer(statesPtr, "array:header");
  B.line(`${states} = load ptr, ptr ${statesPtr}${host.fieldAliasAttachment(statesPtr)}`);
  B.line(`${statePtr} = getelementptr inbounds i8, ptr ${states}, ${host.sizeType} ${offset}`);
  host.markMemoryPointer(statePtr, "array:present");
  B.line(`${denseState} = load i8, ptr ${statePtr}${host.fieldAliasAttachment(statePtr)}`);
  B.line(`${densePresent} = icmp eq i8 ${denseState}, 1`);
  B.condBr(densePresent, valueLabel, no);
  B.startBlock(valueLabel);
  const dataPtr = B.tmp(), data = B.tmp(), valuePtr = B.tmp(), raw = B.tmp();
  B.line(`${dataPtr} = getelementptr inbounds %ScrArr, ptr ${array.name}, i32 0, i32 7`);
  host.markMemoryPointer(dataPtr, "array:header");
  B.line(`${data} = load ptr, ptr ${dataPtr}${host.fieldAliasAttachment(dataPtr)}`);
  B.line(`${valuePtr} = getelementptr inbounds i64, ptr ${data}, ${host.sizeType} ${offset}`);
  host.markMemoryPointer(valuePtr, "array:elements");
  B.line(`${raw} = load ptr, ptr ${valuePtr}${host.fieldAliasAttachment(valuePtr)}`);
  B.line(`store ptr ${read.borrow ? raw : host.retainValue(raw, read.element)}, ptr ${payload}`);
  B.line(`store i32 ${read.presentTag}, ptr ${tag}`);
  B.br(join);
  B.startBlock(slow);
  const value = B.tmp(), present = B.tmp();
  host.declare("declare ptr @scr_arr_peek_ref(ptr, double) memory(read)");
  B.line(`${value} = call ptr @scr_arr_peek_ref(ptr ${array.name}, double ${index.name})`);
  B.line(`${present} = icmp ne ptr ${value}, null`);
  const slowValue = B.newLabel("local.array.slow.value");
  B.condBr(present, slowValue, no);
  B.startBlock(slowValue);
  B.line(`store ptr ${read.borrow ? value : host.retainValue(value, read.element)}, ptr ${payload}`);
  B.line(`store i32 ${read.presentTag}, ptr ${tag}`);
  B.br(join);
  B.startBlock(no);
  B.line(`store ptr null, ptr ${payload}`);
  B.line(`store i32 ${read.missingTag}, ptr ${tag}`);
  B.br(join);
  B.startBlock(join);
  B.line(`store ptr ${box}, ptr ${localSlot}`);
  return read.borrow ? null : { slot: payload, type: read.element };
}
