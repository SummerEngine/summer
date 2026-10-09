/**
 * Smart framing, part 2: score what each candidate pose would see. Pure and
 * engine-free; the inputs are the engine's measurements (thick-sweep
 * visibility codes, near-lens/low-angle adjustments, and a ray grid through
 * the frame with a class and a distance per cell).
 *
 * Terms (each 0..1): visibility, fill, thirds, horizon, sky, void, depth,
 * foreground, clear, balance, detail, contrast, entry, solid (no surfaces
 * seen from behind), light (key-light direction) and edge (no world edge
 * below the horizon). Weights depend on the shot type. Hard rejections
 * (blocked by walls/terrain, camera behind or inside a surface, camera in
 * geometry, subject out of frame, too much clutter, an eye-level or corridor
 * camera off eye height) never rank, but are counted by reason. Establishing
 * shots rank in tiers: a pose that shows more than EMPTY_LIMIT empty ground or
 * world edge ranks below every pose that shows less, whatever the weights.
 */
import { SHOT_DEFAULTS, type Candidate, type ShotType } from "./candidates.js";
import {
  aabbCenter,
  clamp,
  deg,
  distance,
  frameFill,
  horizonV,
  pitchOf,
  project,
  rayDirection,
  screenBox,
  normalize,
  sub,
  type Aabb,
  type CameraPose,
  type Vec3,
} from "./math.js";

export const SCORE_TERMS = ["visibility", "fill", "thirds", "horizon", "sky", "void", "depth", "foreground", "clear", "balance", "detail", "contrast", "entry", "solid", "light", "edge"] as const;
export type ScoreTerm = (typeof SCORE_TERMS)[number];

export interface ShotProfile {
  fillTarget: number;
  fillTolerance: number;
  sky: [number, number];
  foregroundTarget: number;
  foregroundMax: number;
  weights: Record<ScoreTerm, number>;
  /** Tier rule: a pose whose empty share (world edge + empty ground) is over
   *  this ranks below every pose at or under it. */
  emptyLimit?: number;
}

/** Establishing: "about 15%" empty ground or world edge is decisive. */
export const EMPTY_LIMIT = 0.15;

export const SHOT_PROFILES: Record<ShotType, ShotProfile> = {
  establishing: {
    fillTarget: SHOT_DEFAULTS.establishing.fill,
    fillTolerance: 0.22,
    sky: [0.12, 0.38],
    foregroundTarget: 0.08,
    foregroundMax: 0.3,
    weights: { visibility: 3, fill: 2, thirds: 1, horizon: 1, sky: 1, void: 1.5, depth: 1.5, foreground: 0.5, clear: 1, balance: 0, detail: 1.5, contrast: 0.75, entry: 0, solid: 2, light: 1.25, edge: 2 },
    emptyLimit: EMPTY_LIMIT,
  },
  eye_level: {
    fillTarget: SHOT_DEFAULTS.eye_level.fill,
    fillTolerance: 0.3,
    sky: [0.08, 0.35],
    foregroundTarget: 0.1,
    foregroundMax: 0.35,
    weights: { visibility: 2, fill: 1, thirds: 1, horizon: 1, sky: 1, void: 1.5, depth: 2, foreground: 0.5, clear: 1.5, balance: 0.5, detail: 1.5, contrast: 0.75, entry: 0, solid: 2, light: 0.5, edge: 1 },
  },
  low_angle: {
    fillTarget: SHOT_DEFAULTS.low_angle.fill,
    fillTolerance: 0.22,
    sky: [0.2, 0.6],
    foregroundTarget: 0.08,
    foregroundMax: 0.3,
    weights: { visibility: 3, fill: 2, thirds: 1, horizon: 0.5, sky: 1.5, void: 1, depth: 0.5, foreground: 0.5, clear: 1, balance: 0, detail: 1.5, contrast: 0.75, entry: 0, solid: 2, light: 0.75, edge: 1 },
  },
  detail: {
    fillTarget: SHOT_DEFAULTS.detail.fill,
    fillTolerance: 0.2,
    sky: [0, 0.12],
    foregroundTarget: 0.05,
    foregroundMax: 0.25,
    weights: { visibility: 3, fill: 2.5, thirds: 1, horizon: 0.5, sky: 0.5, void: 1, depth: 1, foreground: 0.3, clear: 1, balance: 0, detail: 1.5, contrast: 0.75, entry: 0, solid: 2, light: 0.75, edge: 1 },
  },
  corridor: {
    fillTarget: 0,
    fillTolerance: 1,
    sky: [0.03, 0.3],
    foregroundTarget: 0.08,
    foregroundMax: 0.3,
    weights: { visibility: 3, fill: 0, thirds: 0, horizon: 1, sky: 1, void: 1, depth: 3, foreground: 0.5, clear: 2, balance: 1.5, detail: 1.5, contrast: 0.75, entry: 1.5, solid: 3, light: 0, edge: 0.5 },
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
  /** One code per sample: V visible, T seen through transparent surfaces
   *  (partial weight), F soft-occluded, H hard-blocked, B behind a surface
   *  (the line crosses a hard or subject surface from its BACK side: culled,
   *  so the image would look through it). */
  vis?: string;
  blockers_hard?: string[];
  blockers_soft?: string[];
  /** Surfaces the sight lines crossed from behind ("B" samples). */
  blockers_back?: string[];
  /** Transparent surfaces the sight lines passed through ("T" samples). */
  seen_through?: string[];
  /** Row-major ray grid codes: "." nothing (sky/void), S subject, H hard,
   *  F soft, T transparent (seen through), B a hard/subject surface met from
   *  behind (not drawn). */
  grid?: string;
  /** Distance per grid cell, -1 for no hit. */
  dist?: number[];
  /** Image check (a small beauty render of the final pose), per grid cell:
   *  luminance decile and texture spread, "0" = featureless. */
  lum?: string;
  tex?: string;
  /** Height of the first solid surface straight below the final camera
   *  position; null = nothing below it (the world edge). */
  ground_y?: number | null;
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
  /** Direction the key light TRAVELS (a DirectionalLight3D's -Z); absent =
   *  no light term. */
  keyLight?: Vec3;
}

/** A frame showing more than this share of surfaces from behind is a camera
 *  behind (or inside) a wall: the image would look through it. */
export const MAX_BACK_SHARE = 0.25;

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
  /** Cells whose first surface is a hard/subject surface seen from behind
   *  (not drawn: the image looks through it). */
  back: number;
  /** Cells whose first surface is transparent (seen through). */
  translucent: number;
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
  /** Image check: share of the frame that is featureless ground or
   *  surroundings outside the subject's footprint, below the horizon (a bare
   *  plain, a fogged backing plane). */
  emptyGround?: number;
  /** World edge + empty ground: what the establishing tier rule reads. */
  empty?: number;
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
  blockers?: { hard?: string[]; soft?: string[]; back?: string[]; through?: string[]; lens?: string };
  note?: string;
  /** The first solid surface straight below the camera (null: none). */
  groundY?: number | null;
  /** 0 = clean; 1 = over the shot's empty limit (ranks below every tier 0). */
  tier?: number;
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

/**
 * One featureless grid cell (image check tex "0") is empty ground when its ray
 * points below the horizon and meets non-subject geometry outside the
 * subject's footprint (+ 0.5 m) and below its middle: the bare ground or
 * fogged backing plane around the subject, not the subject's own floor.
 */
export function isEmptyGround(code: string | undefined, d: number, ray: Vec3, pose: CameraPose, subject: Aabb | undefined): boolean {
  if (!subject || ray[1] >= 0 || d < 0 || (code !== "H" && code !== "F" && code !== "T")) return false;
  const hit: Vec3 = [pose.position[0] + ray[0] * d, pose.position[1] + ray[1] * d, pose.position[2] + ray[2] * d];
  const lo = subject.position;
  const margin = 0.5;
  const inside =
    hit[0] >= lo[0] - margin && hit[0] <= lo[0] + subject.size[0] + margin && hit[2] >= lo[2] - margin && hit[2] <= lo[2] + subject.size[2] + margin;
  return !inside && hit[1] <= lo[1] + subject.size[1] / 2;
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
  let back = 0;
  let translucent = 0;
  let nearHard = 0;
  let nearLeft = 0;
  let nearRight = 0;
  // Walls a metre or two away are what a corridor IS; only at the lens are
  // they a blocked view.
  const nearLimit = opts.shot === "corridor" ? 1.0 : Math.max(2.5, (subjectDist ?? 0) * 0.15);
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
    if (code === "B") {
      // Not drawn: the image shows whatever lies beyond it.
      back += 1;
      continue;
    }
    const isFront = subjectDist !== undefined ? d >= 0 && d < subjectDist * 0.75 : d >= 0 && d < 6;
    if (code === "F" || code === "T") {
      // A transparent surface is see-through cover: half a soft cell.
      const weight = code === "T" ? 0.5 : 1;
      soft += weight;
      if (code === "T") translucent += 1;
      if (isFront) {
        foreground += weight;
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
  let emptyGround: number | undefined;
  if (m.lum && m.tex && m.lum.length === grid.length && m.tex.length === grid.length) {
    const nearRef = subjectDist ?? 12;
    let flatCount = 0;
    let emptyCount = 0;
    let nearSum = 0;
    let nearN = 0;
    let farSum = 0;
    let farN = 0;
    for (let k = 0; k < grid.length; k++) {
      const code = grid[k];
      const d = dists[k] ?? -1;
      const col = k % opts.gridCols;
      const row = Math.floor(k / opts.gridCols);
      const ray = rayDirection(pose, opts.aspect, (col + 0.5) / opts.gridCols, (row + 0.5) / opts.gridRows);
      const isSky = code === "." && ray[1] >= 0;
      if (!isSky && m.tex[k] === "0") flatCount += 1;
      if (m.tex[k] === "0" && isEmptyGround(code, d, ray, pose, opts.subject)) emptyCount += 1;
      const lum = Number(m.lum[k]);
      if (code === "B") continue;
      if (code !== "." && d >= 0 && d < nearRef) {
        nearSum += lum;
        nearN += 1;
      } else if (code !== "." && d > nearRef * 2) {
        farSum += lum;
        farN += 1;
      }
    }
    flat = flatCount / total;
    if (opts.subject) emptyGround = emptyCount / total;
    if (nearN >= 3) nearLum = nearSum / nearN;
    if (farN >= 3) farLum = farSum / farN;
  }
  return {
    stats: {
      ...(flat !== undefined ? { flat } : {}),
      ...(nearLum !== undefined ? { nearLum } : {}),
      ...(farLum !== undefined ? { farLum } : {}),
      ...(emptyGround !== undefined ? { emptyGround } : {}),
      empty: voids / total + (emptyGround ?? 0),
      sky: sky / total,
      void: voids / total,
      subject: subject / total,
      hard: hard / total,
      soft: soft / total,
      foreground: foreground / total,
      wallBehind: wallBehind / total,
      back: back / total,
      translucent: translucent / total,
      nearHard: nearHard / total,
      nearLeft: nearLeft / total,
      nearRight: nearRight / total,
    },
    depth: depthCount ? depthSum / depthCount : 0.5,
  };
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Ratio (0..1) of the median wall distance in the frame's left and right
 *  quarters; 0 when one side shows no wall at all. */
export function edgeSymmetry(m: Measurement, opts: ScoringOptions): number {
  const grid = m.grid ?? "";
  const dists = m.dist ?? [];
  const quarter = Math.max(1, Math.round(opts.gridCols / 4));
  const left: number[] = [];
  const right: number[] = [];
  for (let k = 0; k < grid.length; k++) {
    const d = dists[k] ?? -1;
    if (grid[k] === "." || d < 0) continue;
    const col = k % opts.gridCols;
    if (col < quarter) left.push(d);
    else if (col >= opts.gridCols - quarter) right.push(d);
  }
  const l = median(left);
  const r = median(right);
  if (l === undefined || r === undefined) return 0;
  return Math.min(l, r) / Math.max(l, r, 1e-6);
}

export interface ViewProblem {
  /** behind_surface | hard_blocked | inside_volume | near_lens_blocked | below_ground */
  reason: string;
  /** One line for a caption. */
  detail: string;
  blockers?: string[];
}

/**
 * Is this pose a view a player could have of the subject? The one rule both
 * smart framing (rejection) and frame_nodes (a warning for an explicit pose)
 * use. A sight line that crosses a hard or subject surface from BEHIND is as
 * blocked as one that hits a wall's front: back faces are not drawn, so the
 * image would look through the wall the camera stands behind. A frame that
 * shows more than MAX_BACK_SHARE of surfaces from behind is the same failure
 * seen through the lens; the engine's own lens checks (inside a closed shell,
 * just behind a surface, touching geometry) come through as rejections.
 */
export function viewProblem(m: Measurement, maxHardFraction = 0.34): ViewProblem | null {
  if (m.rejected) {
    const lens = m.near_lens_hit ? ` (${m.near_lens_hit})` : "";
    const detail =
      m.rejected === "inside_volume"
        ? "the camera is inside a closed shell of one-sided surfaces: most directions meet a surface from behind, so the image looks out through the walls"
        : m.rejected === "behind_surface"
          ? `the camera is right behind a one-sided surface${lens}: its back is not drawn, so the image looks through it`
          : m.rejected === "near_lens_blocked"
            ? `geometry touches the lens${lens}`
            : m.rejected === "below_ground"
              ? "the camera is below the ground"
              : m.rejected;
    return { reason: m.rejected, detail, ...(m.near_lens_hit ? { blockers: [m.near_lens_hit] } : {}) };
  }
  const vis = m.vis ?? "";
  const n = vis.length;
  const hard = [...vis].filter((c) => c === "H").length;
  const back = [...vis].filter((c) => c === "B").length;
  const grid = m.grid ?? "";
  const backShare = grid.length ? [...grid].filter((c) => c === "B").length / grid.length : 0;
  if (n && (vis[0] === "H" || vis[0] === "B" || (hard + back) / n > maxHardFraction)) {
    if (vis[0] === "B" || back > hard) {
      return {
        reason: "behind_surface",
        detail: `${back} of ${n} sight lines to the subject cross a surface from behind${m.blockers_back?.length ? ` (${m.blockers_back.slice(0, 2).join(", ")})` : ""}: the camera stands behind it and the image would look through it`,
        ...(m.blockers_back?.length ? { blockers: m.blockers_back } : {}),
      };
    }
    return {
      reason: "hard_blocked",
      detail: `${hard + back} of ${n} sight lines to the subject are blocked${m.blockers_hard?.length ? ` by ${m.blockers_hard.slice(0, 2).join(", ")}` : ""}`,
      ...(m.blockers_hard?.length ? { blockers: m.blockers_hard } : {}),
    };
  }
  if (backShare > MAX_BACK_SHARE) {
    return {
      reason: "behind_surface",
      detail: `${Math.round(backShare * 100)}% of the frame is surfaces seen from behind (not drawn): the camera stands behind or inside them and the image looks through them`,
    };
  }
  return null;
}

/** Slack (m) for the probe's rounding when the eye height is checked. */
const EYE_SLACK = 0.03;

/**
 * Eye mode guard (eye_level, corridor): the camera must stand min..max above
 * the solid surface straight below it, and must never have been raised. The
 * engine places eye poses that way; this refuses anything else, so a raised
 * eye can never win. Null when the pose is at eye height.
 */
export function eyeProblem(m: Measurement, candidate: Candidate): string | null {
  const eye = candidate.eye;
  if (!eye) return null;
  if (m.adjustments?.some((a) => a.kind === "raised")) return "raised_above_eye";
  if (typeof m.ground_y !== "number") return "eye_height_unverified";
  const height = m.position[1] - m.ground_y;
  if (height > eye.max + EYE_SLACK) return "above_eye_height";
  if (height < eye.min - EYE_SLACK) return "below_eye_height";
  return null;
}

/** Camera height above the solid surface straight below it, or undefined. */
export function heightAboveGround(position: Vec3, groundY: number | null | undefined): number | undefined {
  return typeof groundY === "number" ? position[1] - groundY : undefined;
}

/**
 * Key-light direction relative to the view (0..1). `light` is the direction
 * the light travels. Best: side or front-side light (the faces the camera
 * sees get form and shadow); worst: light from straight behind the camera
 * (a flat-lit face); backlight is in between. A sun near the zenith lights
 * every side alike, so the term flattens toward neutral.
 */
export function lightScore(pose: CameraPose, light: Vec3): number {
  const view = normalize(sub(pose.look_at, pose.position));
  const dir = normalize(light);
  const horizontal = Math.hypot(dir[0], dir[2]);
  const viewH = Math.hypot(view[0], view[2]);
  if (horizontal < 1e-3 || viewH < 1e-3) return 0.7;
  const cos = (dir[0] * view[0] + dir[2] * view[2]) / (horizontal * viewH);
  // 0 = the light travels along the view (from behind the camera), 180 = into the lens.
  const angle = deg(Math.acos(clamp(cos, -1, 1)));
  let s: number;
  if (angle < 35) s = 0.25 + 0.75 * (angle / 35);
  else if (angle <= 115) s = 1;
  else s = 1 - 0.5 * ((angle - 115) / 65);
  return 0.7 + (s - 0.7) * Math.min(1, horizontal / 0.5);
}

/** Share of the frame below the horizon that shows sky or void: the world's
 *  edge (the ground ends in view). The grid's "." cells with a downward ray. */
export const WORLD_EDGE_LIMIT = 0.04;

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
    ...(m.ground_y !== undefined ? { groundY: m.ground_y } : {}),
  };
  if (m.rejected) {
    return { ...base, rejected: m.rejected, ...(m.near_lens_hit ? { blockers: { lens: m.near_lens_hit } } : {}) };
  }
  // An eye-level or corridor camera off eye height never ranks.
  const offEye = eyeProblem(m, candidate);
  if (offEye) return { ...base, rejected: offEye };
  const vis = m.vis ?? "";
  const n = vis.length;
  const hardCount = [...vis].filter((c) => c === "H" || c === "B").length;
  const softCount = [...vis].filter((c) => c === "F").length;
  const seeCount = [...vis].filter((c) => c === "T").length;
  const hardFraction = n ? hardCount / n : 0;
  const softFraction = n ? softCount / n : 0;
  const blockers = {
    ...(m.blockers_hard?.length ? { hard: m.blockers_hard } : {}),
    ...(m.blockers_soft?.length ? { soft: m.blockers_soft } : {}),
    ...(m.blockers_back?.length ? { back: m.blockers_back } : {}),
    ...(m.seen_through?.length ? { through: m.seen_through } : {}),
  };
  const withBlockers = Object.keys(blockers).length ? { blockers } : {};
  const { stats, depth } = frameStats(m, pose, opts);
  const terms: Partial<Record<ScoreTerm, number>> = {};
  // Soft cover counts 0.6 of a clear line, see-through (transparent) cover 0.8.
  if (n) terms.visibility = (n - hardCount - softCount - seeCount + 0.6 * softCount + 0.8 * seeCount) / n;
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
  // lines rather than one wall eating half the frame. For a corridor: the
  // frame's left and right quarters should both be walls at a similar
  // distance (symmetric recession); elsewhere: near walls evenly split.
  if (opts.shot === "corridor") {
    terms.balance = edgeSymmetry(m, opts);
    if (candidate.into !== undefined) terms.entry = candidate.into;
  } else {
    const sides = stats.nearLeft + stats.nearRight;
    terms.balance = sides < 0.02 ? 1 : 1 - Math.abs(stats.nearLeft - stats.nearRight) / sides;
  }
  // From the image check, when the engine rendered one: no empty
  // (featureless) frame areas, and values that separate near from far.
  if (stats.flat !== undefined) terms.detail = 1 - Math.min(1, stats.flat / 0.3);
  if (stats.nearLum !== undefined && stats.farLum !== undefined) terms.contrast = Math.min(1, Math.abs(stats.nearLum - stats.farLum) / 2);
  // Surfaces seen from behind are holes in the image (the renderer culls
  // them): a few are open boxes or see-through gaps, many mean the camera
  // is behind a wall (rejected below).
  terms.solid = 1 - Math.min(1, stats.back / MAX_BACK_SHARE);
  if (opts.keyLight) terms.light = lightScore(pose, opts.keyLight);
  // The world edge below the horizon: a much steeper penalty than void.
  terms.edge = 1 - Math.min(1, stats.void / WORLD_EDGE_LIMIT);

  let rejected: string | undefined;
  const problem = viewProblem(m, opts.maxHardFraction);
  if (problem) rejected = problem.reason;
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
  const tier = profile.emptyLimit !== undefined && stats.empty! > profile.emptyLimit ? 1 : 0;
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
      ...(stats.emptyGround !== undefined ? { emptyGround: r2(stats.emptyGround) } : {}),
      empty: r2(stats.empty ?? 0),
      sky: r2(stats.sky),
      void: r2(stats.void),
      subject: r2(stats.subject),
      hard: r2(stats.hard),
      soft: r2(stats.soft),
      foreground: r2(stats.foreground),
      wallBehind: r2(stats.wallBehind),
      back: r2(stats.back),
      translucent: r2(stats.translucent),
      nearHard: r2(stats.nearHard),
      nearLeft: r2(stats.nearLeft),
      nearRight: r2(stats.nearRight),
    },
    hardFraction: r2(hardFraction),
    softFraction: r2(softFraction),
    ...(fill !== undefined ? { fill: Number.isFinite(fill) ? r2(fill) : 99 } : {}),
    ...(inFrame !== undefined ? { inFrame: r2(inFrame) } : {}),
    ...(profile.emptyLimit !== undefined ? { tier } : {}),
    ...(rejected ? { rejected } : {}),
    ...withBlockers,
  };
}

/** Rank order: tier first (a pose over the empty limit loses to every pose
 *  under it), then score. */
export function rankOrder(a: ScoredCandidate, b: ScoredCandidate): number {
  return (a.tier ?? 0) - (b.tier ?? 0) || b.total - a.total;
}

export interface PickDiversity {
  /** Ring shots: the yaw of each pick is the camera's azimuth around this
   *  point; without it, the yaw of the view direction. */
  around?: Vec3;
  /** Minimum yaw between any two picks, degrees (default 25). */
  minYaw?: number;
  /** Prefer picks from distinct sides (front +Z, right +X, back -Z, left -X)
   *  while they score within `sideMargin` of the best (default 0.15). */
  sides?: boolean;
  sideMargin?: number;
}

/** Yaw (degrees, 0 = +Z, 90 = +X) of a pose: around `around`, else of its view. */
export function poseYaw(pose: CameraPose, around?: Vec3): number {
  const v: Vec3 = around ? [pose.position[0] - around[0], 0, pose.position[2] - around[2]] : directionOf(pose);
  return ((deg(Math.atan2(v[0], v[2])) % 360) + 360) % 360;
}

function yawGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Side quadrant of a yaw: 0 front (+Z), 1 right (+X), 2 back (-Z), 3 left (-X). */
export function sideOf(yaw: number): number {
  return Math.floor((((yaw + 45) % 360) + 360) % 360 / 90);
}

/**
 * Top `count` non-rejected candidates in score order, skipping near-duplicates
 * (camera within `minSeparation` m AND looking within 12 degrees of a better
 * pick). With `diversity`, the picks also spread out: first one per side
 * (within the score margin), then any pose at least `minYaw` from every pick,
 * and only then the plain near-duplicate rule fills what is left — so the top
 * 3 of an establishing shot are three different views, not one front view
 * three times.
 */
export function pickTop(scored: readonly ScoredCandidate[], count: number, minSeparation: number, diversity?: PickDiversity): ScoredCandidate[] {
  const ranked = scored.filter((s) => !s.rejected).sort(rankOrder);
  const picks: ScoredCandidate[] = [];
  const dup = (s: ScoredCandidate) =>
    picks.some((p) => {
      const sep = distance(p.pose.position, s.pose.position);
      const fa = directionOf(p.pose);
      const fb = directionOf(s.pose);
      const cos = fa[0] * fb[0] + fa[1] * fb[1] + fa[2] * fb[2];
      return sep < minSeparation && cos > Math.cos((12 * Math.PI) / 180);
    });
  // Tier by tier: a worse tier only fills what the better ones leave open.
  const tiers = [...new Set(ranked.map((s) => s.tier ?? 0))];
  for (const tier of tiers) {
    const pool = ranked.filter((s) => (s.tier ?? 0) === tier);
    const take = (accept: (s: ScoredCandidate) => boolean, stopBelow?: number) => {
      for (const s of pool) {
        if (picks.length >= count) return;
        if (stopBelow !== undefined && s.total < stopBelow) return;
        if (picks.includes(s) || dup(s) || !accept(s)) continue;
        picks.push(s);
      }
    };
    if (diversity && pool.length) {
      const minYaw = diversity.minYaw ?? 25;
      const yawOf = (s: ScoredCandidate) => poseYaw(s.pose, diversity.around);
      const spread = (s: ScoredCandidate) => picks.every((p) => yawGap(yawOf(p), yawOf(s)) >= minYaw);
      if (diversity.sides) {
        const floor = pool[0]!.total - (diversity.sideMargin ?? 0.15);
        take((s) => spread(s) && !picks.some((p) => sideOf(yawOf(p)) === sideOf(yawOf(s))), floor);
      }
      take(spread);
    }
    take(() => true);
  }
  return picks.sort(rankOrder);
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
