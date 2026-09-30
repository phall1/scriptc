import { F64, typeKey, type IrExpr, type IrModule, type IrType } from "../../../packages/compiler/src/ir/ir.js";
import { sanitizeUnregisteredClassTypes } from "../../../packages/compiler/src/frontend/lowering/sanitize-class-types.js";

const loc = { file: "class-types.ts", start: 0, end: 1 };
const missing: IrType = { kind: "object", className: "Fenced" };
const kept: IrType = { kind: "object", className: "Registered" };
const expr: IrExpr = { kind: "varRef", localId: "x", type: missing, loc };
const nested: IrType = { kind: "func", params: [{ kind: "array", elem: missing }],
  ret: { kind: "generator", yieldT: missing, retT: kept, nextT: missing } };
const module: IrModule = { irVersion: 13, sourceFile: loc.file, entry: "main",
  functions: [{ name: "main", params: [{ localId: "x", name: "x", type: missing }],
    returnType: nested, locals: [], loc, body: [{ kind: "exprStmt", expr, loc }] }],
  records: [{ id: "r", fields: [{ name: "callback", type: nested }], indexValue: missing }],
  unions: [{ id: "u", arms: [missing, kept, { kind: "classval", className: "Fenced" }] }],
};
sanitizeUnregisteredClassTypes(module, (name) => name === "Registered");
console.log(module.functions[0]!.params[0]!.type.kind, expr.type.kind);
console.log(typeKey(nested));
for (const record of module.records ?? []) {
  for (const field of record.fields) console.log(typeKey(field.type));
  if (record.indexValue) console.log(typeKey(record.indexValue));
}
for (const union of module.unions ?? []) console.log(union.arms.map(typeKey).join(","));
console.log(missing.kind, kept.kind, F64.kind);
sanitizeUnregisteredClassTypes(module, (name) => name === "Registered");
console.log(expr.type.kind);
