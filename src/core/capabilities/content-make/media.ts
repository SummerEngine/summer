import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { BuildToolError } from "../summer-bundle.js";

/**
 * The media tools content.make runs on the person's computer: ffmpeg and
 * ffprobe (cuts, motion, render, loudness), ImageMagick (captions) and,
 * for a voice-over, a Whisper (word times). Nothing is installed here: a
 * missing tool is a clear failure that names it.
 */

export const FPS = 30;
export const W = 1080;
export const H = 1920;

/** Where a command is on PATH, or null. */
export function which(command: string, path = process.env.PATH ?? ""): string | null {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const INSTALL: Record<string, string> = {
  ffmpeg: "Install ffmpeg (macOS: brew install ffmpeg), then run it again.",
  ffprobe: "Install ffmpeg (macOS: brew install ffmpeg), then run it again.",
  magick: "Install ImageMagick 7 (macOS: brew install imagemagick), then run it again.",
};

export function requireTools(names: readonly string[]): void {
  const missing = names.filter((name) => !which(name));
  if (missing.length) {
    throw new BuildToolError("content_tool_missing", `content.make needs ${missing.join(" and ")} on this computer.`, INSTALL[missing[0]] ?? `Install ${missing[0]}, then run it again.`, undefined, { missing: `${missing.join(", ")} on this computer` });
  }
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

/** Runs a command to the end; a non-zero exit is an error with the last lines of its output. */
export function run(command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.slice(0, 3).join(" ")}... exited ${code}: ${stderr.trim().split("\n").slice(-4).join(" | ")}`));
    });
  });
}

export const ffmpeg = (args: readonly string[]) => run("ffmpeg", ["-v", "error", "-y", ...args]);
export const magick = (args: readonly string[]) => run("magick", args);

export interface Probe {
  width: number;
  height: number;
  duration: number;
  hasAudio: boolean;
  fps: number;
}

export async function probe(file: string): Promise<Probe> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,avg_frame_rate:format=duration", "-of", "json", file]);
  const parsed = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string; width?: number; height?: number; avg_frame_rate?: string }>; format?: { duration?: string } };
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  return {
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    duration: Number(parsed.format?.duration ?? 0),
    hasAudio: Boolean(parsed.streams?.some((stream) => stream.codec_type === "audio")),
    fps: rate(video?.avg_frame_rate),
  };
}

function rate(value: string | undefined): number {
  const [num, den] = (value ?? "").split("/").map(Number);
  return num > 0 && den > 0 ? num / den : FPS;
}

export const frames = (seconds: number) => Math.round(seconds * FPS);

/**
 * Per-frame motion (YDIF: mean luma change from the frame before) and
 * brightness (YAVG) of a video, measured on a small copy so it is fast.
 */
export async function signalStats(file: string, fps?: number): Promise<{ ydif: number[]; yavg: number[] }> {
  const vf = `${fps ? `fps=${fps},` : ""}scale=270:-2,signalstats,metadata=print:key=lavfi.signalstats.YDIF:file=-,metadata=print:key=lavfi.signalstats.YAVG:file=-`;
  const { stdout } = await run("ffmpeg", ["-v", "error", "-i", file, "-vf", vf, "-an", "-f", "null", "-"]);
  const ydif: number[] = [];
  const yavg: number[] = [];
  for (const line of stdout.split("\n")) {
    const match = /lavfi\.signalstats\.(YDIF|YAVG)=([\d.]+)/.exec(line);
    if (!match) continue;
    (match[1] === "YDIF" ? ydif : yavg).push(Number(match[2]));
  }
  return { ydif, yavg };
}

/** Means of a per-frame series over fixed windows (seconds) at the series' frame rate. */
export function windowMeans(series: readonly number[], fps: number, windowSeconds: number): number[] {
  const size = Math.max(1, Math.round(fps * windowSeconds));
  const out: number[] = [];
  for (let start = 0; start < series.length; start += size) {
    const slice = series.slice(start, start + size);
    out.push(round2(slice.reduce((sum, value) => sum + value, 0) / slice.length));
  }
  return out;
}

/** Hard cuts (scene changes above the threshold), at least minGap seconds apart. */
export async function sceneCuts(file: string, threshold = 0.3, minGap = 0.12): Promise<number[]> {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-i", file, "-vf", `select='gt(scene,${threshold})',showinfo`, "-an", "-f", "null", "-"]);
  const cuts: number[] = [];
  for (const match of stderr.matchAll(/pts_time:([0-9.]+)/g)) {
    const t = round2(Number(match[1]));
    if (t > minGap && (!cuts.length || t - cuts[cuts.length - 1] >= minGap)) cuts.push(t);
  }
  return cuts;
}

/** Integrated loudness (LUFS) and true peak (dBTP) of a file's audio. */
export async function loudness(file: string): Promise<{ lufs: number; truePeak: number } | null> {
  try {
    const { stderr } = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-filter_complex", "ebur128=peak=true", "-f", "null", "-"]);
    const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
    const lufs = /I:\s+(-?[\d.]+) LUFS/.exec(summary);
    const peak = /Peak:\s+(-?[\d.]+) dBFS/.exec(summary);
    return lufs ? { lufs: Number(lufs[1]), truePeak: peak ? Number(peak[1]) : 0 } : null;
  } catch {
    return null;
  }
}

export const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Onsets (beats and hits) of a song, seconds: peaks of the rise in short-time
 * energy, at least 0.12 s apart. Enough to land cuts on the music.
 */
export async function onsets(file: string, maxSeconds = 240): Promise<number[]> {
  const rate = 4000;
  const stdout = await runBinary("ffmpeg", ["-v", "error", "-t", String(maxSeconds), "-i", file, "-ac", "1", "-ar", String(rate), "-f", "f32le", "-"]);
  const aligned = new Float32Array(new Uint8Array(stdout).buffer, 0, Math.floor(stdout.byteLength / 4));
  return onsetTimes(aligned, rate);
}

/** Onset times from mono samples (pure; see onsets). */
export function onsetTimes(samples: Float32Array, rate: number): number[] {
  const hop = Math.round(rate * 0.01);
  const energy: number[] = [];
  for (let start = 0; start + hop <= samples.length; start += hop) {
    let sum = 0;
    for (let i = start; i < start + hop; i++) sum += samples[i] * samples[i];
    energy.push(Math.log10(1e-9 + sum / hop));
  }
  const flux = energy.map((value, index) => Math.max(0, value - (energy[index - 1] ?? value)));
  const peaks: Array<{ t: number; strength: number }> = [];
  const window = 50;
  for (let i = 1; i < flux.length - 1; i++) {
    if (flux[i] <= flux[i - 1] || flux[i] < flux[i + 1]) continue;
    const around = flux.slice(Math.max(0, i - window), i + window);
    const mean = around.reduce((sum, value) => sum + value, 0) / around.length;
    if (flux[i] > mean * 2.2 && flux[i] > 0.15 && (!peaks.length || i * 0.01 - peaks[peaks.length - 1].t >= 0.12)) peaks.push({ t: round2(i * 0.01), strength: flux[i] });
  }
  // a busy song has an onset every few frames; cuts belong on its accents, the stronger 40%
  const sorted = peaks.map((peak) => peak.strength).sort((a, b) => a - b);
  const floor = peaks.length > 20 ? sorted[Math.floor(sorted.length * 0.6)] : 0;
  return peaks.filter((peak) => peak.strength >= floor).map((peak) => peak.t);
}

function runBinary(command: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${command} exited ${code}: ${err.trim().slice(-300)}`))));
  });
}
