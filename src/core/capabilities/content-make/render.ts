import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ffmpeg, FPS, frames, H, loudness, magick, probe, run, signalStats, W } from "./media.js";
import type { Word } from "./plan.js";
import type { CaptionItem, CaptionStyle, ShotSpec } from "./types.js";

/**
 * The render, ported from the beat-for-beat pipeline that made the pieces
 * the team liked: every shot is cut to an exact frame count on the
 * reference's cut list, captions are frame-exact transparent tracks drawn
 * with ImageMagick, the voice sits over the game's own sound at -14 LUFS.
 * Shots are cached by their spec, so a re-render only redoes what changed.
 */

const FONTS: Record<CaptionStyle["font"], string[]> = {
  sans: ["/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
  rounded: ["/System/Library/Fonts/Supplemental/Arial Rounded Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
  serif: ["/System/Library/Fonts/Supplemental/Georgia Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf"],
};

/** The font file for a caption: the game's own (kit or input) when given, else a system font of the same kind. */
export function fontFile(kind: CaptionStyle["font"], own?: string | null): string {
  if (own && existsSync(own) && kind !== "serif") return own;
  return FONTS[kind].find((file) => existsSync(file)) ?? "Arial-Bold";
}

/** One shot of exactly n frames, with its own game sound (or silence). */
async function renderShot(spec: ShotSpec, n: number, outV: string, outA: string): Promise<void> {
  const d = n / FPS;
  const silence = ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", d.toFixed(6), outA];
  if (spec.color || !spec.src) {
    await ffmpeg(["-f", "lavfi", "-i", `color=c=${spec.color ?? "black"}:s=${W}x${H}:r=${FPS}`, "-frames:v", String(n), "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", outV]);
    await ffmpeg(silence);
    return;
  }
  const src = spec.src;
  const info = await probe(src);
  const still = /\.(png|jpe?g|webp)$/i.test(src);
  const speed = spec.speed ?? 1;
  const z0 = spec.z0 ?? 1;
  const z1 = spec.z1 ?? z0;
  const zmin = Math.min(z0, z1);
  let ch = info.height / zmin;
  let cw = (ch * W) / H;
  if (cw > info.width) {
    cw = info.width;
    ch = (cw * H) / W;
  }
  cw = Math.floor(cw / 2) * 2;
  ch = Math.floor(ch / 2) * 2;
  const x0 = Math.round(Math.min(Math.max((spec.cx ?? 0.5) * info.width - cw / 2, 0), info.width - cw));
  const y0 = Math.round(Math.min(Math.max((spec.cy ?? 0.5) * info.height - ch / 2, 0), info.height - ch));
  const a = z0 / zmin;
  const b = (z1 - z0) / zmin;
  const zoom = `(${a.toFixed(5)}+${b.toFixed(5)}*t/${d.toFixed(5)})`;
  const vf = [
    still ? `fps=${FPS}` : `setpts=(PTS-STARTPTS)/${speed},fps=${FPS}`,
    `crop=${cw}:${ch}:${x0}:${y0}`,
    `scale=w='trunc(${W}*${zoom}/2)*2':h='trunc(${H}*${zoom}/2)*2':eval=frame:flags=lanczos`,
    `crop=${W}:${H}:'(iw-${W})/2':'(ih-${H})/2'`,
    "setsar=1",
    // a short source holds its last frame instead of shortening the cut
    "tpad=stop_mode=clone:stop_duration=30",
    "format=yuv420p",
  ].join(",");
  const input = still ? ["-loop", "1", "-framerate", String(FPS), "-t", (d + 0.5).toFixed(3), "-i", src] : ["-ss", (spec.t ?? 0).toFixed(3), "-t", (d * speed + 0.5).toFixed(3), "-i", src];
  await ffmpeg([...input, "-vf", vf, "-frames:v", String(n), "-an", "-c:v", "libx264", "-crf", "16", "-preset", "medium", outV]);
  if (still || spec.mute || !info.hasAudio) {
    await ffmpeg(silence);
    return;
  }
  await ffmpeg([
    "-ss", (spec.t ?? 0).toFixed(3), "-i", src, "-vn",
    "-af", `aresample=48000,apad,atrim=0:${d.toFixed(6)},afade=t=in:d=0.01,afade=t=out:st=${Math.max(d - 0.01, 0).toFixed(4)}:d=0.01`,
    "-ac", "2", "-ar", "48000", outA,
  ]);
}

async function frameCount(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-count_packets", "-select_streams", "v:0", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", file]);
  return Number(stdout.trim());
}

/** The cut: every shot on its frame-exact slot, concatenated, plus the game-sound bed on the same grid. */
export async function buildBase(shots: readonly ShotSpec[], cuts: readonly number[], dir: string, onShot?: (index: number, total: number) => void): Promise<{ base: string; bed: string; frameCuts: number[] }> {
  const seg = join(dir, "seg");
  mkdirSync(seg, { recursive: true });
  const fc = cuts.map(frames);
  const videos: string[] = [];
  const audios: string[] = [];
  for (let i = 0; i < shots.length; i++) {
    const n = fc[i + 1] - fc[i];
    if (n <= 0) throw new Error(`Shot ${i} has no frames (cuts ${cuts[i]} to ${cuts[i + 1]}).`);
    const v = join(seg, `v${String(i).padStart(3, "0")}.mp4`);
    const a = join(seg, `a${String(i).padStart(3, "0")}.wav`);
    const keyFile = `${v}.key`;
    const key = JSON.stringify({ spec: shots[i], n, v: 2 });
    if (!(existsSync(v) && existsSync(a) && existsSync(keyFile) && readFileSync(keyFile, "utf8") === key)) {
      await renderShot(shots[i], n, v, a);
      const got = await frameCount(v);
      if (got !== n) throw new Error(`Shot ${i} has ${got} frames; its slot needs ${n}.`);
      writeFileSync(keyFile, key);
    }
    videos.push(v);
    audios.push(a);
    onShot?.(i + 1, shots.length);
  }
  const list = join(seg, "vlist.txt");
  writeFileSync(list, videos.map((v) => `file '${v}'\n`).join(""));
  const base = join(dir, "base.mp4");
  const bed = join(dir, "bed.wav");
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", base]);
  await ffmpeg([...audios.flatMap((a) => ["-i", a]), "-filter_complex", `${audios.map((_, i) => `[${i}:a]`).join("")}concat=n=${audios.length}:v=0:a=1[a]`, "-map", "[a]", bed]);
  return { base, bed, frameCuts: fc };
}

/** A transparent track of pictures, each held for its frame count (frame-exact, unlike image durations in a concat list). */
export async function overlayTrack(states: ReadonlyArray<[string, number]>, out: string): Promise<string> {
  const dir = `${out}_parts`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const parts: string[] = [];
  for (const [index, [picture, n]] of states.entries()) {
    if (n <= 0) continue;
    const part = join(dir, `p${String(index).padStart(4, "0")}.mov`);
    await ffmpeg(["-loop", "1", "-framerate", String(FPS), "-i", picture, "-frames:v", String(n), "-c:v", "qtrle", "-pix_fmt", "argb", part]);
    parts.push(part);
  }
  writeFileSync(`${out}.txt`, parts.map((part) => `file '${part}'\n`).join(""));
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", `${out}.txt`, "-c", "copy", out]);
  return out;
}

function styled(text: string, style: CaptionStyle): string {
  let out = text.replace(/\[[^\]]*\]/g, "").replace(/\s+/g, " ").trim().replace(/'/g, "’");
  if (style.case === "lower") out = out.toLowerCase();
  if (style.case === "upper") out = out.toUpperCase();
  return style.quoted ? `“${out}”` : out;
}

async function textWidth(text: string, font: string, size: number): Promise<number> {
  const { stdout } = await magick(["-font", font, "-pointsize", String(size), `label:${text}`, "-format", "%w", "info:"]);
  return Number(stdout);
}

/** Breaks a caption into as few balanced lines as keep every line inside the safe width (at most four). */
async function wrap(text: string, font: string, size: number, maxWidth: number): Promise<string> {
  const words = text.split(" ");
  if (words.length < 2 || (await textWidth(text, font, size)) <= maxWidth) return text;
  for (let count = 2; count <= Math.min(4, words.length); count++) {
    const target = text.length / count;
    const lines: string[] = [];
    let current: string[] = [];
    for (const word of words) {
      if (current.length && [...current, word].join(" ").length > target * 1.15 && lines.length < count - 1) {
        lines.push(current.join(" "));
        current = [];
      }
      current.push(word);
    }
    lines.push(current.join(" "));
    const widths = await Promise.all(lines.map((line) => textWidth(line, font, size)));
    if (widths.every((width) => width <= maxWidth)) return lines.join("\n");
  }
  return words.reduce<string[]>((rows, word, index) => (index % 2 ? [...rows.slice(0, -1), `${rows[rows.length - 1]} ${word}`] : [...rows, word]), []).join("\n");
}

export interface CaptionBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * One caption on a transparent frame, at the reference's place and in its
 * look: the text with a dark outline (no shadow, no glow). With a highlight,
 * the longest word takes that colour. Returns its box on the frame.
 */
export async function captionPng(text: string, style: CaptionStyle, font: string, out: string): Promise<CaptionBox> {
  const label = styled(text, style);
  // a long held line sets smaller, as the references do, so it stays two or three lines
  const size = style.mode === "words" ? style.size : Math.round(Math.max(56, Math.min(style.size, style.size * Math.sqrt(30 / Math.max(30, label.length)))));
  const stroke = style.outline ? Math.max(4, Math.round(size / 8)) : 0;
  // centred text stays inside the safe area (0.06-0.86 of the width) with room for the outline
  const maxWidth = W * 0.68;
  const tmp = `${out}.label.png`;
  const words = label.split(" ");
  const fits = (await textWidth(label, font, size)) <= maxWidth;
  const hi = fits && style.highlight && style.mode === "words" && words.length > 1 ? words.reduce((best, word, index) => (word.replace(/\W/g, "").length > words[best].replace(/\W/g, "").length ? index : best), 0) : -1;
  if (hi >= 0) {
    // word by word so one word can take the highlight colour
    const parts: string[] = [];
    for (const [index, word] of words.entries()) {
      const part = `${out}.w${index}.png`;
      const fill = index === hi ? style.highlight! : style.color;
      await magick(["-background", "none", "-font", font, "-pointsize", String(size), "-fill", fill, ...(stroke ? ["-stroke", "black", "-strokewidth", String(stroke)] : []), `label:${word}`, "-stroke", "none", "-fill", fill, `label:${word}`, "-gravity", "center", "-compose", "over", "-composite", part]);
      parts.push(part);
    }
    await magick(["-background", "none", ...parts.flatMap((part, index) => (index < parts.length - 1 ? [part, "-size", `${Math.round(size / 4)}x1`, "xc:none"] : [part])), "+append", tmp]);
    for (const part of parts) rmSync(part, { force: true });
  } else {
    const wrapped = await wrap(label, font, size, maxWidth);
    await magick([
      "-background", "none", "-font", font, "-pointsize", String(size), "-interline-spacing", String(-Math.round(size / 6)), "-gravity", "center",
      "-fill", style.color, ...(stroke ? ["-stroke", "black", "-strokewidth", String(stroke)] : []), `label:${wrapped}`,
      "-stroke", "none", "-fill", style.color, `label:${wrapped}`, "-compose", "over", "-composite", tmp,
    ]);
  }
  const { stdout } = await magick([tmp, "-format", "%w %h", "info:"]);
  const [w, h] = stdout.trim().split(" ").map(Number);
  const cy = Math.round(style.y * H);
  await magick(["-size", `${W}x${H}`, "xc:none", tmp, "-gravity", "center", "-geometry", `+0${cy - H / 2 >= 0 ? "+" : ""}${cy - H / 2}`, "-composite", `PNG32:${out}`]);
  rmSync(tmp, { force: true });
  return { left: (W - w) / 2 / W, top: (cy - h / 2) / H, right: (W + w) / 2 / W, bottom: (cy + h / 2) / H };
}

/** A caption track: each item over its time, blank between. Returns the track and every caption's box. */
export async function captionTrack(items: readonly CaptionItem[], end: number, style: CaptionStyle, font: string, dir: string): Promise<{ track: string; boxes: CaptionBox[] } | null> {
  if (!items.length) return null;
  const capDir = join(dir, "cap");
  rmSync(capDir, { recursive: true, force: true });
  mkdirSync(capDir, { recursive: true });
  const blank = join(capDir, "blank.png");
  await magick(["-size", `${W}x${H}`, "xc:none", `PNG32:${blank}`]);
  const states: Array<[string, number]> = [];
  const boxes: CaptionBox[] = [];
  let t = 0;
  for (const [index, item] of items.entries()) {
    const from = Math.max(item.from, t);
    const to = Math.min(item.to, end);
    if (to <= from) continue;
    if (frames(from) > frames(t)) states.push([blank, frames(from) - frames(t)]);
    const picture = join(capDir, `c${String(index).padStart(3, "0")}.png`);
    boxes.push(await captionPng(item.text, style, font, picture));
    states.push([picture, frames(to) - frames(from)]);
    t = to;
  }
  if (frames(end) > frames(t)) states.push([blank, frames(end) - frames(t)]);
  return { track: await overlayTrack(states, join(dir, "caps.mov")), boxes };
}

/** Word captions from the voice: chunks change with the words, each held until the next starts. */
export function wordCaptionItems(chunks: ReadonlyArray<readonly Word[]>, end: number): CaptionItem[] {
  return chunks.map((chunk, index) => ({
    text: chunk.map((word) => word.w).join(" ").replace(/[.,?!]+$/g, "").replace(/,/g, ""),
    from: chunk[0].s,
    to: index + 1 < chunks.length ? chunks[index + 1][0].s : end,
  }));
}

/** A picture over a time span, as a track the length of the piece. */
export async function pictureTrack(file: string, from: number, to: number, end: number, out: string): Promise<string> {
  const blank = `${out}.blank.png`;
  await magick(["-size", `${W}x${H}`, "xc:none", `PNG32:${blank}`]);
  const states: Array<[string, number]> = [];
  if (frames(from) > 0) states.push([blank, frames(from)]);
  states.push([file, frames(Math.min(to, end)) - frames(from)]);
  if (frames(end) > frames(to)) states.push([blank, frames(end) - frames(to)]);
  return overlayTrack(states, out);
}

/**
 * The finished piece: overlays on the cut, the voice (or a song) over the
 * game-sound bed, -14 LUFS integrated and -1.5 dBTP.
 */
export async function mix(opts: { base: string; overlays: readonly string[]; voice: string | null; music: string | null; musicStart?: number; bed: string; bedDb: number; out: string; duration: number }): Promise<void> {
  const inputs = ["-i", opts.base, ...opts.overlays.flatMap((overlay) => ["-i", overlay])];
  const filters: string[] = [];
  let last = "0:v";
  opts.overlays.forEach((_, index) => {
    filters.push(`[${last}][${index + 1}:v]overlay=0:0:eof_action=pass[o${index}]`);
    last = `o${index}`;
  });
  let next = opts.overlays.length + 1;
  const lead = opts.voice ?? opts.music;
  inputs.push("-i", opts.bed);
  const bedIndex = next++;
  if (lead) {
    inputs.push(...(!opts.voice && opts.musicStart ? ["-ss", opts.musicStart.toFixed(3)] : []), "-i", lead);
    const leadIndex = next++;
    filters.push(`[${leadIndex}:a]aresample=48000,apad[lead]`);
    filters.push(`[${bedIndex}:a]volume=${opts.bedDb}dB[bed]`);
    filters.push(`[lead][bed]amix=inputs=2:duration=longest:normalize=0,atrim=0:${opts.duration.toFixed(4)},loudnorm=I=-14:TP=-1.5:LRA=11[a]`);
  } else {
    filters.push(`[${bedIndex}:a]atrim=0:${opts.duration.toFixed(4)},loudnorm=I=-14:TP=-1.5:LRA=11[a]`);
  }
  await ffmpeg([
    ...inputs, "-filter_complex", filters.join(";"), "-map", `[${last}]`, "-map", "[a]", "-t", opts.duration.toFixed(4),
    "-c:v", "libx264", "-crf", "17", "-preset", "slow", "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", opts.out,
  ]);
  // one-pass loudnorm lands within a couple of LU on spiky game sound: measure, then trim the gain under a -1.5 dBTP limiter
  const measured = await loudness(opts.out);
  if (measured && Math.abs(measured.lufs + 14) > 0.5) {
    const fixed = `${opts.out}.gain.mp4`;
    await ffmpeg(["-i", opts.out, "-af", `volume=${(-14 - measured.lufs).toFixed(2)}dB,alimiter=limit=0.84:level=disabled`, "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", fixed]);
    renameSync(fixed, opts.out);
  }
}

/** Mean motion per shot (the first frame of each shot, the cut itself, left out) and over the first second. */
export async function motionReport(video: string, frameCuts: readonly number[]): Promise<{ shots: number[]; freeze: number[]; firstSecond: number }> {
  const { ydif } = await signalStats(video);
  const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);
  const shots = frameCuts.slice(0, -1).map((start, index) => {
    const slice = ydif.slice(start + 1, frameCuts[index + 1]);
    return Math.round(mean(slice.length ? slice : ydif.slice(start, frameCuts[index + 1])) * 100) / 100;
  });
  // the longest run of (nearly) identical frames in each shot
  const freeze = frameCuts.slice(0, -1).map((start, index) => {
    let run = 0;
    let longest = 0;
    for (const value of ydif.slice(start + 1, frameCuts[index + 1])) {
      run = value < 0.25 ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
    return Math.round((longest / FPS) * 100) / 100;
  });
  return { shots, freeze, firstSecond: Math.round(mean(ydif.slice(1, FPS)) * 100) / 100 };
}

/** The cover: the frame with the most going on in the first two seconds' hook shot. */
export async function cover(video: string, at: number, out: string): Promise<string> {
  await ffmpeg(["-ss", at.toFixed(3), "-i", video, "-frames:v", "1", "-q:v", "2", out]);
  return out;
}

/**
 * Reference and ours side by side, synced on every beat: each reference
 * shot is stretched to the length of our matching shot. Our sound only;
 * the reference stays silent.
 */
export async function sideBySide(refFile: string, refBounds: readonly number[], ours: string, ourCuts: readonly number[], dir: string, out: string): Promise<string> {
  const pairs = Math.min(refBounds.length, ourCuts.length) - 1;
  const parts: string[] = [];
  for (let i = 0; i < pairs; i++) {
    const r0 = refBounds[i];
    const r1 = refBounds[i + 1];
    const n = frames(ourCuts[i + 1]) - frames(ourCuts[i]);
    if (n <= 0) continue;
    const factor = n / FPS / Math.max(0.04, r1 - r0);
    parts.push(`[s${parts.length}]trim=start=${r0.toFixed(3)}:end=${r1.toFixed(3)},setpts=(PTS-STARTPTS)*${factor.toFixed(5)},fps=${FPS},scale=540:960:force_original_aspect_ratio=decrease,pad=540:960:(ow-iw)/2:(oh-ih)/2,setsar=1,trim=end_frame=${n}[r${i}]`);
  }
  const labels = join(dir, "sbs_labels.png");
  await magick([
    "-size", "1080x960", "xc:none", "-font", fontFile("sans"), "-pointsize", "30", "-fill", "white", "-stroke", "black", "-strokewidth", "4",
    "-gravity", "northwest", "-annotate", "+20+16", "reference", "-annotate", "+560+16", "ours",
    "-stroke", "none", "-fill", "white", "-annotate", "+20+16", "reference", "-annotate", "+560+16", "ours", `PNG32:${labels}`,
  ]);
  const split = `[0:v]split=${parts.length}${parts.map((_, i) => `[s${i}]`).join("")}`;
  const concat = `${parts.map((part) => `[${/\[(r\d+)\]$/.exec(part)![1]}]`).join("")}concat=n=${parts.length}:v=1:a=0[ref]`;
  await ffmpeg([
    "-i", refFile, "-i", ours, "-loop", "1", "-i", labels,
    "-filter_complex", `${split};${parts.join(";")};${concat};[1:v]scale=540:960,setsar=1[our];[ref][our]hstack=inputs=2[pair];[pair][2:v]overlay=0:0:shortest=1[v]`,
    "-map", "[v]", "-map", "1:a", "-shortest", "-c:v", "libx264", "-crf", "21", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out,
  ]);
  return out;
}

/** A contact sheet: reference | ours at the middle of every shot, numbered. */
export async function contactSheet(refFile: string, refBounds: readonly number[], ours: string, ourCuts: readonly number[], dir: string, out: string): Promise<string> {
  const tmp = join(dir, "sheet_tmp");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const tiles: string[] = [];
  const pairs = Math.min(refBounds.length, ourCuts.length) - 1;
  for (let i = 0; i < pairs; i++) {
    const a = join(tmp, `a${i}.png`);
    const b = join(tmp, `b${i}.png`);
    const tile = join(tmp, `t${String(i).padStart(3, "0")}.png`);
    await ffmpeg(["-ss", ((refBounds[i] + refBounds[i + 1]) / 2).toFixed(3), "-i", refFile, "-frames:v", "1", "-vf", "scale=180:320:force_original_aspect_ratio=decrease,pad=180:320:(ow-iw)/2:(oh-ih)/2", a]);
    await ffmpeg(["-ss", ((ourCuts[i] + ourCuts[i + 1]) / 2).toFixed(3), "-i", ours, "-frames:v", "1", "-vf", "scale=180:320", b]);
    await magick([a, b, "+append", "-gravity", "north", "-background", "black", "-fill", "white", "-font", fontFile("sans"), "-pointsize", "18", "-splice", "0x24", "-annotate", "+0+2", `${i}: ${ourCuts[i].toFixed(2)} s`, tile]);
    tiles.push(tile);
  }
  await magick(["montage", ...tiles, "-tile", "6x", "-geometry", "+3+3", "-background", "#222222", "-depth", "8", "-quality", "85", out]);
  rmSync(tmp, { recursive: true, force: true });
  return out;
}
