import * as ir from "../../packages/compiler/src/ir/ir.js";

export function nativeFeatures(module: ir.IrModule) {
  return {
    regex: ir.moduleUsesRegex(module), copying: ir.moduleUsesCopying(module),
    inspect: ir.moduleUsesInspect(module), dynInvoke: ir.moduleUsesDynInvoke(module),
    symbol: ir.moduleUsesSymbol(module), bigint: ir.moduleUsesBigInt(module),
    zlib: ir.moduleUsesZlib(module), assert: ir.moduleUsesAssert(module),
    textDecoderLegacy: ir.moduleUsesLegacyTextDecoder(module), fileHandle: ir.moduleUsesFileHandle(module),
    fetch: ir.moduleUsesFetch(module), dc: ir.moduleUsesDc(module), dynAsync: ir.moduleUsesDynAsync(module),
    events: ir.moduleUsesProcessEvents(module), emitter: ir.moduleUsesEmitter(module),
    searchParams: ir.moduleUsesSearchParams(module), qs: ir.moduleUsesQs(module), parseArgs: ir.moduleUsesParseArgs(module),
    stream: ir.moduleUsesStream(module), net: ir.moduleUsesNet(module), http: ir.moduleUsesHttpServer(module),
    http2: ir.moduleUsesHttp2(module), dgram: ir.moduleUsesDgram(module), watch: ir.moduleUsesFsWatch(module),
    nodeTest: ir.moduleUsesNodeTest(module), tls: ir.moduleUsesTls(module), tlsCa: ir.moduleUsesTlsCa(module),
  };
}
