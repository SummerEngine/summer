import { basename, extname } from "node:path";
import { stat } from "node:fs/promises";
import { resolveGatewayUrl } from "../config.js";
import { OAuthError } from "../oauth.js";
import { appendStoreJsonLine } from "../store.js";
import { readZipEntries, type ZipEntry } from "../util/zip.js";
import { BuildToolError } from "./summer-bundle.js";
import { createStore, readGrants, uploadParts, type PublishBuildDependencies } from "./publish-build.js";

/**
 * The store's second build path (summer-platform store versions,
 * internal/creatorstore): a web build (an HTML5 .zip played on summer.games)
 * or a native download (macOS universal, Windows x64, Linux x64) that players
 * download. summer_export_game format "download" makes these files;
 * summer_publish_build uploads them here, through the same creator store
 * routes as Studio (PSE /api/creator-store/* -> /v1/management/*):
 *
 *   GET  games/{g}/store/versions?platform=      resume an unfinished upload of the same file
 *   POST games/{g}/store/versions                {platform, fileName, sizeBytes, label} -> part plan
 *   GET  .../{v}/parts                           parts storage already has
 *   POST .../{v}:signParts                       {partNumbers} -> presigned PUT per part
 *   POST .../{v}:complete                        seal; Summer checks the file
 *   GET  .../{v}                                 until ready or rejected
 *
 * Players get the newest ready version of a platform, so on a game that is
 * already live the store refuses an agent's :complete (the owner finishes it).
 */

export const DOWNLOAD_PLATFORMS = ["web", "macos-universal", "windows-x64", "linux-x64"] as const;
export type DownloadPlatform = (typeof DOWNLOAD_PLATFORMS)[number];

/** summer-platform creatorstore limits (versions.go, webzip.go). */
const WEB_MAX_BYTES = 500 * 1024 * 1024;
const WEB_MAX_FILES = 2000;
const WEB_MAX_FILE_BYTES = 200 * 1024 * 1024;
const NATIVE_MAX_BYTES = 20 * 1024 ** 3;
const WEB_PART_BYTES = 16 * 1024 * 1024;
const NATIVE_PART_BYTES = 64 * 1024 * 1024;
const DEFAULT_WAIT_SECONDS = 300;
const POLL_MS = 3_000;
const seg = encodeURIComponent;

export interface PublishDownloadInput {
  gameId: string;
  file: string;
  platform: string;
  clientVersion: string;
  confirm?: boolean;
  waitSeconds?: number;
  face: "cli" | "mcp";
}

export function isDownloadPlatform(value: string): value is DownloadPlatform {
  return (DOWNLOAD_PLATFORMS as readonly string[]).includes(value);
}

/** The store's file name rule: a letter or digit first, then letters, digits, ". _ -" and spaces, at most 128. */
export function storeFileName(file: string): string {
  const cleaned = basename(file).replace(/[^A-Za-z0-9._ -]/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  return (cleaned || "game.zip").slice(-128);
}

/** What the store will refuse, checked before anything is sent. */
async function checkFile(file: string, platform: DownloadPlatform, sizeBytes: number): Promise<{ fileCount?: number }> {
  const lower = file.toLowerCase();
  if (platform === "web") {
    if (extname(lower) !== ".zip") throw new BuildToolError("download_format_unsupported", "A web build is a .zip.", 'Recovery: export with summer_export_game targets ["web"].');
    if (sizeBytes > WEB_MAX_BYTES) throw new BuildToolError("download_too_large", `The web build is ${Math.ceil(sizeBytes / 1024 ** 2)} MiB; the store takes at most 500 MiB.`, "Recovery: make the build smaller (compress textures, remove unused assets) and export again.");
    let entries: ZipEntry[];
    try {
      entries = await readZipEntries(file);
    } catch (error) {
      throw new BuildToolError("download_unreadable", `${file} is not a readable .zip (${error instanceof Error ? error.message : String(error)}).`, "Recovery: export again.");
    }
    const files = entries.filter((entry) => !entry.name.endsWith("/"));
    if (!files.some((entry) => entry.name === "index.html")) throw new BuildToolError("web_entry_missing", "The web build has no index.html at the top of the .zip.", 'Recovery: export with summer_export_game targets ["web"]; do not wrap the files in a folder.');
    if (files.length > WEB_MAX_FILES) throw new BuildToolError("web_too_many_files", `The web build has ${files.length} files; the store takes at most ${WEB_MAX_FILES}.`, "Recovery: export again; a Summer web export has a handful of files.");
    const big = files.find((entry) => entry.uncompressedSize > WEB_MAX_FILE_BYTES);
    if (big) throw new BuildToolError("web_file_too_large", `${big.name} is larger than 200 MiB.`, "Recovery: make the pack smaller and export again.");
    return { fileCount: files.length };
  }
  if (!(lower.endsWith(".zip") || lower.endsWith(".tar.gz") || lower.endsWith(".tgz"))) {
    throw new BuildToolError("download_format_unsupported", "A native download is a .zip or .tar.gz.", 'Recovery: export with summer_export_game format "download".');
  }
  if (sizeBytes > NATIVE_MAX_BYTES) throw new BuildToolError("download_too_large", "The download is larger than 20 GiB.", "Recovery: make the build smaller and export again.");
  return {};
}

type StoreVersion = { id: string; platform: string; label?: string; fileName?: string; sizeBytes?: number; status: string; rejectionReason?: string | null; playUrl?: string | null };

export async function publishDownload(input: PublishDownloadInput, deps: PublishBuildDependencies): Promise<Record<string, unknown> & { ok: true; status: string }> {
  const { gameId, file, clientVersion } = input;
  if (!isDownloadPlatform(input.platform)) {
    throw new BuildToolError("platform_invalid", `"${input.platform}" is not a store download platform.`, `Recovery: pass platform as one of ${DOWNLOAD_PLATFORMS.join(", ")}.`);
  }
  const platform = input.platform;
  const sizeBytes = (await stat(file)).size;
  const { fileCount } = await checkFile(file, platform, sizeBytes);
  const fileName = storeFileName(file);
  const target = { gameId, file, platform, fileName, sizeBytes, clientVersion, ...(fileCount ? { fileCount } : {}) };

  if (input.confirm !== true) {
    return {
      ok: true,
      status: "confirmation_required",
      target,
      next: "Show the user this exact game, file, platform, size and version. Only after they approve, call again with confirm=true. Nothing was uploaded.",
    };
  }

  let token: string;
  try {
    token = await deps.token();
  } catch (error) {
    if (error instanceof OAuthError) throw new BuildToolError(error.code, error.message.replace(` ${error.recovery}`, ""), error.recovery);
    throw error;
  }
  const store = createStore(await resolveGatewayUrl(), token, deps);
  const audit = { at: new Date(deps.now()).toISOString(), operation: "publish_download", face: input.face, ...target };
  await appendStoreJsonLine("creator-audit.jsonl", { ...audit, outcome: "started" });
  const versions = `games/${seg(gameId)}/store/versions`;

  try {
    // The same file and version still waiting for its bytes: continue it.
    const listed = await store.call<{ items?: StoreVersion[] }>("GET", `${versions}?platform=${seg(platform)}`);
    let version = (listed.items ?? []).find(
      (item) => item.status === "awaiting_upload" && item.platform === platform && item.fileName === fileName && item.sizeBytes === sizeBytes && item.label === clientVersion
    );
    let plan: { partSizeBytes: number; partCount: number } | null = null;
    const resumed = Boolean(version);
    if (!version) {
      const created = await store.call<{ version: StoreVersion; upload: { partSizeBytes: number; partCount: number } }>("POST", versions, {
        body: { platform, fileName, sizeBytes, label: clientVersion },
      });
      version = created.version;
      plan = { partSizeBytes: Number(created.upload?.partSizeBytes), partCount: Number(created.upload?.partCount) };
    }
    if (!version?.id) throw new BuildToolError("store_invalid_response", "The store did not return a version id.", "Recovery: retry.");
    const versionPath = `${versions}/${seg(version.id)}`;

    if (version.status === "awaiting_upload") {
      const partSizeBytes = plan?.partSizeBytes || (platform === "web" ? WEB_PART_BYTES : NATIVE_PART_BYTES);
      const partCount = plan?.partCount || Math.max(1, Math.ceil(sizeBytes / partSizeBytes));
      if (!(partSizeBytes > 0) || partCount !== Math.max(1, Math.ceil(sizeBytes / partSizeBytes))) {
        throw new BuildToolError("store_invalid_response", "The store's part plan does not fit this file.", "Recovery: retry; if it repeats, report the store as unhealthy.");
      }
      const expected = (n: number) => (n < partCount ? partSizeBytes : sizeBytes - (partCount - 1) * partSizeBytes);
      const stored = resumed ? (await store.call<{ parts?: Array<{ partNumber: number; sizeBytes: number }> }>("GET", `${versionPath}/parts`)).parts ?? [] : [];
      const done = new Set(stored.filter((part) => part.sizeBytes === expected(part.partNumber)).map((part) => part.partNumber));
      const missing = Array.from({ length: partCount }, (_, index) => index + 1).filter((n) => !done.has(n));
      if (missing.length) {
        await uploadParts(
          async (numbers) => readGrants(await store.call("POST", `${versionPath}:signParts`, { body: { partNumbers: numbers } })),
          file,
          sizeBytes,
          { partSizeBytes, partCount },
          deps,
          missing
        );
      }
      version = (await store.call<{ version: StoreVersion }>("POST", `${versionPath}:complete`, { body: {} })).version ?? version;
    }

    const deadline = deps.now() + (input.waitSeconds ?? DEFAULT_WAIT_SECONDS) * 1000;
    while (version.status !== "ready" && version.status !== "rejected" && deps.now() < deadline) {
      await deps.sleep(POLL_MS);
      version = await store.call<StoreVersion>("GET", versionPath);
    }

    const outcome = version.status === "ready" ? "ready" : version.status === "rejected" ? "rejected" : "processing";
    await appendStoreJsonLine("creator-audit.jsonl", { ...audit, outcome, versionId: version.id });
    if (version.status === "rejected") {
      throw new BuildToolError("download_rejected", version.rejectionReason || "Summer Games did not accept this file.", "Recovery: fix what the reason says, export again and upload with a new clientVersion.", undefined, { versionId: version.id });
    }
    return {
      ok: true,
      status: outcome,
      gameId,
      versionId: version.id,
      platform,
      clientVersion,
      resumed,
      ...(version.playUrl ? { playUrl: version.playUrl } : {}),
      next:
        outcome === "ready"
          ? "The file is checked. Players get it once the store page is live; submit the page with summer_store_submit (the owner approves)."
          : "Summer is still checking the file. Call summer_publish_build again with the same file and clientVersion to keep waiting; nothing is uploaded twice.",
    };
  } catch (error) {
    await appendStoreJsonLine("creator-audit.jsonl", { ...audit, outcome: "failed", code: error instanceof BuildToolError ? error.code : "publish_download_failed" });
    throw error;
  }
}
