import { createVendorArchives } from "../vendor-archives.js";
import { runtimeSrcDir, runtimeFingerprint } from "./runtime-inputs.js";
import { targetPlatform, isZigDriver } from "./driver.js";
import { resolvedToolIdentity } from "./tool-identity.js";

export const {
  vendorEngineDir,
  vendorTlsDir,
  vendorCurlDir,
  vendorBuildCacheRoot,
  vendorCacheTargetFlavor,
  vendorCacheBuildIdentity,
  currentVendorCacheBuildIdentity,
  engineArchivePath,
  stageVendorInputs,
  ensureEngineArchive,
  lreObjectPaths,
  ensureLreObjects,
  vendorZlibDir,
  zlibObjectPaths,
  ensureZlibObjects,
  curlStubDirPath,
  ensureCurlStub,
  tlsArchivePath,
  ensureTlsArchive,
  QJS_ENGINE_SOURCES,
  LRE_SOURCES,
  ZLIB_SOURCES,
} = createVendorArchives({
  runtimeSrcDir,
  targetPlatform,
  isZigDriver,
  resolvedToolIdentity,
  runtimeFingerprint,
});
