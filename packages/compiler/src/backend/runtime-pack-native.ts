/** Synchronous runtime-pack host for the statically compiled driver. Each
 * selected artifact is hashed and copied from the same read into private
 * storage. This host has no persistent cache or mutable installed link inputs. */
import { createHash } from "node:crypto";
import { closeSync, constants, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { NativeLinkFeatures } from "./native-link-info.js";
import type { NativeTargetSpec } from "./targets.js";
import {
  RuntimePackError, parseRuntimePackManifest, selectRuntimePackArtifacts, validateRuntimePackIdentity,
  type RuntimePackArtifact,
} from "./runtime-pack-core.js";

export interface NativeRuntimePack {
  runtimeObjects: string[];
  archives: string[];
  systemLibraries: string[];
}

function stageArtifact(root: string, stage: string, artifact: RuntimePackArtifact): string {
  const source = join(root, artifact.path);
  const destination = join(stage, artifact.path);
  let bytes: Buffer;
  try { bytes = readFileSync(source); }
  catch { throw new RuntimePackError(`runtime pack artifact is missing: ${artifact.path}`, "invalid"); }
  if (bytes.length !== artifact.size || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
    throw new RuntimePackError(`runtime pack artifact hash mismatch: ${artifact.path}`, "invalid");
  }
  mkdirSync(dirname(destination), { recursive: true });
  const fd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o400);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written === 0) throw new RuntimePackError(`could not stage runtime pack artifact: ${artifact.path}`, "invalid");
      offset += written;
    }
  } finally { closeSync(fd); }
  return destination;
}

/** stageRoot must be a new private directory owned by the caller. The caller
 * removes it on success or failure, after all native tools have finished. */
export function stageNativeRuntimePack(
  root: string,
  stageRoot: string,
  target: NativeTargetSpec,
  compilerVersion: string,
  features: NativeLinkFeatures,
  flavor: "release" | "dev",
): NativeRuntimePack {
  const packagePath = join(root, "package.json");
  const manifestPath = join(root, "runtime-pack.json");
  const packageText = readFileSync(packagePath, "utf8");
  const manifestText = readFileSync(manifestPath, "utf8");
  const identity = JSON.parse(packageText) as { name?: string; version?: string };
  const manifest = parseRuntimePackManifest(JSON.parse(manifestText));
  validateRuntimePackIdentity(manifest, identity.name, identity.version, target, compilerVersion);
  const selected = selectRuntimePackArtifacts(manifest, features, flavor);
  const runtimeObjects = selected.runtime.map((artifact) => stageArtifact(root, stageRoot, artifact));
  const archives = selected.archives.map((artifact) => stageArtifact(root, stageRoot, artifact));
  for (const license of manifest.licenses) {
    try { readFileSync(join(root, license.path)); }
    catch { throw new RuntimePackError("runtime pack license payload is incomplete", "invalid"); }
  }
  if (readFileSync(packagePath, "utf8") !== packageText || readFileSync(manifestPath, "utf8") !== manifestText) {
    throw new RuntimePackError("runtime pack changed while staging verified artifacts", "invalid");
  }
  return { runtimeObjects, archives, systemLibraries: selected.systemLibraries };
}
