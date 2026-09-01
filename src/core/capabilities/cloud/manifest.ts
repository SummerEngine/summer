import { createHash } from "crypto";
import { gunzipSync, gzipSync } from "zlib";
import type { CloudManifest } from "./types.js";
import { findPathCollisions, validateCloudPath } from "./validate-path.js";

export function sha256Hex(bytes: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Spec 6.3: keys sorted bytewise (UTF-8), no whitespace, then gzip. */
export function compareKeysBytewise(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export function serializeManifest(manifest: CloudManifest): Buffer {
  const files = Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => compareKeysBytewise(a, b)));
  const document = {
    schemaVersion: manifest.schemaVersion,
    projectId: manifest.projectId,
    rulesVersion: manifest.rulesVersion,
    files,
  };
  return gzipSync(Buffer.from(JSON.stringify(document), "utf8"));
}

export function parseManifest(bytes: Buffer, expectedProjectId?: string): CloudManifest {
  const parsed = JSON.parse(gunzipSync(bytes).toString("utf8")) as CloudManifest;
  if (parsed.schemaVersion !== 1 || typeof parsed.projectId !== "string" || typeof parsed.files !== "object") {
    throw new Error("Invalid Summer Cloud manifest");
  }
  if (expectedProjectId && parsed.projectId !== expectedProjectId) {
    throw new Error("Manifest projectId mismatch");
  }
  const keys = Object.keys(parsed.files);
  for (const path of keys) {
    const valid = validateCloudPath(path);
    if (!valid.ok) throw new Error(`Invalid manifest path ${path}: ${valid.reason}`);
  }
  const collisions = findPathCollisions(keys);
  if (collisions.length) {
    const first = collisions[0];
    throw new Error(`Manifest path collision (${first.kind}): ${first.a} and ${first.b}`);
  }
  return parsed;
}
