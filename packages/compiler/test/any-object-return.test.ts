import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// Tracer.Span's hidden declaration leaves `any` fields on the object the
// span method returns. The object still has to keep its getter and methods.
test("a span method can return an object whose fields are any", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-any-object-"));
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  symlinkSync(
    join(import.meta.dirname, "../../../../effect-scriptc-compat/node_modules"),
    join(directory, "node_modules"),
    "dir",
  );
  writeFileSync(
    entry,
    [
      'import { Context, Effect, Exit, Option, Tracer } from "effect";',
      'import * as DevToolsClient from "effect/devtools/DevToolsClient";',
      "import type * as DevToolsSchema from \"effect/devtools/DevToolsSchema\";",
      "const messages: Array<DevToolsSchema.Span | DevToolsSchema.SpanEvent> = [];",
      "const events: Array<string> = [];",
      "const baseTracer = Tracer.make({",
      "  span(options) {",
      "    let status: Tracer.SpanStatus = { _tag: \"Started\", startTime: options.startTime };",
      "    const attributes = new Map<string, unknown>();",
      "    const links = [...options.links];",
      "    return {",
      "      _tag: \"Span\",",
      "      name: options.name,",
      "      spanId: \"span-1\",",
      "      traceId: \"trace-1\",",
      "      sampled: options.sampled,",
      "      parent: options.parent,",
      "      annotations: options.annotations,",
      "      kind: options.kind,",
      "      links,",
      "      attributes,",
      "      get status() { return status; },",
      "      attribute(key, value) { attributes.set(key, value); },",
      "      event(name) { events.push(name); },",
      "      addLinks(more) { links.push(...more); },",
      "      end(endTime, exit) { status = { _tag: \"Ended\", startTime: options.startTime, endTime, exit }; },",
      "    };",
      "  },",
      "});",
      "const tracer = Effect.runSync(DevToolsClient.makeTracer.pipe(",
      "  Effect.provideService(DevToolsClient.DevToolsClient, { sendUnsafe: (message) => { messages.push(message); } }),",
      "  Effect.withTracer(baseTracer),",
      "));",
      "const span = tracer.span({",
      "  name: \"fixture\", parent: Option.none(), annotations: Context.empty(), links: [],",
      "  startTime: 100n, kind: \"internal\", root: true, sampled: true,",
      "});",
      "span.attribute(\"step\", 1);",
      "span.event(\"ready\", 110n, { ok: true });",
      "span.end(120n, Exit.succeed(\"done\"));",
      "console.log(JSON.stringify([",
      "  messages.map((message) => message._tag === \"Span\"",
      "    ? [message._tag, message.name, message.status._tag, Array.from(message.attributes)]",
      "    : [message._tag, message.name, String(message.startTime)]),",
      "  events, span.spanId, span.traceId,",
      "]));",
      "",
    ].join("\n"),
  );
  try {
    const result = await compile(entry, {
      outDir: directory,
      outPath: binary,
      outputKind: "exe",
      optimization: "dev",
      npmStatic: ["effect"],
    });
    expect(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const run = spawnSync(result.binaryPath, [], { encoding: "utf8", timeout: 30_000 });
    const oracle = spawnSync(process.execPath, ["--experimental-strip-types", entry], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(oracle.status, oracle.stderr).toBe(0);
    expect(oracle.stdout).toBe(
      '[[["Span","fixture","Started",[]],["SpanEvent","ready","110"],["Span","fixture","Ended",[["step",1]]]],["ready"],"span-1","trace-1"]\n',
    );
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(oracle.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
