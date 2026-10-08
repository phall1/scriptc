import { expect, test } from "vitest";
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import {
  builtinConstructorIdentityOf,
  builtinConstructorScope,
  specializedConstructorIdentity,
  type BuiltinConstructorIdentity,
} from "./builtin-constructor-identity.js";

function binding(name: string) {
  const expr = { kind: ts.SyntaxKind.Identifier, text: name } as ts.Identifier;
  const symbol = { name, flags: 0 } as ts.Symbol;
  return { expr, symbol };
}

function fixture() {
  const symbols = new Map<ts.Node, ts.Symbol>();
  const stdlib = new Set<ts.Symbol>();
  const declarations = new Map<ts.Symbol, ts.Node>();
  const lowerer = {
    checker: {
      getSymbolAtLocation: (node: ts.Node) => symbols.get(node),
      declarationsOf: (symbol: ts.Symbol) =>
        declarations.has(symbol) ? [declarations.get(symbol)!] : [],
      valueDeclarationOf: (symbol: ts.Symbol) => declarations.get(symbol),
    },
    stdlibGlobalAliases: new Map(),
    implicitBuiltinConstructors: new Map<ts.Symbol, BuiltinConstructorIdentity>(),
    isStdlibSymbol: (symbol: ts.Symbol) => stdlib.has(symbol),
    builtinImportOf: () => null,
    builtinMemberOf: () => null,
  } as unknown as Lowerer;
  return { lowerer, symbols, stdlib, declarations };
}

test.each(["URL", "URLSearchParams", "RegExp"] as const)(
  "%s identity requires stdlib provenance",
  (name) => {
    const { lowerer, symbols, stdlib } = fixture();
    const global = binding(name);
    const shadow = binding(name);
    symbols.set(global.expr, global.symbol);
    symbols.set(shadow.expr, shadow.symbol);
    stdlib.add(global.symbol);
    expect(builtinConstructorIdentityOf(lowerer, global.expr)).toBe(name);
    expect(builtinConstructorIdentityOf(lowerer, shadow.expr)).toBeNull();
    expect(
      builtinConstructorIdentityOf(lowerer, {
        kind: ts.SyntaxKind.StringLiteral,
        text: `[builtin ${name}]`,
      } as ts.StringLiteral),
    ).toBeNull();
  },
);

test("scoped symbols retain identity without inferring it from a parameter name", () => {
  const { lowerer, symbols } = fixture();
  const parameter = binding("constructor");
  const other = binding("constructor");
  symbols.set(parameter.expr, parameter.symbol);
  symbols.set(other.expr, other.symbol);
  lowerer.implicitBuiltinConstructors!.set(parameter.symbol, "URL");
  expect(specializedConstructorIdentity(lowerer, parameter.expr)).toBe("URL");
  expect(builtinConstructorIdentityOf(lowerer, parameter.expr)).toBe("URL");
  expect(specializedConstructorIdentity(lowerer, other.expr)).toBeNull();
});

test("scope merging preserves outer identities without modifying prior maps", () => {
  const first = binding("outer"),
    second = binding("inner");
  const previous = new Map<ts.Symbol, BuiltinConstructorIdentity>([[first.symbol, "URL"]]);
  const current = new Map<ts.Symbol, BuiltinConstructorIdentity>([[second.symbol, "RegExp"]]);
  expect(builtinConstructorScope(previous, undefined)).toBe(previous);
  expect(builtinConstructorScope(previous, current)).toEqual(new Map([...previous, ...current]));
  expect(previous.has(second.symbol)).toBe(false);
  expect(current.has(first.symbol)).toBe(false);
  expect(builtinConstructorScope(previous, new Map(), [first.symbol])?.has(first.symbol)).toBe(
    false,
  );
  expect(builtinConstructorScope(previous, current, [first.symbol])).toEqual(current);
  expect(
    builtinConstructorScope(previous, new Map([[first.symbol, "RegExp"]]), [first.symbol])?.get(
      first.symbol,
    ),
  ).toBe("RegExp");
  expect(previous.get(first.symbol)).toBe("URL");
});
