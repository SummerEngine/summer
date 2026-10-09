import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readZipEntries, readZipEntry, ZipReadError, type ZipEntry } from "../util/zip.js";

/**
 * The summer.games export (summer-platform ADR 0033): one .zip with
 * summer-bundle.json, client.pck, and for a game with a host server.pck plus
 * config/. This reads what the build upload declares; the Platform verifies
 * the uploaded bytes again. Same rules as Studio's browser check
 * (publicsummerengine src/lib/creator-store/pck-check.ts, checkBundle).
 */

export const BUNDLE_SCHEMA = "summer.bundle.v1";
export const BUNDLE_MANIFEST = "summer-bundle.json";
const BUNDLE_CLIENT = "client.pck";
const BUNDLE_SERVER = "server.pck";
const BUNDLE_BUILD = "config/summer.build.json";
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const AS_EXPORTED =
  "Recovery: export the game again with the summer.games preset and use the .zip exactly as Summer Engine wrote it.";

/** A failure with a stable code, a plain message and the next step. */
export class BuildToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly recovery: string,
    readonly status?: number,
    readonly detail?: Record<string, unknown>
  ) {
    super(`${message} ${recovery}`);
    this.name = "BuildToolError";
  }
}

export interface BundleFile {
  path: string;
  sha256: string;
  size: number;
}

export interface SummerBundle {
  schema: typeof BUNDLE_SCHEMA;
  summerVersion: string | null;
  engineSha: string | null;
  /** res:// scene the client pack opens. */
  mainScene: string;
  /** Client platforms the export was made for (ios, macos, windows, ...). */
  targetPlatforms: string[];
  /** True when the game has a host (server.pck + config/summer.build.json). */
  hosted: boolean;
  compositionPath: string | null;
  /** client.pck as summer-bundle.json lists it ("sha256:<hex>"). */
  clientPack: { sha256: string; size: number };
  /** Hosted only: config/summer.build.json, sent as the Build declaration. */
  hostedBuild?: Record<string, unknown>;
  files: BundleFile[];
}

function bundleError(message: string): BuildToolError {
  return new BuildToolError("bundle_invalid", message, AS_EXPORTED);
}

/** Read and check summer-bundle.json in an exported .zip. */
export async function readSummerBundle(path: string): Promise<SummerBundle> {
  let entries: ZipEntry[];
  try {
    entries = await readZipEntries(path);
  } catch (error) {
    throw bundleError(
      `${path} is not a readable summer.games export (${error instanceof Error ? error.message : String(error)}).`
    );
  }
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const manifestEntry = byName.get(BUNDLE_MANIFEST);
  const clientEntry = byName.get(BUNDLE_CLIENT);
  if (!manifestEntry || !clientEntry) {
    throw bundleError(`${path} is not a summer.games export: it has no ${BUNDLE_MANIFEST} and ${BUNDLE_CLIENT}.`);
  }
  if (
    byName.size !== entries.length ||
    entries.some(
      (entry) =>
        entry.encrypted ||
        entry.name.endsWith("/") ||
        entry.name.split("/").some((part) => !part || part === "." || part === "..") ||
        /[\\\0\r\n]/.test(entry.name)
    )
  ) {
    throw bundleError("The export contains a repeated or unsafe file path.");
  }

  let manifest: Record<string, any>;
  try {
    manifest = JSON.parse((await readZipEntry(path, manifestEntry)).toString("utf8"));
  } catch (error) {
    if (error instanceof ZipReadError) throw bundleError(`${BUNDLE_MANIFEST} could not be read: ${error.message}`);
    throw bundleError(`${BUNDLE_MANIFEST} is not valid JSON.`);
  }
  const client = manifest?.client;
  const mainScene = typeof client?.mainScene === "string" ? client.mainScene : null;
  if (
    manifest?.schema !== BUNDLE_SCHEMA ||
    client?.path !== BUNDLE_CLIENT ||
    !mainScene?.startsWith("res://") ||
    !Array.isArray(client?.targetPlatforms) ||
    !client.targetPlatforms.every((value: unknown) => typeof value === "string") ||
    !Array.isArray(manifest.files)
  ) {
    throw new BuildToolError(
      "bundle_invalid",
      `${BUNDLE_MANIFEST} is not a ${BUNDLE_SCHEMA} manifest.`,
      "Recovery: update Summer Engine and export again."
    );
  }

  const hosted = Boolean(manifest.server);
  const compositionPath = typeof manifest.compositionPath === "string" ? manifest.compositionPath : null;
  if (
    (!hosted && manifest.compositionPath != null) ||
    hosted !== byName.has(BUNDLE_SERVER) ||
    (hosted &&
      (manifest.server?.path !== BUNDLE_SERVER ||
        typeof manifest.server.mainScene !== "string" ||
        !/^res:\/\/.+\.tscn$/.test(manifest.server.mainScene) ||
        !compositionPath ||
        !/^res:\/\/.+\.tres$/.test(compositionPath)))
  ) {
    throw bundleError("The export must name its server pack, main scene and network composition together.");
  }
  const allowed = (name: string) =>
    name === BUNDLE_MANIFEST ||
    name === BUNDLE_CLIENT ||
    name === BUNDLE_BUILD ||
    (hosted && (name === BUNDLE_SERVER || name.startsWith("config/")));
  const extra = entries.find((entry) => !allowed(entry.name));
  if (extra) throw bundleError(`The export contains ${extra.name}, which a summer.games export never has.`);

  const files: BundleFile[] = [];
  for (const item of manifest.files as Array<Record<string, unknown>>) {
    const entry = typeof item?.path === "string" ? byName.get(item.path) : undefined;
    if (
      !entry ||
      item.path === BUNDLE_MANIFEST ||
      typeof item.sha256 !== "string" ||
      !SHA256.test(item.sha256) ||
      item.size !== entry.uncompressedSize
    ) {
      throw bundleError(`The files do not match ${BUNDLE_MANIFEST}.`);
    }
    files.push({ path: entry.name, sha256: item.sha256, size: entry.uncompressedSize });
  }
  if (new Set(files.map((file) => file.path)).size !== files.length || files.length !== entries.length - 1) {
    throw bundleError(`The files do not match ${BUNDLE_MANIFEST}.`);
  }
  const listedClient = files.find((file) => file.path === BUNDLE_CLIENT)!;
  if (clientEntry.method !== 0) {
    throw bundleError(`${BUNDLE_CLIENT} is compressed in this zip; Summer reads it in place, so it must be stored.`);
  }

  let hostedBuild: Record<string, unknown> | undefined;
  if (hosted) {
    const config = byName.get(BUNDLE_BUILD);
    let build: unknown;
    try {
      build = config ? JSON.parse((await readZipEntry(path, config, 64 * 1024)).toString("utf8")) : undefined;
    } catch {
      build = undefined;
    }
    if (!build || typeof build !== "object" || Array.isArray(build) || (build as Record<string, unknown>).executionMode !== "hosted") {
      throw bundleError(`${BUNDLE_BUILD} is missing or does not declare a hosted game.`);
    }
    hostedBuild = build as Record<string, unknown>;
  }

  const targetPlatforms = client.targetPlatforms as string[];
  if (new Set(targetPlatforms).size !== targetPlatforms.length || targetPlatforms.length === 0) {
    throw bundleError("The export must name at least one platform, each once.");
  }

  return {
    schema: BUNDLE_SCHEMA,
    summerVersion: typeof manifest.export?.summerVersion === "string" ? manifest.export.summerVersion : null,
    engineSha: typeof manifest.export?.engineSha === "string" ? manifest.export.engineSha : null,
    mainScene: mainScene!,
    targetPlatforms,
    hosted,
    compositionPath,
    clientPack: { sha256: listedClient.sha256, size: listedClient.size },
    ...(hostedBuild ? { hostedBuild } : {}),
    files,
  };
}

/** "sha256:<hex>" and size of a whole file, streamed. */
export async function hashFile(path: string): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    sizeBytes += (chunk as Buffer).length;
  }
  return { sha256: `sha256:${hash.digest("hex")}`, sizeBytes };
}
