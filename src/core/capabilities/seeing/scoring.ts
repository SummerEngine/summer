/**
 * Smart framing, part 2: score what each candidate pose would see. Pure and
 * engine-free; the inputs are the engine's measurements (thick-sweep
 * visibility codes, near-lens/low-angle adjustments, and a ray grid through
 * the frame with a class and a distance per cell).
 *
 * Terms (each 0..1): visibility, fill, thirds, horizon, sky, void, depth,
 * foreground. Weights depend on the shot type. Hard rejections (blocked by
 * walls/terrain, camera in geometry, subject out of frame, too much clutter)
 * never rank, but are counted by reason.
 */
import { SHOT_DEFAULTS, type Candidate, type ShotType } from "./candidates.js";
import {
  aabbCenter,
  distance,
  frameFill,
  horizonV,
  pitchOf,
  project,
  rayDirection,
  screenBox,
  type Aabb,
  type CameraPose,
  type Vec3,
} from "./math.js";

export const SCORE_TERMS = ["visibility", "fill", "thirds", "horizon", "sky", "void", "depth", "foreground", "clear", "balance", "detail", "contrast"] as const;
export type ScoreTerm = (typeof SCORE_TERMS)[number];

export interface ShotProfile {
  fillTarget: number;
  fillTolerance: number;
  sky: [number, number];
  foregroundTarget: number;
  foregroundMax: number;
  weights: Record<ScoreTerm, number>;
}

export const SHOT_PROFILES: Record<ShotType, ShotProfile> = {
  establishing: {
    fillTarget: SHOT_DEFAULTS.establishing.fill,
    fillTolerance: 0.22,
    sky: [0.12, 0.38],
    foregroundTarget: 0.08,
    foregroundMax: 0.3,
    weights: { visibility: 3, fill: 2, thirds: 1, horizon: 1, sky: 1, void: 1.5, depth: 1.5, foreground: 0.5, clear: 1, balance: 0, detail: 1.5, contrast: 0.75 },
  },
  eye_level: {
    fillTarget: SHOT_DEFAULTS.eye_level.fill,
    fillTolerance: 0.3,
    sky: [0.08, 0.35],
    foregroundTarget: 0.1,
    foregroundMax: 0.35,
    weights: { visibility: 2, fill: 1, thirds: 1, horizon: 1, sky: 1, void: 1.5, depth: 2, foreground: 0.5, clear: 1.5, balance: 0.5, detail: 1.5, contrast: 0.75 },
  },
  low_angle: {
    fillTarget: SHOT_DEFAULTS.low_angle.fill,
    fillTolerance: 0.22,
    sky: [0.2, 0.6],
    foregroundTarget: 0.08,
    foregroundMax: 0.3,
    weights: { visibility: 3, fill: 2, thirds: 1, horizon: 0.5, sky: 1.5, void: 1, depth: 0.5, foreground: 0.5, clear: 1, balance: 0, detail: 1.5, contrast: 0.75 },
  },
  detail: {
    fillTarget: SHOT_DEFAULTS.detail.fill,
    fillTolerance: 0.2,
    sky: [0, 0.12],
    foregroundTarget: 0.05,
    foregroundMax: 0.25,
    weights: { visibility: 3, fill: 2.5, thirds: 1, horizon: 0.5, sky: 0.5, void: 1, depth: 1, foreground: 0.3, clear: 1, balance: 0, detail: 1.5, contrast: 0.75 },
  },
  corridor: {
    fillTarget: 0,
    fillTolerance: 1,
    sky: [0.03, 0.3],
    foregroundTarget: 0.08,
    foregroundMax: 0.3,
    weights: { visibility: 3, fill: 0, thirds: 0, horizon: 1, sky: 1, void: 1, depth: 3, foreground: 0.5, clear: 2, balance: 1.5, detail: 1.5, contrast: 0.75 },
  },
};

/** What the engine measured for one candidate (seeing_probe.gd _measure_one). */
export interface Measurement {
  i: number;
  position: Vec3;
  look_at: Vec3;
  fov: number;
  rejected?: string;
  near_lens_hit?: string;
  adjustments?: Array<Record<string, unknown>>;
  /** One code per sample: V visible, F soft-occluded, H hard-blocked. */
  vis?: string;
  blockers_hard?: string[];
  blockers_soft?: string[];
  /** Row-major ray grid codes: "." nothing (sky/void), S subject, H hard, F soft. */
  grid?: string;
  /** Distance per grid cell, -1 for no hit. */
  dist?: number[];
  /** Image check (a small beauty render of the final pose), per grid cell:
   *  luminance decile and texture spread, "0" = featureless. */
  lum?: string;
  tex?: string;
}

export interface ScoringOptions {
  shot: ShotType;
  aspect: number;
  gridCols: number;
  gridRows: number;
  /** Subject bounds for fill/thirds/in-frame/depth; absent = no subject. */
  subject?: Aabb;
  maxHardFraction: number;
  maxSoftFraction: number;
}

export interface FrameStats {
  sky: number;
  void: number;
  subject: number;
  hard: number;
  soft: number;
  foreground: number;
  /** Fraction of non-subject, non-foreground cells hitting hard geometry no
   *  more than 40% beyond the subject: a flat wall right behind it. */
  wallBehind: number;
  /** Fraction of the frame covered by hard geometry right at the lens
   *  (closer than max(2.5 m, 15% of the subject distance)). */
  nearHard: number;
  /** Near-wall share in the left vs right half of the frame. */
  nearLeft: number;
  nearRight: number;
  /** Image check: share of the frame that renders featureless (sky excluded),
   *  and mean luminance decile of near vs far cells. */
  flat?: number;
  nearLum?: number;
  farLum?: number;
}

export interface ScoredCandidate {
  id: string;
  index: number;
  pose: CameraPose;
  total: number;
  terms: Partial<Record<ScoreTerm, number>>;
  rejected?: string;
  stats?: FrameStats;
  hardFraction?: number;
  softFraction?: number;
  fill?: number;
  inFrame?: number;
  adjustments?: Array<Record<string, unknown>>;
  blockers?: { hard?: string[]; soft?: string[]; lens?: string };
  note?: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function inRangeScore(value: number, [lo, hi]: [number, number], falloff = 0.25): number {
  if (value >= lo && value <= hi) return 1;
  const gap = value < lo ? lo - value : value - hi;
  return Math.max(0, 1 - gap / falloff);
}

export function foregroundScore(share: number, target: number, max: number): number {
  if (share <= target) return 0.6 + 0.4 * (target > 0 ? share / target : 1);
  if (share <= max) return 1 - (0.5 * (share - target)) / Math.max(1e-6, max - target);
  return Math.max(0, 0.5 - (share - max) * 2);
}

export function thirdsScore(pose: CameraPose, aspect: number, box: Aabb): number {
  const s = screenBox(pose, aspect, box);
  const cu = (s.u0 + s.u1) / 2;
  const cv = (s.v0 + s.v1) / 2;
  const wide = !(s.rawWidth <= 0.6);
  const tall = !(s.rawHeight <= 0.6);
  const horizontal = wide
    ? 1 - Math.min(1, Math.abs(cu - 0.5) * 2)
    : 1 - Math.min(1, Math.min(Math.abs(cu - 1 / 3), Math.abs(cu - 2 / 3)) / 0.17);
  const vertical = tall
    ? 1 - Math.min(1, Math.abs(cv - 0.5) * 2)
    : 1 - Math.min(1, Math.min(Math.abs(cv - 1 / 3), Math.abs(cv - 2 / 3), Math.abs(cv - 0.5) * 1.5) / 0.25);
  return 0.7 * horizontal + 0.3 * vertical;
}

/**
 * Poses are built with a level up vector, so roll is always zero (a level
 * horizon by construction); what is left to judge is where the horizon cuts
 * the frame. Eye-level and corridor shots are one-point perspective views
 * where a centered horizon is natural; elsewhere a horizon through the dead
 * center splits the frame in two and is marked down.
 */
export function horizonScore(pose: CameraPose, shot: ShotType = "establishing"): number {
  const v = horizonV(pitchOf(pose), pose.fov);
  if (shot === "eye_level" || shot === "corridor") return v === null ? 0.85 : 1;
  if (v === null) return 0.75;
  return 1 - 0.6 * Math.max(0, 1 - Math.abs(v - 0.5) / 0.1);
}

export function frameStats(m: Measurement, pose: CameraPose, opts: ScoringOptions): { stats: FrameStats; depth: number } {
  const grid = m.grid ?? "";
  const dists = m.dist ?? [];
  const total = Math.max(1, grid.length);
  const subjectDist = opts.subject && opts.shot !== "corridor" ? distance(pose.position, aabbCenter(opts.subject)) : undefined;
  let sky = 0;
  let voids = 0;
  let subject = 0;
  let hard = 0;
  let soft = 0;
  let foreground = 0;
  let wallBehind = 0;
  let nearHard = 0;
  let nearLeft = 0;
  let nearRight = 0;
  const nearLimit = Math.max(2.5, (subjectDist ?? 0) * 0.15);
  const sideLimit = Math.max(4, (subjectDist ?? 0) * 0.3);
  let depthSum = 0;
  let depthCount = 0;
  for (let k = 0; k < grid.length; k++) {
    const code = grid[k];
    const d = dists[k] ?? -1;
    const col = k % opts.gridCols;
    const row = Math.floor(k / opts.gridCols);
    if (code === ".") {
      const dir = rayDirection(pose, opts.aspect, (col + 0.5) / opts.gridCols, (row + 0.5) / opts.gridRows);
      if (dir[1] >= 0) {
        sky += 1;
        depthSum += 1;
        depthCount += 1;
      } else {
        voids += 1;
      }
      continue;
    }
    if (code === "S") {
      subject += 1;
      continue;
    }
    const isFront = subjectDist !== undefined ? d >= 0 && d < subjectDist * 0.75 : d >= 0 && d < 6;
    if (code === "F") {
      soft += 1;
      if (isFront) {
        foreground += 1;
        continue;
      }
    } else {
      hard += 1;
      if (d >= 0 && d < nearLimit) nearHard += 1;
      if (d >= 0 && d < sideLimit) {
        if (col < opts.gridCols / 2) nearLeft += 1;
        else nearRight += 1;
      }
    }
    if (d < 0) continue;
    if (subjectDist !== undefined) {
      const ratio = d / subjectDist;
      if (code === "H" && ratio >= 0.9 && ratio <= 1.4) wallBehind += 1;
      depthSum += Math.max(0, Math.min(1, ratio - 1));
    } else {
      depthSum += Math.max(0, Math.min(1, Math.log(Math.max(d, 1e-3) / 3) / Math.log(60 / 3)));
    }
    depthCount += 1;
  }
  // Image check: featureless cells (sky excluded) and value contrast near/far.
  let flat: number | undefined;
  let nearLum: number | undefined;
  let farLum: number | undefined;
  if (m.lum && m.tex && m.lum.length === grid.length && m.tex.length === grid.length) {
    const nearRef = subjectDist ?? 12;
    let flatCount = 0;
    let nearSum = 0;
    let nearN = 0;
    let farSum = 0;
    let farN = 0;
    for (let k = 0; k < grid.length; k++) {
      const code = grid[k];
      const d = dists[k] ?? -1;
      const col = k % opts.gridCols;
      const row = Math.floor(k / opts.gridCols);
      const isSky = code === "." && rayDirection(pose, opts.aspect, (col + 0.5) / opts.gridCols, (row + 0.5) / opts.gridRows)[1] >= 0;
      if (!isSky && m.tex[k] === "0") flatCount += 1;
      const lum = Number(m.lum[k]);
      if (code !== "." && d >= 0 && d < nearRef) {
        nearSum += lum;
        nearN += 1;
      } else if (code !== "." && d > nearRef * 2) {
        farSum += lum;
        farN += 1;
      }
    }
    flat = flatCount / total;
    if (nearN >= 3) nearLum = nearSum / nearN;
    if (farN >= 3) farLum = farSum / farN;
  }
  return {
    stats: {
      ...(flat !== undefined ? { flat } : {}),
      ...(nearLum !== undefined ? { nearLum } : {}),
      ...(farLum !== undefined ? { farLum } : {}),
      sky: sky / total,
      void: voids / total,
      subject: subject / total,
      hard: hard / total,
      soft: soft / total,
      foreground: foreground / total,
      wallBehind: wallBehind / total,
      nearHard: nearHard / total,
      nearLeft: nearLeft / total,
      nearRight: nearRight / total,
    },
    depth: depthCount ? depthSum / depthCount : 0.5,
  };
}

export function scoreMeasurement(m: Measurement, candidate: Candidate, opts: ScoringOptions): ScoredCandidate {
  const profile = SHOT_PROFILES[opts.shot];
  const pose: CameraPose = { position: m.position, look_at: m.look_at, fov: m.fov };
  const base: ScoredCandidate = {
    id: candidate.id,
    index: m.i,
    pose,
    total: 0,
    terms: {},
    ...(m.adjustments?.length ? { adjustments: m.adjustments } : {}),
    ...(candidate.note ? { note: candidate.note } : {}),
  };
  if (m.rejected) {
    return { ...base, rejected: m.rejected, ...(m.near_lens_hit ? { blockers: { lens: m.near_lens_hit } } : {}) };
  }
  const vis = m.vis ?? "";
  const n = vis.length;
  const hardCount = [...vis].filter((c) => c === "H").length;
  const softCount = [...vis].filter((c) => c === "F").length;
  const hardFraction = n ? hardCount / n : 0;
  const softFraction = n ? softCount / n : 0;
  const blockers = {
    ...(m.blockers_hard?.length ? { hard: m.blockers_hard } : {}),
    ...(m.blockers_soft?.length ? { soft: m.blockers_soft } : {}),
  };
  const withBlockers = Object.keys(blockers).length ? { blockers } : {};
  const { stats, depth } = frameStats(m, pose, opts);
  const terms: Partial<Record<ScoreTerm, number>> = {};
  if (n) terms.visibility = (n - hardCount - softCount + 0.6 * softCount) / n;
  let fill: number | undefined;
  let inFrame: number | undefined;
  if (opts.subject && opts.shot !== "corridor") {
    fill = frameFill(pose, opts.aspect, opts.subject);
    const fillValue = Number.isFinite(fill) ? fill : 3;
    terms.fill = Math.exp(-(((fillValue - profile.fillTarget) / profile.fillTolerance) ** 2));
    terms.thirds = thirdsScore(pose, opts.aspect, opts.subject);
    const samples = candidate.samples;
    inFrame = samples.length
      ? samples.filter((p) => {
          const q = project(pose, opts.aspect, p);
          return q.depth > 0 && q.u >= 0 && q.u <= 1 && q.v >= 0 && q.v <= 1;
        }).length / samples.length
      : 1;
  }
  terms.horizon = horizonScore(pose, opts.shot);
  terms.sky = inRangeScore(stats.sky, profile.sky);
  terms.void = 1 - Math.min(1, stats.void / 0.12);
  terms.depth = depth;
  terms.foreground = foregroundScore(stats.foreground, profile.foregroundTarget, profile.foregroundMax);
  // A wall at the lens is not framing; it is a blocked view.
  terms.clear = 1 - Math.min(1, stats.nearHard / 0.3);
  // Corridors and street views read best with walls on both sides as leading
  // lines rather than one wall eating half the frame.
  const sides = stats.nearLeft + stats.nearRight;
  terms.balance = sides < 0.02 ? 1 : 1 - Math.abs(stats.nearLeft - stats.nearRight) / sides;
  // From the image check, when the engine rendered one: no empty
  // (featureless) frame areas, and values that separate near from far.
  if (stats.flat !== undefined) terms.detail = 1 - Math.min(1, stats.flat / 0.3);
  if (stats.nearLum !== undefined && stats.farLum !== undefined) terms.contrast = Math.min(1, Math.abs(stats.nearLum - stats.farLum) / 2);

  let rejected: string | undefined;
  if (n && hardFraction > opts.maxHardFraction) rejected = "hard_blocked";
  else if (n && opts.shot !== "corridor" && vis[0] === "H") rejected = "hard_blocked";
  else if (n && opts.shot === "corridor" && vis[0] === "H") rejected = "hard_blocked";
  else if (inFrame !== undefined && inFrame < 0.5) rejected = "subject_out_of_frame";
  else if (n && softFraction > opts.maxSoftFraction) rejected = "soft_overload";
  else if (stats.foreground > 0.5) rejected = "soft_overload";

  let weighted = 0;
  let weights = 0;
  for (const term of SCORE_TERMS) {
    const value = terms[term];
    const w = profile.weights[term];
    if (value === undefined || !w) continue;
    weighted += w * value;
    weights += w;
  }
  const total = weights ? weighted / weights : 0;
  const rounded: Partial<Record<ScoreTerm, number>> = {};
  for (const term of SCORE_TERMS) if (terms[term] !== undefined) rounded[term] = r2(terms[term]!);
  return {
    ...base,
    total: r2(total),
    terms: rounded,
    stats: {
      ...(stats.flat !== undefined ? { flat: r2(stats.flat) } : {}),
      ...(stats.nearLum !== undefined ? { nearLum: r2(stats.nearLum) } : {}),
      ...(stats.farLum !== undefined ? { farLum: r2(stats.farLum) } : {}),
      sky: r2(stats.sky),
      void: r2(stats.void),
      subject: r2(stats.subject),
      hard: r2(stats.hard),
      soft: r2(stats.soft),
      foreground: r2(stats.foreground),
      wallBehind: r2(stats.wallBehind),
      nearHard: r2(stats.nearHard),
      nearLeft: r2(stats.nearLeft),
      nearRight: r2(stats.nearRight),
    },
    hardFraction: r2(hardFraction),
    softFraction: r2(softFraction),
    ...(fill !== undefined ? { fill: Number.isFinite(fill) ? r2(fill) : 99 } : {}),
    ...(inFrame !== undefined ? { inFrame: r2(inFrame) } : {}),
    ...(rejected ? { rejected } : {}),
    ...withBlockers,
  };
}

/** Top `count` non-rejected candidates, skipping near-duplicates (camera
 *  within `minSeparation` m AND looking within 12 degrees of a better pick). */
export function pickTop(scored: readonly ScoredCandidate[], count: number, minSeparation: number): ScoredCandidate[] {
  const ranked = scored.filter((s) => !s.rejected).sort((a, b) => b.total - a.total);
  const picks: ScoredCandidate[] = [];
  for (const s of ranked) {
    const dup = picks.some((p) => {
      const sep = distance(p.pose.position, s.pose.position);
      const fa = directionOf(p.pose);
      const fb = directionOf(s.pose);
      const cos = fa[0] * fb[0] + fa[1] * fb[1] + fa[2] * fb[2];
      return sep < minSeparation && cos > Math.cos((12 * Math.PI) / 180);
    });
    if (!dup) picks.push(s);
    if (picks.length >= count) break;
  }
  return picks;
}

function directionOf(pose: CameraPose): Vec3 {
  const d: Vec3 = [pose.look_at[0] - pose.position[0], pose.look_at[1] - pose.position[1], pose.look_at[2] - pose.position[2]];
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return [d[0] / l, d[1] / l, d[2] / l];
}

export function rejectionCounts(scored: readonly ScoredCandidate[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of scored) if (s.rejected) out[s.rejected] = (out[s.rejected] ?? 0) + 1;
  return out;
}
