import { expect, test } from "vitest";
import { STRING, VOID, type IrModule } from "../../ir/ir.js";
import { IR_VERSION } from "../../ir/serialize.js";
import { emitCModule, emitCModuleChunks } from "./c-emitter.js";

test("chunked C emission preserves separators, Unicode and the final newline", () => {
  const loc = { file: "source-🦀.ts", start: 0, end: 1 };
  const mod: IrModule = {
    irVersion: IR_VERSION, sourceFile: loc.file, entry: "main",
    functions: [{ name: "main", params: [], locals: [], returnType: VOID, loc,
      body: Array.from({ length: 2000 }, (_, i) => ({ kind: "exprStmt" as const, loc,
        expr: { kind: "strLit" as const, value: `Unicode 🦀 ${i}`, type: STRING, loc },
      })),
    }],
  };
  const chunks = emitCModuleChunks(mod);
  expect(chunks.length).toBeGreaterThan(2);
  expect(chunks.join("")).toBe(emitCModule(mod));
  expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString()).toBe(emitCModule(mod));
  expect(chunks.at(-1)!.endsWith("\n")).toBe(true);
});
