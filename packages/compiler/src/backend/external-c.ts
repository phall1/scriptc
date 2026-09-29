/** External LLVM/C compilation for instrumented runtime development and
 * caller-supplied native sources. Production program objects use the
 * bundled LLVM helper and precompiled runtime packs. */
import {
  compileC,
  compileLibArchive,
  type CcOptions,
  type LibArchiveOptions,
} from "./native-toolchain.js";

export {
  CcCompileError,
  compileC,
  compileLibArchive,
  compilerDriverSupportsPersistentCache,
  configuredTargetPlatform,
  executableNativeEnvironmentFingerprint,
  isAndroidTarget,
  isIosTarget,
  isMobileTarget,
  mobileLibraryTarget,
  mobileTargetRefusal,
  prepareBuildCacheRoot,
  resolveCc,
  resolveBuildCacheRoot,
  runtimeSrcDir,
  subprocessFailureDetail,
  toolchainEnvironmentCachePolicy,
  toolchainEnvironmentFingerprint,
  targetPlatform,
  type CcDriver,
  type CcOptions,
  type LibArchiveOptions,
  type NativeCacheWarmProfile,
  type WarmNativeCachesOptions,
  type WarmNativeCachesResult,
  warmNativeCaches,
} from "./native-toolchain.js";

export {
  ANDROID_MIN_API,
  IPHONEOS_MIN_VERSION,
} from "./native-toolchain.js";

/** Compile a caller-provided C or LLVM source file through an external C
 * toolchain.  Runtime development and native embedding tests also use this utility. */
export async function compileExternalC(options: CcOptions): Promise<void> {
  await compileC(options);
}

/** Build an instrumented development library through the external toolchain. */
export async function compileExternalCLibrary(options: LibArchiveOptions): Promise<void> {
  await compileLibArchive(options);
}
