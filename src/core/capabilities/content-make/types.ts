/**
 * The records content.make keeps in a piece's work folder. Each stage
 * writes one; a run that finds a stage's record (and its inputs unchanged)
 * skips that stage, so a stopped run picks up where it stopped.
 */

/** One beat of a reference, as Summer's reference library describes it. */
export interface RefBeat {
  t: [number, number];
  shot: string;
  vo: string;
  caption: string;
}

/** A reference from content.list_references (the fields the engine reads). */
export interface Reference {
  referenceId: string;
  title: string;
  url?: string;
  platform?: string;
  formatType?: string | null;
  format?: string;
  locked?: boolean;
  whyItPerforms?: string;
  howGamesCanUseIt?: string;
  hook?: string;
  captionStyle?: string;
  voPattern?: string;
  idea?: string | null;
  ideas?: Array<{ genre: string; idea: string }>;
  genres?: string[];
  stats?: { views?: number; likes?: number; postedAt?: string };
  breakoutRatio?: number;
  expiresAt?: string;
  beats?: RefBeat[];
}

export interface CaptionStyle {
  /** held: one line stays for its beats; words: the voice's words a few at a time; beats: each beat's own line. */
  mode: "held" | "words" | "beats";
  /** Most words on screen at once in words mode. */
  chunk: number;
  case: "lower" | "upper" | "sentence";
  /** Centre of the text block, as a share of the height. */
  y: number;
  color: string;
  /** The longest word of a chunk in this colour (words mode), or none. */
  highlight: string | null;
  font: "sans" | "rounded" | "serif";
  size: number;
  outline: boolean;
  /** Wrap the text in quote marks. */
  quoted: boolean;
}

export interface Study {
  referenceId: string;
  file: string;
  duration: number;
  width: number;
  height: number;
  /** Hard cuts, seconds. */
  cuts: number[];
  /** Shot index -> black (a black beat to copy). */
  black: boolean[];
  hasVoice: boolean;
  /** Seconds to the first hard cut. */
  firstCut: number;
  caption: CaptionStyle;
  music: boolean;
}

export interface FootageClip {
  path: string;
  kind: "video" | "image";
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  /** Mean motion (YDIF) per half second. */
  motion: number[];
  /** Mean brightness (0-255) per half second. */
  luma: number[];
  /** Search words: file and folder names, sidecar notes. */
  tags: string[];
  /** What happens in it, from a sidecar (shots.json or <clip>.json), when there is one. */
  about?: string;
}

export interface FootageIndex {
  clips: FootageClip[];
  music: string[];
}

/** One shot of the cut: a window of a clip, a still, or a colour (a black beat). */
export interface ShotSpec {
  src?: string;
  t?: number;
  speed?: number;
  cx?: number;
  cy?: number;
  z0?: number;
  z1?: number;
  color?: string;
  mute?: boolean;
  /** Why this shot (the reference shot it copies). */
  beat?: string;
}

export interface CaptionItem {
  text: string;
  from: number;
  to: number;
}

export interface Plan {
  version: 1;
  referenceId: string;
  contentGameId: string;
  title: string;
  format: string;
  /** Our words, one per reference beat ("" for none). Lines still marked TODO block the render. */
  lines: string[];
  /** The reference's own words per beat, for whoever writes ours (never rendered). */
  refLines: string[];
  /** Cut times, seconds, from 0 to the end. */
  cuts: number[];
  shots: ShotSpec[];
  caption: CaptionStyle;
  /** Held or beat captions; words mode builds its own from the voice. */
  captions: CaptionItem[];
  voice: { file: string | null; needed: boolean };
  /** The game's own song (never the reference's audio), from musicStart seconds in, and how loud the game's sound sits under it. */
  audio: { music: string | null; musicStart?: number; bedDb: number };
  /** Post caption per platform. */
  post: { caption: string; hashtags: string[]; title?: string };
  /** Shown under the player on Today (content.save_piece why). */
  why: { referenceId: string; fitReason: string; refStats: { views?: number; likes?: number; postedAt?: string }; commit?: { sha: string; title: string } };
  /** Pictures over the cut: a PNG (1080x1920, transparent) from one time to another. */
  overlays: Array<{ file: string; from: number; to: number }>;
}

export interface Check {
  /** The names Studio labels (content.save_piece checks). */
  name: "hook_time" | "lowest_motion" | "safe_zones" | "loudness" | "length" | "gameplay_seconds";
  value: string;
  pass: boolean;
  note?: string;
}
