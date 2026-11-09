import type { CaptionItem, CaptionStyle, Check, FootageClip, Plan, RefBeat, Reference, ShotSpec, Study } from "./types.js";

/**
 * The judgment content.make makes without a model, all of it deterministic:
 * which reference fits today, how the reference's captions look, which
 * clip window plays each reference shot, where the cuts land under our
 * voice, and whether the render passes its checks. Same inputs, same plan.
 */

const STOP = new Set(
  ("game games play plays player players playing make makes made keep show shows clip clips video videos shot shots thing things way time first last every still much many need needs want using use used "+
  "the and for with you your this that from into over then than they them their there what when where which while will just like have has had are was were been being its it's our out off one two all any can not but get got lot new now very more most some such only also each other about after before again under onto upon here how why who too own same so if or of on in at to by an a as is be do").split(" ")
);

/** Search words of a text: lowercase, letters and digits, three or more characters, no filler. */
export function wordsOf(text: string | undefined | null): string[] {
  if (!text) return [];
  return [...new Set(text.toLowerCase().replace(/['’]s\b/g, "").split(/[^a-z0-9]+/).filter((word) => word.length >= 3 && !STOP.has(word)))];
}

/** True when the reference speaks (a voice-over or a talking host), not only captions and music. */
export function refHasVoice(ref: Pick<Reference, "beats" | "voPattern">): boolean {
  if (/^(no voice|caption only|caption-only|music only|no vo)/i.test((ref.voPattern ?? "").trim())) return false;
  return (ref.beats ?? []).some((beat) => beat.vo.trim().length > 0);
}

export interface PickContext {
  usedReferenceIds: ReadonlySet<string>;
  usedFormats: ReadonlySet<string>;
  niches: readonly string[];
  /** The game's recent commits (what changed today); a brief from the caller comes first, without a sha. */
  commits: ReadonlyArray<{ sha?: string; title: string }>;
  /** A voice-over in the team's voice is at hand (voiceFile). */
  voiceReady: boolean;
  today: string;
}

export interface RefPick {
  ref: Reference;
  score: number;
  /** One line on why it fits today, for the person ("You shipped ... today (commit 3f2a1c)"). */
  fitReason: string;
  /** The change it fits, when one does. */
  commit?: { sha: string; title: string };
}

/** Scores one reference for today; null when it cannot be used (locked, expired, no beats, already made). */
export function scoreReference(ref: Reference, ctx: PickContext): RefPick | null {
  if (ref.locked || !ref.beats?.length) return null;
  if (ctx.usedReferenceIds.has(ref.referenceId)) return null;
  if (ref.expiresAt && ref.expiresAt < ctx.today) return null;
  const format = ref.formatType ?? ref.format ?? "";
  const reasons: string[] = [];
  let score = 0;
  if (format && !ctx.usedFormats.has(format)) {
    score += 3;
    reasons.push(`a format this game has not posted yet (${format})`);
  }
  const genres = (ref.genres ?? []).filter((genre) => ctx.niches.includes(genre));
  score += Math.min(2, genres.length * 0.5);
  if (ref.breakoutRatio && ref.breakoutRatio > 1) score += Math.log10(ref.breakoutRatio);
  if (ref.stats?.postedAt) {
    const days = (Date.parse(ctx.today) - Date.parse(ref.stats.postedAt)) / 86_400_000;
    if (days <= 30) score += 1;
  }
  const refWords = new Set(wordsOf([ref.title, ref.howGamesCanUseIt, ref.idea, ...(ref.ideas ?? []).map((idea) => idea.idea)].join(" ")));
  let best: { commit: { sha?: string; title: string }; hits: string[] } | null = null;
  for (const commit of ctx.commits) {
    const hits = wordsOf(commit.title).filter((word) => refWords.has(word));
    if (hits.length && (!best || hits.length > best.hits.length)) best = { commit, hits };
  }
  if (best) {
    score += Math.min(2, best.hits.length * 0.5);
    reasons.unshift(best.commit.sha ? `You shipped "${best.commit.title}" today (commit ${best.commit.sha.slice(0, 7)})` : `It fits what you asked for: "${best.commit.title}"`);
  }
  if (refHasVoice(ref) && !ctx.voiceReady) score -= 2;
  if (ref.breakoutRatio) reasons.push(`it got ${Math.round(ref.breakoutRatio)}x its account's usual views`);
  const fitReason = (reasons.join("; ") || "The best fit in today's references").replace(/^./, (c) => c.toUpperCase()).slice(0, 300);
  return {
    ref,
    score: Math.round(score * 100) / 100,
    fitReason,
    ...(best?.commit.sha ? { commit: { sha: best.commit.sha, title: best.commit.title } } : {}),
  };
}

/** The best reference for today, ties broken by id so the same inputs give the same pick. */
export function pickReference(refs: readonly Reference[], ctx: PickContext): RefPick | null {
  const scored = refs.map((ref) => scoreReference(ref, ctx)).filter((pick): pick is RefPick => pick !== null);
  scored.sort((a, b) => b.score - a.score || a.ref.referenceId.localeCompare(b.ref.referenceId));
  return scored[0] ?? null;
}

const COLORS: Array<[RegExp, string]> = [
  [/yellow|gold/, "#FFD60A"],
  [/lavender|lilac/, "#B8A2FF"],
  [/pink/, "#FF8FC8"],
  [/red/, "#FF3B30"],
  [/cyan|light blue/, "#5AD8FF"],
  [/green/, "#4CD964"],
  [/orange/, "#FF9500"],
  [/cream/, "#FFF4C4"],
  [/white/, "#FFFFFF"],
];

function firstColor(text: string): string | null {
  let best: { at: number; hex: string } | null = null;
  for (const [pattern, hex] of COLORS) {
    const at = text.search(pattern);
    if (at >= 0 && (!best || at < best.at)) best = { at, hex };
  }
  return best?.hex ?? null;
}

/**
 * The reference's caption look, read from its plain-words description:
 * where it sits, its case, colour, font kind, and whether it holds one
 * line or follows the voice word by word.
 */
export function parseCaptionStyle(captionStyle: string | undefined, hasVoice: boolean): CaptionStyle {
  const text = (captionStyle ?? "").toLowerCase();
  const head = text.split(/[.;]/)[0] ?? text;
  const y = /top third|top-centre|top center|top-center|at the top|upper third|over the sky|top of the frame|\btop\b/.test(text)
    ? 0.25
    : /upper-middle|upper middle|20% from the top/.test(text)
      ? 0.3
      : /below the middle|centre-low|center-low|lower third|lower half|lower-middle/.test(text)
        ? 0.6
        : /bottom/.test(text)
          ? 0.68
          : 0.45;
  const wordByWord = /one word at a time|word by word|word-by-word|1 to 3 words|1-3 words|2-3 words|2 to 3 words|in sync with the voice|spoken word/.test(text);
  const held = /static|whole clip|stays|held|fixed for|on screen 0\.0|the whole time|never changes/.test(text);
  const mode: CaptionStyle["mode"] = hasVoice && (wordByWord || !held) ? "words" : held || !hasVoice ? "held" : "beats";
  const chunk = /one word at a time|single word/.test(text) ? 1 : /2-3 words|2 to 3 words|1 to 3 words|1-3 words/.test(text) ? 3 : 3;
  const highlightMatch = /(spoken|key|one|last) words? (turns?|in|pops?)[^.]*?(yellow|gold|red|cyan|green|orange|pink)/.exec(text);
  const highlight = highlightMatch ? firstColor(highlightMatch[3]) : null;
  return {
    mode,
    chunk,
    case: /lower ?case|lowercase|lower case/.test(text) ? "lower" : /capitals|\bcaps\b|upper ?case|uppercase|all caps/.test(text) ? "upper" : "sentence",
    y,
    color: firstColor(head) ?? "#FFFFFF",
    highlight,
    font: /serif/.test(text) && !/sans/.test(head) ? "serif" : /rounded/.test(text) ? "rounded" : "sans",
    size: mode === "words" ? 100 : 84,
    outline: !/no outline|without outline/.test(text),
    quoted: /quote marks|in quotes|inside quote/.test(text),
  };
}

/** Piecewise-linear map of reference times onto our timeline between matching anchors. */
export function mapTimes(times: readonly number[], refAnchors: readonly number[], ourAnchors: readonly number[]): number[] {
  return times.map((t) => {
    for (let i = 0; i < refAnchors.length - 1; i++) {
      const a = refAnchors[i];
      const b = refAnchors[i + 1];
      if ((t >= a && t <= b) || i === refAnchors.length - 2) {
        const k = (ourAnchors[i + 1] - ourAnchors[i]) / (b - a || 1);
        return Math.round((ourAnchors[i] + (t - a) * k) * 1000) / 1000;
      }
    }
    return t;
  });
}

export interface Word {
  w: string;
  s: number;
  e: number;
}

/** Caption chunks of up to max words, broken at punctuation or a pause. */
export function chunkWords(words: readonly Word[], max = 3, gap = 0.25): Word[][] {
  const chunks: Word[][] = [];
  let current: Word[] = [];
  words.forEach((word, index) => {
    current.push(word);
    const next = words[index + 1];
    const pause = next ? next.s - word.e : 9;
    if (current.length >= max || /[.,?!]$/.test(word.w) || pause > gap || !next) {
      chunks.push(current);
      current = [];
    }
  });
  return chunks;
}

const norm = (word: string) => word.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Our script words on the times Whisper heard: matching words take their
 * time; a run Whisper heard differently shares the span it took.
 */
export function alignScript(script: readonly string[], heard: readonly Word[]): Word[] {
  const out: Word[] = [];
  let j = 0;
  for (let i = 0; i < script.length; i++) {
    const target = norm(script[i]);
    let found = -1;
    for (let k = j; k < Math.min(heard.length, j + 6); k++) {
      if (norm(heard[k].w) === target) {
        found = k;
        break;
      }
    }
    if (found >= 0) {
      out.push({ w: script[i], s: heard[found].s, e: heard[found].e });
      j = found + 1;
    } else {
      const at = heard[Math.min(j, heard.length - 1)];
      const prevEnd = out.length ? out[out.length - 1].e : 0;
      const s = at ? Math.max(prevEnd, at.s) : prevEnd;
      out.push({ w: script[i], s, e: at ? Math.max(s, at.e) : s });
      if (at && norm(at.w).length <= target.length) j++;
    }
  }
  return out;
}

/** Start time of each non-empty line in the aligned words (null for an empty line). */
export function lineStarts(lines: readonly string[], aligned: readonly Word[]): Array<number | null> {
  const starts: Array<number | null> = [];
  let index = 0;
  for (const line of lines) {
    const count = line.split(/\s+/).filter(Boolean).length;
    starts.push(count ? aligned[index]?.s ?? null : null);
    index += count;
  }
  return starts;
}

/** Our cut times under a voice-over: the reference's beat starts land on the starts of our matching lines. */
export function voiceAnchors(beats: readonly RefBeat[], starts: ReadonlyArray<number | null>, refDuration: number, voiceEnd: number): { ref: number[]; ours: number[] } {
  const ref = [0];
  const ours = [0];
  beats.forEach((beat, index) => {
    const start = starts[index];
    if (start === null || start === undefined || index === 0) return;
    const r = beat.t[0];
    const o = Math.max(0, start - 0.05);
    if (r > ref[ref.length - 1] + 0.05 && o > ours[ours.length - 1] + 0.05) {
      ref.push(r);
      ours.push(o);
    }
  });
  const lastVoiced = [...beats].reverse().find((beat) => beat.vo.trim());
  const tail = Math.max(0.4, refDuration - (lastVoiced?.t[1] ?? refDuration));
  ref.push(refDuration);
  ours.push(Math.max(ours[ours.length - 1] + 0.5, voiceEnd + tail));
  return { ref, ours };
}

const STILL_WORDS = /\b(card|cards|page|pages|photo|picture|poster|portrait|still|slide|carousel|screenshot)\b/;

function clipScore(clip: FootageClip, words: readonly string[]): number {
  const tags = new Set(clip.tags);
  return words.filter((word) => tags.has(word)).length;
}

function meanOf(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

/** The window of a clip with the most motion, outside the ranges already used, not too dark. */
export function bestWindow(clip: FootageClip, seconds: number, used: ReadonlyArray<[number, number]>, after = 0): { t: number; motion: number; clean: boolean } {
  if (clip.kind === "image" || !clip.motion.length) return { t: 0, motion: 0, clean: true };
  const half = 0.5;
  const span = Math.max(1, Math.ceil(seconds / half));
  const positions = Math.max(1, Math.floor((clip.duration - seconds) / half + 1e-6) + 1);
  let best = { t: 0, score: -Infinity, motion: 0, clean: false };
  for (let i = 0; i < positions; i++) {
    const t = i * half;
    const overlaps = used.some(([a, b]) => t < b - 0.05 && t + seconds > a + 0.05);
    const motion = meanOf(clip.motion.slice(i, i + span));
    const light = clip.luma.slice(i, i + span);
    // black screens and white flashes (loading, a burst filling the frame) are not shots
    const dark = meanOf(light) < 12 || Math.max(...light, 0) > 140;
    // a frozen half second (a capture hitch, an idle tail) reads as a still frame on screen
    const frozen = clip.motion.slice(i, i + span).filter((value) => value < 0.4).length;
    const score = motion - (overlaps ? 100 : 0) - (dark ? 50 : 0) - frozen * 1.5 - (t + 0.01 < after ? 1.5 : 0);
    if (score > best.score) best = { t, score, motion, clean: !overlaps && !dark && frozen === 0 };
  }
  return { t: best.t, motion: best.motion, clean: best.clean };
}

export interface BeatMapInput {
  study: Pick<Study, "cuts" | "duration" | "black">;
  beats: readonly RefBeat[];
  lines: readonly string[];
  clips: readonly FootageClip[];
  /** Our cut times (the reference's, or mapped under our voice). */
  cuts: readonly number[];
  /** What the piece is about (the make's brief): weighs every beat's clip choice. */
  brief?: string;
}

/**
 * Which clip window plays each reference shot. One player's story: the
 * clip that fits the most beats leads, and its windows move forward in
 * time; a beat about cards or pages takes stills when there are any; a
 * fast run of cuts never shows the same clip twice in a row; a reference
 * black beat stays black.
 */
export function beatMap(input: BeatMapInput): ShotSpec[] {
  const { study, beats, lines, clips, cuts } = input;
  if (!clips.length) return [];
  const bounds = [0, ...study.cuts, study.duration];
  const beatOf = (t: number) => Math.max(0, beats.findIndex((beat) => t >= beat.t[0] && t < beat.t[1]));
  const beatWords = beats.map((beat, index) => wordsOf(`${beat.shot} ${lines[index] ?? ""} ${input.brief ?? ""}`));
  const total = cuts[cuts.length - 1];
  const lead = [...clips]
    .filter((clip) => clip.kind === "video")
    .map((clip) => ({ clip, score: beatWords.reduce((sum, words) => sum + clipScore(clip, words), 0) + meanOf(clip.motion) * 0.1 + (clip.duration >= Math.min(total, 8) ? 1 : 0) }))
    .sort((a, b) => b.score - a.score || a.clip.path.localeCompare(b.clip.path))[0]?.clip;
  const used = new Map<string, Array<[number, number]>>();
  const lastEnd = new Map<string, number>();
  const shots: ShotSpec[] = [];
  let previous: { clip: FootageClip; end: number; beat: number } | null = null;
  for (let i = 0; i < cuts.length - 1; i++) {
    const seconds = cuts[i + 1] - cuts[i];
    const refMid = (bounds[i] + bounds[Math.min(i + 1, bounds.length - 1)]) / 2;
    const beatIndex = beatOf(refMid);
    const beat = beats[beatIndex];
    if (study.black[i]) {
      shots.push({ color: "black", beat: `ref shot ${i}: black` });
      previous = null;
      continue;
    }
    const wantsStill = STILL_WORDS.test((beat?.shot ?? "").toLowerCase()) && clips.some((clip) => clip.kind === "image");
    const fast = seconds < 0.7;
    const candidates = clips
      .filter((clip) => (wantsStill ? clip.kind === "image" : clip.kind === "video" || !clips.some((other) => other.kind === "video")))
      .map((clip) => {
        let score = clipScore(clip, beatWords[beatIndex] ?? []);
        if (clip === lead) score += 0.75;
        // a long take runs on within its beat; a still or a fast cut never repeats
        if (previous && previous.clip === clip) score += !fast && clip.kind === "video" && previous.beat === beatIndex ? 1 : -2;
        if (clip.kind === "video" && clip.duration < seconds) score -= 1;
        score -= (used.get(clip.path)?.length ?? 0) * (fast ? 0.6 : 0.25);
        return { clip, score };
      })
      .sort((a, b) => b.score - a.score || a.clip.path.localeCompare(b.clip.path));
    const clip = candidates[0]?.clip ?? clips[0];
    const ranges = used.get(clip.path) ?? [];
    let t: number;
    if (previous && previous.clip === clip && previous.beat === beatIndex && previous.end + seconds <= clip.duration + 0.05) t = previous.end;
    else t = bestWindow(clip, seconds, ranges, clip === lead ? lastEnd.get(clip.path) ?? 0 : 0).t;
    t = Math.round(t * 100) / 100;
    ranges.push([t, t + seconds]);
    used.set(clip.path, ranges);
    lastEnd.set(clip.path, Math.max(lastEnd.get(clip.path) ?? 0, t + seconds));
    const still = clip.kind === "image";
    const long = seconds >= 1.2;
    shots.push({
      src: clip.path,
      t,
      ...(still ? { z0: 1, z1: 1.08 } : long ? { z0: 1, z1: 1.05 } : {}),
      beat: `ref shot ${i} (${beat ? beat.shot.slice(0, 80) : "no beat"})`,
    });
    previous = { clip, end: t + seconds, beat: beatIndex };
  }
  return shots;
}

/** Held or per-beat captions from our lines: consecutive beats sharing the reference's caption share one line. */
export function beatCaptions(beats: readonly RefBeat[], lines: readonly string[], cuts: readonly number[], refBounds: readonly number[], mode: CaptionStyle["mode"]): CaptionItem[] {
  if (mode === "words") return [];
  const toOurs = (t: number) => mapTimes([t], refBounds, cuts)[0];
  const items: CaptionItem[] = [];
  let open: CaptionItem | null = null;
  beats.forEach((beat, index) => {
    const text = (lines[index] ?? "").trim();
    const from = toOurs(beat.t[0]);
    const to = toOurs(beat.t[1]);
    const sameAsBefore = index > 0 && beat.caption.trim() !== "" && beats[index - 1].caption.trim() === beat.caption.trim();
    // a held line runs on through the beats that repeat the reference's caption (their own line left empty)
    if (open && sameAsBefore && (mode === "held" || !text)) {
      open.to = to;
      return;
    }
    open = null;
    if (!beat.caption.trim() || !text) return;
    open = { text, from, to };
    items.push(open);
  });
  return items;
}

/** Lines still to write: the reference's own words stay out of our output. */
export function unwrittenLines(plan: Pick<Plan, "lines">): number[] {
  return plan.lines.map((line, index) => (/^TODO\b/.test(line.trim()) ? index : -1)).filter((index) => index >= 0);
}

export interface CheckInput {
  shotMotion: readonly number[];
  /** Longest run of frozen frames in each shot, seconds. */
  shotFreeze?: readonly number[];
  shotKinds: ReadonlyArray<"video" | "still" | "black">;
  shotSeconds: readonly number[];
  /** Mean motion over the first second. */
  firstSecondMotion: number;
  /** Seconds to the first caption or voice (null: none). */
  firstWords: number | null;
  refFirstWords: number | null;
  length: number;
  refLength: number;
  loudness: { lufs: number; truePeak: number } | null;
  /** Caption boxes as shares of the frame: [left, top, right, bottom]. */
  captionBoxes: ReadonlyArray<[number, number, number, number]>;
}

/** The safe area for text: clear of the top bar, the right-hand buttons and the caption block at the bottom. */
export const SAFE = { left: 0.06, top: 0.1, right: 0.86, bottom: 0.76 };

/** A shot may hold still this long (a beat of a held pose); longer reads as a frozen picture. */
export const FREEZE_LIMIT = 0.8;

/** The measured checks every piece shows next to it. */
export function evaluateChecks(input: CheckInput): Check[] {
  const moving = input.shotMotion.filter((_, index) => input.shotKinds[index] === "video");
  const minMotion = moving.length ? Math.min(...moving) : 0;
  const lowShots = input.shotMotion.map((value, index) => (input.shotKinds[index] === "video" && (value < 2 || (input.shotFreeze?.[index] ?? 0) > FREEZE_LIMIT) ? index : -1)).filter((index) => index >= 0);
  const hookOk = input.firstSecondMotion >= 2 && (input.refFirstWords === null || (input.firstWords !== null && input.firstWords <= Math.max(0.5, input.refFirstWords + 0.3)));
  const outside = input.captionBoxes.filter(([l, t, r, b]) => l < SAFE.left || t < SAFE.top || r > SAFE.right || b > SAFE.bottom).length;
  const lengthOk = Math.abs(input.length - input.refLength) <= Math.max(1, input.refLength * 0.12);
  const gameplay = input.shotSeconds.reduce((sum, seconds, index) => sum + (input.shotKinds[index] === "video" ? seconds : 0), 0);
  const round = (value: number) => Math.round(value * 100) / 100;
  const seconds = (value: number) => `${value.toFixed(1)} s`;
  const checks: Check[] = [
    {
      name: "hook_time",
      value: input.firstWords === null ? "no words" : seconds(input.firstWords),
      pass: hookOk,
      note: `motion ${round(input.firstSecondMotion)} in the first second${input.refFirstWords === null ? "" : `; the reference's words start at ${round(input.refFirstWords)} s`}`,
    },
    { name: "lowest_motion", value: `${round(minMotion)} YDIF`, pass: lowShots.length === 0, note: lowShots.length ? `still or frozen shots: ${lowShots.join(", ")}` : `every shot moves (YDIF >= 2, no freeze over ${FREEZE_LIMIT} s)` },
    { name: "safe_zones", value: outside ? `${outside} outside` : "inside", pass: outside === 0 },
    { name: "length", value: seconds(input.length), pass: lengthOk, note: `the reference runs ${seconds(input.refLength)}` },
    { name: "gameplay_seconds", value: seconds(gameplay), pass: gameplay >= 2 },
  ];
  if (input.loudness) {
    const { lufs, truePeak } = input.loudness;
    checks.push({ name: "loudness", value: `${lufs.toFixed(1)} LUFS, ${truePeak.toFixed(1)} dBTP`, pass: lufs >= -15.5 && lufs <= -12.5 && truePeak <= -0.5 });
  }
  return checks;
}

/**
 * Where to start the song so the most cuts land on its beats: tries every
 * start (0.01 s steps) and counts cuts within 70 ms of an onset. Ties go to
 * the start closest to the beats, then the earliest.
 */
export function musicStart(onsets: readonly number[], cuts: readonly number[], songLength: number): { start: number; hits: number } {
  const inner = cuts.slice(1, -1);
  const length = cuts[cuts.length - 1] ?? 0;
  let best = { start: 0, hits: -1, off: Infinity };
  for (let step = 0; step * 0.01 + length <= songLength + 1e-6; step++) {
    const start = step / 100;
    let hits = 0;
    let off = 0;
    let j = 0;
    for (const cut of inner) {
      const t = cut + start;
      while (j < onsets.length && onsets[j] < t - 0.07) j++;
      if (j < onsets.length && Math.abs(onsets[j] - t) <= 0.07) {
        hits++;
        off += Math.abs(onsets[j] - t);
      }
    }
    if (hits > best.hits || (hits === best.hits && off < best.off - 1e-9)) best = { start, hits, off };
  }
  return { start: best.start, hits: Math.max(0, best.hits) };
}

/** Moves each cut onto the song's nearest onset within reach (70 ms), keeping every shot at least 0.1 s. */
export function snapCuts(cuts: readonly number[], onsets: readonly number[], start: number, reach = 0.07): number[] {
  const out = [...cuts];
  for (let i = 1; i < out.length - 1; i++) {
    const t = out[i] + start;
    let nearest: number | null = null;
    for (const onset of onsets) if (Math.abs(onset - t) <= reach && (nearest === null || Math.abs(onset - t) < Math.abs(nearest - t))) nearest = onset;
    if (nearest === null) continue;
    const moved = Math.round((nearest - start) * 1000) / 1000;
    if (moved - out[i - 1] >= 0.1 && out[i + 1] - moved >= 0.1) out[i] = moved;
  }
  return out;
}
