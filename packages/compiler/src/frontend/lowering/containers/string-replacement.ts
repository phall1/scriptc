import * as ts from "../../ts7/adapter.js";
import { BOOL, F64, REGEX, STRING, arrayOf, isUnitType, typeEquals, typeKey, type IrExpr, type IrLocal, type IrStmt, type IrType, type SrcLoc } from "../../../ir/ir.js";
import { numLit, strLit, varRef } from "../../../ir/build.js";
import { locOf } from "../../program.js";
import type { Lowerer } from "../lowerer.js";
import { coerceStringSearchValue, defaultAfterUndefined, lowerStaticallyUndefinedArgument } from "../optional-arguments.js";

/** String search does not interpret regex syntax or capture substitutions.
 * The helper receives evaluated arguments and owns its chunks until join.
 * Callbacks see the original immutable subject and UTF-16 match offset. */
export function lowerStringReplacement(
  lowerer: Lowerer,
  call: ts.CallExpression,
  method: "replace" | "replaceAll",
  receiver: IrExpr,
  args: readonly ts.Expression[],
): IrExpr {
  if (args.length > 2 || args.some(ts.isSpreadElement)) {
    return lowerer.noLowering(`string .${method} with spread or extra arguments`, call);
  }
  const loc = locOf(call);
  const primitive = (type: IrType): boolean => type.kind === "union"
    ? lowerer.unions.get(type.unionId)!.arms.every(primitive)
    : type.kind === "string" || type.kind === "f64" || type.kind === "bool" || type.kind === "bigint" || isUnitType(type);
  const argument = (node: ts.Expression | undefined, callback: boolean): IrExpr => {
    if (!node) return strLit("undefined", loc);
    const absent = lowerStaticallyUndefinedArgument(lowerer, node);
    if (absent) return defaultAfterUndefined(absent, strLit("undefined", loc));
    const value = lowerer.lowerExpr(node);
    if (value.type.kind === "dyn" || (callback && value.type.kind === "func")) return value;
    if (!primitive(value.type)) {
      lowerer.noLowering(`string .${method} with '${lowerer.fmt(value.type)}' ${callback ? "replacement" : "search"} values`, node,
        "use a primitive search value and a primitive replacement or a typed callback");
    }
    return coerceStringSearchValue(lowerer, value, node, loc);
  };
  const search = argument(args[0], false);
  const replacement = argument(args[1], true);
  if (search.type.kind === "dyn" || replacement.type.kind === "dyn") {
    if (replacement.type.kind === "func") {
      lowerer.noLowering(`string .${method} with checked search values and callbacks`, call);
    }
    // Evaluate all inputs once before choosing the search protocol. Regexes
    // retain their native pattern; plain values use the string-search helper.
    const values = [receiver, search, replacement];
    const locals = values.map((value) => lowerer.declareHiddenLocal("%replaceArg", value.type));
    const refs = locals.map((local) => varRef(local.id, local.type, loc));
    const checkedReplacement = replacement.type.kind === "dyn"
      ? lowerer.coerceInto(args[1] ?? call, refs[2]!, STRING) : refs[2]!;
    const plainSearch = lowerer.ensureString(refs[1]!, args[0] ?? call);
    const plain = lowerStringReplacementValues(lowerer, call, method, refs[0]!, plainSearch, checkedReplacement);
    const result: IrExpr = search.type.kind === "dyn" ? {
      kind: "ternary",
      cond: { kind: "libCall", fn: "dyn.nativeRegexIs", args: [refs[1]!], type: BOOL, loc },
      then: {
        kind: "regexIntrinsic", method, receiver: refs[0]!,
        args: [lowerer.coerceInto(args[0] ?? call, refs[1]!, REGEX), checkedReplacement], type: STRING, loc,
      },
      else_: plain, type: STRING, loc,
    } : plain;
    return {
      kind: "seqExpr", stmts: values.map((value, index) => ({ kind: "varDecl", localId: locals[index]!.id, init: value, loc })),
      result, type: STRING, loc,
    };
  }
  return lowerStringReplacementValues(lowerer, call, method, receiver, search, replacement);
}

function lowerStringReplacementValues(
  lowerer: Lowerer, call: ts.CallExpression, method: "replace" | "replaceAll",
  receiver: IrExpr, search: IrExpr, replacement: IrExpr,
): IrExpr {
  const loc = locOf(call);
  const callback = replacement.type.kind === "func" ? replacement.type : null;
  const full = [STRING, F64, STRING];
  if (callback && (callback.ret.kind !== "string" || callback.params.length > full.length ||
      !callback.params.every((type, index) => typeEquals(type, full[index]!)))) {
    lowerer.noLowering(`string .${method} callback signature`, call.arguments[1] ?? call,
      "use a callback returning string with a prefix of (match: string, offset: number, subject: string)");
  }
  const key = `str.${method}:${typeKey(replacement.type)}`;
  let helper = lowerer.widthHelpers.get(key);
  if (!helper) {
    helper = `%str.${method}.${lowerer.widthHelpers.size}`;
    lowerer.widthHelpers.set(key, helper);
    const subject = varRef("s.0", STRING, loc);
    const needle = varRef("search.0", STRING, loc);
    const replace = varRef("replace.0", replacement.type, loc);
    const cursor = varRef("cursor.0", F64, loc);
    const end = varRef("end.0", F64, loc);
    const match = varRef("match.0", F64, loc);
    const size = varRef("size.0", F64, loc);
    const chunksType = arrayOf(STRING);
    const chunks = varRef("chunks.0", chunksType, loc);
    const builder = stringBuilder(loc, chunks);
    const value: IrExpr = callback ? {
      kind: "callValue", callee: replace,
      args: [needle, match, subject].slice(0, callback.params.length), type: STRING, loc,
    } : {
      kind: "call", callee: replacementTemplateHelper(lowerer, loc),
      args: [subject, needle, replace, match], type: STRING, loc,
    };
    const stop: IrStmt = { kind: "break", loc };
    const body: IrStmt[] = [
      builder.declare("chunks.0", { kind: "arrayLit", elems: [], type: chunksType, loc }),
      builder.declare("cursor.0", numLit(0, loc)),
      builder.declare("end.0", numLit(0, loc)),
      builder.declare("size.0", builder.length(needle)),
      {
        kind: "while", cond: builder.compare("<=", cursor, builder.length(subject)),
        body: [
          builder.declare("match.0", { kind: "strIntrinsic", method: "indexOf", receiver: subject, args: [needle, cursor], type: F64, loc }),
          { kind: "if", cond: builder.compare("<", match, numLit(0, loc)), then: [stop], else_: null, loc },
          builder.append(builder.slice(subject, end, match)),
          builder.append(value),
          builder.assign("end.0", builder.add(match, size)),
          ...(method === "replace" ? [stop] : [builder.assign("cursor.0", builder.add(match, {
            kind: "ternary", cond: builder.compare("===", size, numLit(0, loc)),
            then: numLit(1, loc), else_: size, type: F64, loc,
          }))]),
        ], loc,
      },
      builder.append(builder.slice(subject, end)),
      { kind: "return", value: builder.join(), loc },
    ];
    const params = [
      { localId: "s.0", name: "s", type: STRING },
      { localId: "search.0", name: "search", type: STRING },
      { localId: "replace.0", name: "replace", type: replacement.type },
    ];
    lowerer.liftedFns.push({
      name: helper, params, returnType: STRING,
      locals: [
        ...params.map(param => ({ id: param.localId, name: param.name, type: param.type, mutable: false })),
        { id: "chunks.0", name: "chunks", type: chunksType, mutable: false },
        ...["cursor", "end", "match", "size"].map(name => ({ id: `${name}.0`, name, type: F64, mutable: true })),
      ], body, loc,
    });
  }
  return { kind: "call", callee: helper, args: [receiver, search, replacement], type: STRING, loc };
}

/** GetSubstitution with no captures: $$, $&, $`, and $' expand. Numeric
 * and named capture spellings remain literal. Scan dollar signs rather
 * than individual subject characters so ordinary Unicode text is intact. */
function replacementTemplateHelper(lowerer: Lowerer, loc: SrcLoc): string {
  const key = "str.replacementTemplate";
  const previous = lowerer.widthHelpers.get(key);
  if (previous) return previous;
  const name = `%str.template.${lowerer.widthHelpers.size}`;
  lowerer.widthHelpers.set(key, name);
  const subject = varRef("s.0", STRING, loc);
  const needle = varRef("search.0", STRING, loc);
  const template = varRef("template.0", STRING, loc);
  const position = varRef("position.0", F64, loc);
  const cursor = varRef("cursor.0", F64, loc);
  const dollar = varRef("dollar.0", F64, loc);
  const next = varRef("next.0", STRING, loc);
  const chunksType = arrayOf(STRING);
  const chunks = varRef("chunks.0", chunksType, loc);
  const builder = stringBuilder(loc, chunks);
  const expansions: [string, IrExpr][] = [
    ["$", strLit("$", loc)],
    ["&", needle],
    ["`", builder.slice(subject, numLit(0, loc), position)],
    ["'", builder.slice(subject, builder.add(position, builder.length(needle)))],
  ];
  let selection: IrStmt[] = [builder.append(strLit("$", loc))];
  for (let index = expansions.length - 1; index >= 0; index--) {
    const [token, expansion] = expansions[index]!;
    selection = [{
      kind: "if", cond: { kind: "strEq", negated: false, left: next, right: strLit(token, loc), type: BOOL, loc },
      then: [builder.append(expansion), builder.assign("cursor.0", builder.add(cursor, numLit(1, loc)))],
      else_: selection, loc,
    }];
  }
  const params = [
    { localId: "s.0", name: "s", type: STRING },
    { localId: "search.0", name: "search", type: STRING },
    { localId: "template.0", name: "template", type: STRING },
    { localId: "position.0", name: "position", type: F64 },
  ];
  const locals: IrLocal[] = [
    ...params.map(param => ({ id: param.localId, name: param.name, type: param.type, mutable: false })),
    { id: "chunks.0", name: "chunks", type: chunksType, mutable: false },
    { id: "cursor.0", name: "cursor", type: F64, mutable: true },
    { id: "dollar.0", name: "dollar", type: F64, mutable: false },
    { id: "next.0", name: "next", type: STRING, mutable: false },
  ];
  lowerer.liftedFns.push({
    name, params, returnType: STRING, locals,
    body: [
      builder.declare("chunks.0", { kind: "arrayLit", elems: [], type: chunksType, loc }),
      builder.declare("cursor.0", numLit(0, loc)),
      {
        kind: "while", cond: builder.compare("<", cursor, builder.length(template)),
        body: [
          builder.declare("dollar.0", { kind: "strIntrinsic", method: "indexOf", receiver: template, args: [strLit("$", loc), cursor], type: F64, loc }),
          { kind: "if", cond: builder.compare("<", dollar, numLit(0, loc)), then: [{ kind: "break", loc }], else_: null, loc },
          builder.append(builder.slice(template, cursor, dollar)),
          builder.assign("cursor.0", builder.add(dollar, numLit(1, loc))),
          builder.declare("next.0", { kind: "strIntrinsic", method: "charAt", receiver: template, args: [cursor], type: STRING, loc }),
          ...selection,
        ], loc,
      },
      builder.append(builder.slice(template, cursor)),
      { kind: "return", value: builder.join(), loc },
    ], loc,
  });
  return name;
}

function stringBuilder(loc: SrcLoc, chunks: IrExpr) {
  return {
    declare(localId: string, init: IrExpr): IrStmt { return { kind: "varDecl", localId, init, loc }; },
    assign(localId: string, value: IrExpr): IrStmt { return { kind: "assign", localId, value, loc }; },
    add(left: IrExpr, right: IrExpr): IrExpr { return { kind: "bin", op: "+", left, right, type: F64, loc }; },
    compare(op: "<" | "<=" | "===", left: IrExpr, right: IrExpr): IrExpr { return { kind: "bin", op, left, right, type: BOOL, loc }; },
    length(receiver: IrExpr): IrExpr { return { kind: "strIntrinsic", method: "length", receiver, args: [], type: F64, loc }; },
    slice(receiver: IrExpr, start: IrExpr, end?: IrExpr): IrExpr {
      return { kind: "strIntrinsic", method: "slice", receiver, args: end ? [start, end] : [start], type: STRING, loc };
    },
    append(value: IrExpr): IrStmt {
      return { kind: "exprStmt", expr: { kind: "arrIntrinsic", method: "push", receiver: chunks, args: [value], type: F64, loc }, loc };
    },
    join(): IrExpr { return { kind: "arrIntrinsic", method: "join", receiver: chunks, args: [strLit("", loc)], type: STRING, loc }; },
  };
}
