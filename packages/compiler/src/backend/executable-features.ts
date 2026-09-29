/** Runtime requirements derived from the lowered program, shared by compiler hosts. */
import {
  moduleEmbedsBuiltin, moduleEmbedsCompressedNpm, moduleUsesAssert, moduleUsesBigInt,
  moduleUsesCopying, moduleUsesDc, moduleUsesDgram, moduleUsesDynAsync, moduleUsesDynInvoke,
  moduleUsesEmitter, moduleUsesFetch, moduleUsesFileHandle, moduleUsesFsWatch, moduleUsesHttp2,
  moduleUsesHttpServer, moduleUsesInspect, moduleUsesLegacyTextDecoder, moduleUsesNet,
  moduleUsesNodeTest, moduleUsesParseArgs, moduleUsesProcessEvents, moduleUsesQs, moduleUsesRegex,
  moduleUsesSearchParams, moduleUsesStream, moduleUsesSymbol, moduleUsesTls, moduleUsesTlsCa,
  moduleUsesZlib, type IrModule,
} from "../ir/ir.js";
import { hasForeignFfiCallback } from "./ffi-callbacks.js";
import type { NativeLinkFeatures } from "./native-link-info.js";

export function executableLinkFeatures(mod: IrModule, dynamic: boolean): NativeLinkFeatures {
  return {
    dynamic,
    regex: moduleUsesRegex(mod),
    copying: moduleUsesCopying(mod),
    textDecoderLegacy: moduleUsesLegacyTextDecoder(mod),
    fileHandle: moduleUsesFileHandle(mod),
    fetch: moduleUsesFetch(mod),
    netIsland:
      moduleEmbedsBuiltin(mod, "node:http") ||
      moduleEmbedsBuiltin(mod, "node:https") ||
      moduleEmbedsBuiltin(mod, "node:net") ||
      moduleEmbedsBuiltin(mod, "node:tls"),
    zlib: moduleUsesZlib(mod) || moduleEmbedsCompressedNpm(mod),
    assert: moduleUsesAssert(mod),
    inspect: moduleUsesInspect(mod),
    dynInvoke: moduleUsesDynInvoke(mod),
    dc: moduleUsesDc(mod),
    dynAsync: moduleUsesDynAsync(mod),
    events: moduleUsesProcessEvents(mod),
    emitter: moduleUsesEmitter(mod),
    symbol: moduleUsesSymbol(mod),
    bigint: moduleUsesBigInt(mod),
    searchParams: moduleUsesSearchParams(mod),
    qs: moduleUsesQs(mod),
    parseArgs: moduleUsesParseArgs(mod),
    stream: moduleUsesStream(mod),
    net: moduleUsesNet(mod),
    http: moduleUsesHttpServer(mod),
    http2: moduleUsesHttp2(mod),
    dgram: moduleUsesDgram(mod),
    watch: moduleUsesFsWatch(mod),
    foreignFfi: hasForeignFfiCallback(mod.ffiImports ?? []),
    nodeTest: moduleUsesNodeTest(mod),
    tls: moduleUsesTls(mod),
    tlsCa: moduleUsesTlsCa(mod),
  };
}
