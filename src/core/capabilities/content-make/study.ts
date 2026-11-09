import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { BuildToolError } from "../summer-bundle.js";
import { probe, round2, run, sceneCuts, signalStats, which, windowMeans } from "./media.js";
import { parseCaptionStyle, refHasVoice, wordsOf } from "./plan.js";
import type { FootageClip, FootageIndex, Reference, Study } from "./types.js";

/** Where content.make keeps its work on this computer unless told otherwise: ~/.summer/content. */
export function defaultContentRoot(): string {
  return join(homedir(), ".summer", "content");
}

/**
 * The reference video on this computer: the file given, the cached copy,
 * else a download of the original post (yt-dlp, when installed). It is
 * studied only; nothing of it is rendered into the piece.
 */
export async function referenceVideo(ref: Reference, cacheDir: string, given?: string): Promise<string> {
  if (given) {
    if (!existsSync(given)) throw new BuildToolError("content_reference_missing", `referenceFile ${given} does not exist.`, "Pass the path of the reference video.");
    return given;
  }
  const dir = join(cacheDir, "references");
  const cached = join(dir, `${ref.referenceId}.mp4`);
  if (existsSync(cached)) return cached;
  if (!ref.url) throw new BuildToolError("content_reference_missing", `Reference ${ref.referenceId} has no link to study.`, "Pass referenceFile with the reference video.", undefined, { missing: "the reference video" });
  if (!which("yt-dlp")) {
    throw new BuildToolError("content_reference_missing", `The reference video is not on this computer and yt-dlp is not installed to fetch it.`, `Install yt-dlp (macOS: brew install yt-dlp), or pass referenceFile with the video from ${ref.url}.`, undefined, { missing: "the reference video (install yt-dlp)" });
  }
  mkdirSync(dir, { recursive: true });
  await run("yt-dlp", ["-q", "--no-progress", "--no-playlist", "-f", "mp4/bestvideo*+bestaudio/best", "--merge-output-format", "mp4", "-o", cached, ref.url]);
  if (!existsSync(cached)) throw new BuildToolError("content_reference_missing", `Could not fetch the reference video from ${ref.url}.`, "Pass referenceFile with the video.", undefined, { missing: "the reference video" });
  return cached;
}

/** Cuts, black beats, length, voice and caption look of the reference. */
export async function studyReference(ref: Reference, file: string): Promise<Study> {
  const info = await probe(file);
  let cuts = (await sceneCuts(file, 0.3)).filter((cut) => cut < info.duration - 0.1);
  // soft cuts (pages, cards, slides that look alike) hide from a hard-cut threshold: when the beats
  // say there are many more shots than it found, look again finer, one cut per 0.2 s at most
  if (cuts.length < ((ref.beats?.length ?? 1) - 1) / 2) {
    const finer = (await sceneCuts(file, 0.15, 0.2)).filter((cut) => cut < info.duration - 0.1);
    // only when the finer look really finds that rhythm; a long take's camera swing is not a cut
    if (finer.length >= ((ref.beats?.length ?? 1) - 1) / 2) cuts = finer;
  }
  const { yavg } = await signalStats(file, 10);
  const bounds = [0, ...cuts, info.duration];
  const black = bounds.slice(0, -1).map((start, index) => {
    const slice = yavg.slice(Math.floor(start * 10), Math.max(Math.floor(start * 10) + 1, Math.floor(bounds[index + 1] * 10)));
    return slice.length > 0 && slice.reduce((sum, value) => sum + value, 0) / slice.length < 20;
  });
  const hasVoice = refHasVoice(ref);
  const sound = `${ref.hook ?? ""} ${ref.voPattern ?? ""} ${ref.captionStyle ?? ""}`.toLowerCase();
  return {
    referenceId: ref.referenceId,
    file,
    duration: round2(info.duration),
    width: info.width,
    height: info.height,
    cuts,
    black,
    hasVoice,
    firstCut: cuts[0] ?? round2(info.duration),
    caption: parseCaptionStyle(ref.captionStyle, hasVoice),
    music: /music|song|track|on the beat|beat drop/.test(sound),
  };
}

const VIDEO = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const AUDIO = new Set([".wav", ".mp3", ".m4a", ".ogg", ".flac"]);

function listMedia(paths: readonly string[]): string[] {
  const out: string[] = [];
  const visit = (path: string, depth: number) => {
    const name = basename(path);
    if (name.startsWith(".") || name.startsWith("._")) return;
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      if (depth > 2) return;
      for (const child of readdirSync(path).sort()) visit(join(path, child), depth + 1);
    } else out.push(path);
  };
  for (const path of paths) visit(path, 0);
  return out;
}

interface Sidecar {
  about?: string;
  tags?: string[];
}

/** Notes next to the footage: a folder's shots.json (capture mode) or a clip's own <clip>.json. */
function sidecarFor(file: string): Sidecar | null {
  const own = file.replace(/\.[^.]+$/, ".json");
  try {
    if (existsSync(own)) {
      const parsed = JSON.parse(readFileSync(own, "utf8")) as { about?: string; description?: string; action?: string; tags?: string[] };
      return { about: [parsed.about ?? parsed.description, parsed.action].filter(Boolean).join(". "), tags: parsed.tags };
    }
    const shots = join(dirname(file), "shots.json");
    if (existsSync(shots)) {
      const parsed = JSON.parse(readFileSync(shots, "utf8")) as { shots?: Array<Record<string, unknown>> };
      const row = parsed.shots?.find((shot) => shot.file === basename(file));
      if (row) {
        const hero = (row.hero ?? {}) as Record<string, unknown>;
        const words = [row.about, row.action, row.camera, row.map, row.light, hero.look, hero.class, hero.skin].filter((value): value is string => typeof value === "string");
        return { about: [row.about, row.action].filter(Boolean).join(". "), tags: wordsOf(words.join(" ")) };
      }
    }
  } catch {
    // a broken sidecar is no sidecar
  }
  return null;
}

/** Measures one clip (cached by path, size and time): motion and brightness per half second. */
async function measureClip(file: string, cacheDir: string): Promise<FootageClip> {
  const stat = statSync(file);
  const key = createHash("sha1").update(`${file}|${stat.size}|${stat.mtimeMs}|v1`).digest("hex");
  const cacheFile = join(cacheDir, "footage", `${key}.json`);
  const sidecar = sidecarFor(file);
  const nameWords = wordsOf(`${basename(file, extname(file)).replace(/[_-]+/g, " ")} ${basename(dirname(file)).replace(/[_-]+/g, " ")}`);
  const tags = [...new Set([...nameWords, ...(sidecar?.tags ?? []), ...wordsOf(sidecar?.about)])];
  let measured: Pick<FootageClip, "duration" | "width" | "height" | "hasAudio" | "motion" | "luma"> | null = null;
  try {
    if (existsSync(cacheFile)) measured = JSON.parse(readFileSync(cacheFile, "utf8"));
  } catch {
    measured = null;
  }
  const kind = IMAGE.has(extname(file).toLowerCase()) ? "image" : "video";
  if (!measured) {
    const info = await probe(file);
    if (kind === "image") measured = { duration: 0, width: info.width, height: info.height, hasAudio: false, motion: [], luma: [] };
    else {
      const stats = await signalStats(file);
      measured = { duration: round2(info.duration), width: info.width, height: info.height, hasAudio: info.hasAudio, motion: windowMeans(stats.ydif, info.fps, 0.5), luma: windowMeans(stats.yavg, info.fps, 0.5) };
    }
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(measured));
  }
  return { path: file, kind, ...measured, tags, ...(sidecar?.about ? { about: sidecar.about } : {}) };
}

/** Every clip, still and song in the footage folders, measured. Frames pulled from a clip (name.mp4.still-3.png) are left out. */
export async function indexFootage(paths: readonly string[], cacheDir: string, onClip?: (done: number, total: number) => void): Promise<FootageIndex> {
  const files = listMedia(paths);
  const media = files.filter((file) => VIDEO.has(extname(file).toLowerCase()) || (IMAGE.has(extname(file).toLowerCase()) && !/\.(mp4|mov|webm|mkv)\.still/i.test(basename(file))));
  const clips: FootageClip[] = [];
  for (const file of media) {
    clips.push(await measureClip(file, cacheDir));
    onClip?.(clips.length, media.length);
  }
  return { clips: clips.filter((clip) => clip.kind === "image" || clip.duration > 0.3), music: files.filter((file) => AUDIO.has(extname(file).toLowerCase())) };
}
