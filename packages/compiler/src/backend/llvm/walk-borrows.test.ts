import { expect, test } from "vitest";
import { F64, VOID, type IrExpr, type IrFunction, type IrStmt, type IrType } from "../../ir/ir.js";
import { findWalkBorrows, type WalkBorrowHost } from "./walk-borrows.js";

const loc = { file: "walk.ts", start: 0, end: 0 };
const NODE: IrType = { kind: "object", className: "Node" };
const ref = (localId: string): IrExpr => ({ kind: "varRef", localId, type: NODE, loc });
const parent = (obj: IrExpr): IrExpr => ({
  kind: "fieldGet",
  obj,
  className: "Node",
  field: "parent",
  type: NODE,
  loc,
});
const decl = (localId: string, init: IrExpr | null): IrStmt => ({
  kind: "varDecl",
  localId,
  init,
  loc,
});
const assign = (localId: string, value: IrExpr): IrStmt => ({
  kind: "assign",
  localId,
  value,
  loc,
});
const local = (id: string, mutable = true) => ({ id, name: id, type: NODE, mutable });

function fn(body: IrStmt[], locals: string[], params = ["node"]): IrFunction {
  return {
    name: "walk",
    params: params.map((id) => ({ localId: id, name: id, type: NODE })),
    locals: [...params, ...locals].map((id) => local(id)),
    body,
    returnType: VOID,
    loc,
  };
}

const host: WalkBorrowHost = {
  pointerLocal: (l) => l.type.kind === "object",
  borrowsWithoutOwning: () => true,
};

test("parent walks rooted at unwritten parameters borrow", () => {
  const body = [
    decl("p", parent(ref("node"))),
    decl("next", parent(ref("p"))),
    assign("p", ref("next")),
    decl("unset", null),
    assign("unset", parent(parent(ref("p")))),
  ];
  expect(findWalkBorrows(fn(body, ["p", "next", "unset"]), host)).toEqual(
    new Set(["p", "next", "unset"]),
  );
});

test("rebound parameters, owned sources and other writers keep ownership", () => {
  const call: IrExpr = { kind: "call", callee: "make", args: [], type: NODE, loc };
  const body = [
    // A rebound parameter is no root, and neither is its walk.
    assign("node", parent(ref("node"))),
    decl("fromParam", parent(ref("node"))),
    // A call result is owned, and the failure propagates transitively.
    decl("owned", call),
    decl("viaOwned", parent(ref("owned"))),
    decl("viaViaOwned", ref("viaOwned")),
    // An expression-position write excludes the local.
    decl("written", parent(ref("other"))),
    {
      kind: "exprStmt",
      expr: { kind: "assignExpr", localId: "written", value: ref("other"), type: NODE, loc },
      loc,
    } as IrStmt,
    decl("kept", parent(ref("other"))),
  ];
  const result = findWalkBorrows(
    fn(
      body,
      ["fromParam", "owned", "viaOwned", "viaViaOwned", "written", "kept"],
      ["node", "other"],
    ),
    host,
  );
  expect(result).toEqual(new Set(["kept"]));
});

test("scalar locals, owning projections and suspending bodies are never walks", () => {
  const scalar = fn([decl("p", parent(ref("node")))], ["p"]);
  scalar.locals[1] = { id: "p", name: "p", type: F64, mutable: true };
  expect(findWalkBorrows(scalar, host).size).toBe(0);
  const owning = fn([decl("p", parent(ref("node")))], ["p"]);
  expect(findWalkBorrows(owning, { ...host, borrowsWithoutOwning: () => false }).size).toBe(0);
  const suspending: IrFunction = { ...fn([decl("p", parent(ref("node")))], ["p"]), async: true };
  expect(findWalkBorrows(suspending, host).size).toBe(0);
});
