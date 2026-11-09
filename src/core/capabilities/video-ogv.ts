/**
 * Video imports for Summer Engine. The engine plays video only as Ogg Theora
 * (.ogv): an .mp4, .mov or .webm import never becomes a loadable resource and
 * the engine rolls it back. Every import path (summer_import_from_url, its
 * batch, summer_import_asset_by_id, summer_import_asset) runs its entries
 * through importUrls, which converts a video first, so a video just works:
 *
 * 1. A Cloudinary video URL (every video Summer generates or stores) becomes
 *    its .ogv rendition URL: Cloudinary converts on delivery and the engine
 *    downloads that. Nothing runs on this computer.
 * 2. Else, when this computer has an ffmpeg with Theora and the project folder
 *    is known: download, convert (Theora video q8, Vorbis audio q5, same frame
 *    rate, at most 1920x1080), write the .ogv into the project and register it
 *    with the editor.
 * 3. Else summerengine.com converts it (needs the Summer sign-in) and the
 *    engine downloads the .ogv it answers.
 *
 * The file lands at the requested path with its extension swapped to .ogv,
 * and the answer says so (videoConversions, note).
 */
import { execFile } from "node:child_process";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { getAuthToken } from "../auth.js";
import { resolveGatewayUrl } from "../config.js";
import { summerRequestHeaders } from "../agent-host.js";

/** Containers Summer Engine cannot load; .ogv is the one it can. */
const VIDEO_EXTENSION = /\.(?:mp4|mov|webm|m4v|mkv|avi)$/i;
/** Cloudinary's rendition: at most 1920x1080, Theora + Vorbis, same frame rate. */
export const OGV_TRANSFORM = "c_limit,h_1080,w_1920";
const VIDEO_UPLOAD = "/video/upload/";

export type ImportEntry = { url: string; path?: string };
export type VideoConversion = { from: string; to: string; via: "cloudinary" | "ffmpeg" | "summerengine.com" };

/** The part of the engine client this needs. */
export interface VideoImportClient {
  executeOps(ops: Record<string, unknown>[]): Promise<unknown>;
  getProjectRoot?(): string | undefined;
}

/** What the conversion runs; tests replace it. */
export interface VideoOgvDeps {
  /** The ffmpeg audio encoder for Vorbis when this ffmpeg has Theora, else null. */
  ffmpegTheora(): Promise<{ audio: "libvorbis" | "vorbis" | null } | null>;
  /** Run ffmpeg with these arguments. */
  runFfmpeg(args: string[]): Promise<void>;
  /** Download a public https file into a hidden file in `dir`; returns its path. */
  download(url: string, dir: string): Promise<string>;
  /** Ask summerengine.com for an .ogv of `url`; returns its URL. */
  convertRemote(url: string): Promise<string>;
}

function pathOf(raw: string): string {
  try {
    return new URL(raw).pathname;
  } catch {
    return raw.split(/[?#]/)[0] ?? raw;
  }
}

/** True when the entry is a video the engine cannot load (by the URL's file name or the requested path). */
export function isConvertibleVideo(entry: ImportEntry): boolean {
  return VIDEO_EXTENSION.test(pathOf(entry.url)) || (entry.path !== undefined && VIDEO_EXTENSION.test(entry.path));
}

/** The res:// path the .ogv lands at: the requested path with .ogv, else res://assets/videos/<name>.ogv (the engine's own inference). */
export function ogvResPath(entry: ImportEntry): string {
  if (entry.path) {
    const swapped = entry.path.replace(/\.[A-Za-z0-9]+$/, ".ogv");
    return swapped.toLowerCase().endsWith(".ogv") ? swapped : `${entry.path}.ogv`;
  }
  const file = decodeURIComponent(pathOf(entry.url).split("/").pop() || "video");
  const stem = file.replace(/\.[A-Za-z0-9]+$/, "").replace(/[^\p{L}\p{N}_.-]+/gu, "_") || "video";
  return `res://assets/videos/${stem}.ogv`;
}

/** The .ogv rendition of a Cloudinary video URL, or null when the URL is not one (or is signed). */
export function cloudinaryOgvUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "res.cloudinary.com" || url.username || url.password || url.port) return null;
  const at = url.pathname.indexOf(VIDEO_UPLOAD);
  if (at < 0) return null;
  const rest = url.pathname.slice(at + VIDEO_UPLOAD.length);
  // A signed delivery URL stops working when its transformation changes.
  if (/^s--[^/]+--\//.test(rest)) return null;
  if (!VIDEO_EXTENSION.test(rest) && !rest.toLowerCase().endsWith(".ogv")) return null;
  const stem = rest.replace(/\.[A-Za-z0-9]+$/, "");
  if (!stem) return null;
  const transformed = stem.startsWith(`${OGV_TRANSFORM}/`) ? stem : `${OGV_TRANSFORM}/${stem}`;
  return `${url.origin}${url.pathname.slice(0, at)}${VIDEO_UPLOAD}${transformed}.ogv`;
}

/** ffmpeg arguments: Theora q8 video, Vorbis q5 audio when there is audio, same frame rate, at most 1920x1080. */
export function ffmpegOgvArgs(input: string, output: string, audio: "libvorbis" | "vorbis" | null): string[] {
  const audioArgs =
    audio === "libvorbis"
      ? ["-map", "0:a:0?", "-c:a", "libvorbis", "-q:a", "5"]
      : audio === "vorbis"
        ? ["-map", "0:a:0?", "-c:a", "vorbis", "-strict", "-2", "-ac", "2", "-q:a", "5"]
        : ["-an"];
  return [
    "-v", "error", "-y", "-i", input,
    "-map", "0:v:0",
    "-vf", "scale='min(iw,1920)':'min(ih,1080)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    "-c:v", "libtheora", "-q:v", "8",
    ...audioArgs,
    "-f", "ogg", output,
  ];
}

function exec(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim().split("\n").slice(-3).join(" ")));
      else resolvePromise(stdout);
    });
  });
}

let theoraProbe: Promise<{ audio: "libvorbis" | "vorbis" | null } | null> | undefined;

const defaultDeps: VideoOgvDeps = {
  ffmpegTheora() {
    theoraProbe ??= exec("ffmpeg", ["-hide_banner", "-encoders"], 15_000).then(
      (out) => (/\blibtheora\b/.test(out) ? { audio: /\blibvorbis\b/.test(out) ? "libvorbis" : /\svorbis\s/.test(out) ? "vorbis" : null } : null),
      () => null
    );
    return theoraProbe;
  },
  async runFfmpeg(args) {
    await exec("ffmpeg", args, 15 * 60_000);
  },
  async download(url, dir) {
    // Loaded here: save-files.ts imports this module too.
    const { fetchPublicToTemp } = await import("../ops/save-files.js");
    return (await fetchPublicToTemp(url, dir)).temp;
  },
  async convertRemote(url) {
    const token = await getAuthToken();
    if (!token) throw new VideoConvertError("not_signed_in");
    const gateway = await resolveGatewayUrl();
    const res = await fetch(`${gateway}/api/mcp/video/ogv`, {
      method: "POST",
      headers: { ...summerRequestHeaders({ surface: "mcp" }), Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(150_000),
    });
    const body = (await res.json().catch(() => ({}))) as { ogvUrl?: string; message?: string; error?: string };
    if (!res.ok || typeof body.ogvUrl !== "string") {
      throw new VideoConvertError(res.status === 401 ? "not_signed_in" : "remote_failed", body.message ?? body.error ?? `HTTP ${res.status}`);
    }
    return body.ogvUrl;
  },
};

export class VideoConvertError extends Error {
  constructor(
    readonly reason: "not_signed_in" | "remote_failed" | "local_failed",
    detail?: string
  ) {
    super(
      reason === "not_signed_in"
        ? "Summer Engine plays video only as Ogg Theora (.ogv), and this video needs converting. This computer has no ffmpeg with Theora, so summerengine.com converts it, which needs the Summer sign-in: run npx -y summer-engine@latest login, then import again."
        : `Summer Engine plays video only as Ogg Theora (.ogv), and converting this video failed: ${detail ?? "unknown error"}.`
    );
    this.name = "VideoConvertError";
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Convert on this computer and put the .ogv at `resPath` in the project; returns the RenameFile receipt, or null when the file was moved into place directly. */
async function convertLocally(
  client: VideoImportClient,
  root: string,
  url: string,
  resPath: string,
  audio: "libvorbis" | "vorbis" | null,
  deps: VideoOgvDeps
): Promise<{ receipt: unknown; note?: string }> {
  const dest = join(root, resPath.slice("res://".length));
  const inside = relative(root, dest);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new VideoConvertError("local_failed", `${resPath} is outside the project`);
  }
  const dir = dirname(dest);
  await mkdir(dir, { recursive: true });
  // Hidden names: the editor skips dot files, so it never sees a half-written video.
  const staging = join(dir, `.summer-video-${randomBytes(6).toString("hex")}.ogv`);
  const source = await deps.download(url, dir);
  try {
    await deps.runFfmpeg(ffmpegOgvArgs(source, staging, audio));
  } catch (error) {
    await unlink(staging).catch(() => undefined);
    throw new VideoConvertError("local_failed", error instanceof Error ? error.message : String(error));
  } finally {
    await unlink(source).catch(() => undefined);
  }
  if (await exists(dest)) {
    // Already known to the editor: replace its bytes in place.
    await rename(staging, dest);
    return { receipt: { ok: true, op: "ImportFromUrl", meta: { path: resPath, replaced: true } } };
  }
  // RenameFile registers the new file with the editor's file system (the one op that does so for a file on disk).
  const stagingRes = `res://${relative(root, staging).split(sep).join("/")}`;
  try {
    const receipt = await client.executeOps([{ op: "RenameFile", from: stagingRes, to: resPath }]);
    const failed = (receipt as { status?: string; results?: Array<{ ok?: boolean }> })?.status === "error" ||
      ((receipt as { results?: Array<{ ok?: boolean }> })?.results ?? []).some((result) => result?.ok === false);
    if (!failed) return { receipt: { ok: true, op: "ImportFromUrl", meta: { path: resPath } } };
  } catch {
    // Fall through: the file still goes into place.
  }
  if (await exists(staging)) await rename(staging, dest);
  return {
    receipt: { ok: true, op: "ImportFromUrl", meta: { path: resPath } },
    note: `${resPath} is on disk; the editor lists it after its next file scan.`,
  };
}

function receiptsOf(result: unknown): unknown[] {
  const results = (result as { results?: unknown[] } | null)?.results;
  return Array.isArray(results) ? results : [];
}

/**
 * Import URLs into the project the way ImportFromUrl / ImportFromUrlBatch do,
 * converting every video to .ogv first. Without a video the engine gets
 * exactly the op it got before. `batch` picks ImportFromUrlBatch.
 */
export async function importUrls(
  client: VideoImportClient,
  entries: ImportEntry[],
  options: { batch: boolean },
  deps: VideoOgvDeps = defaultDeps
): Promise<unknown> {
  const engineOp = (list: ImportEntry[]) =>
    options.batch
      ? { op: "ImportFromUrlBatch", imports: list }
      : { op: "ImportFromUrl", url: list[0]!.url, ...(list[0]!.path ? { path: list[0]!.path } : {}) };

  if (!entries.some(isConvertibleVideo)) return client.executeOps([engineOp(entries)]);

  const forEngine: ImportEntry[] = [];
  const localReceipts: unknown[] = [];
  const conversions: VideoConversion[] = [];
  const notes: string[] = [];
  for (const entry of entries) {
    if (!isConvertibleVideo(entry)) {
      forEngine.push(entry);
      continue;
    }
    const to = ogvResPath(entry);
    const rendition = cloudinaryOgvUrl(entry.url);
    if (rendition) {
      forEngine.push({ url: rendition, path: to });
      conversions.push({ from: entry.url, to, via: "cloudinary" });
      continue;
    }
    const root = client.getProjectRoot?.();
    const theora = root ? await deps.ffmpegTheora() : null;
    if (root && theora) {
      const placed = await convertLocally(client, root, entry.url, to, theora.audio, deps);
      localReceipts.push(placed.receipt);
      if (placed.note) notes.push(placed.note);
      conversions.push({ from: entry.url, to, via: "ffmpeg" });
      continue;
    }
    forEngine.push({ url: await deps.convertRemote(entry.url), path: to });
    conversions.push({ from: entry.url, to, via: "summerengine.com" });
  }

  const engineResult = forEngine.length ? await client.executeOps([engineOp(forEngine)]) : { status: "ok", results: [] };
  const base = engineResult && typeof engineResult === "object" && !Array.isArray(engineResult) ? (engineResult as Record<string, unknown>) : { result: engineResult };
  const paths = conversions.map((conversion) => conversion.to).join(", ");
  return {
    ...base,
    results: [...receiptsOf(engineResult), ...localReceipts],
    videoConversions: conversions,
    note: [
      `Summer Engine plays video only as Ogg Theora (.ogv), so the video was converted and imported as ${paths}. Load it from that path.`,
      ...notes,
    ].join(" "),
  };
}
