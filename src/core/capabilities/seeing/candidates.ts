/**
 * Smart framing, part 1: candidate camera poses per shot type. Pure and
 * engine-free — the engine only measures what these poses would see
 * (assets/seeing/seeing_probe.gd "measure"); scoring.ts ranks the result.
 *
 * Every candidate sits at the distance where the subject fills the shot
 * type's target share of the frame (fitDistance), on a ring or hemisphere
 * around the subject, or along a corridor's free line. Low angles follow the
 * low-angle rule (closer + wider instead of buried in the ground).
 */
import {
  aabbCenter,
  aabbCorners,
  aabbMax,
  add,
  applyLowAngleRule,
  directionFromAngles,
  fitDistance,
  lerp,
  normalize,
  rotateY,
  scale,
  sub,
  thirdsYawOffset,
  type Aabb,
  type Vec3,
} from "./math.js";

export const SHOT_TYPES = ["establishing", "eye_level", "low_angle", "detail", "corridor"] as const;
export type ShotType = (typeof SHOT_TYPES)[number];

/**
 * Eye mode (eye_level and corridor): the camera stands at eye height above the
 * walkable surface under it and is never raised. The engine finds that
 * surface straight below the lens (overhead structure never counts), checks
 * it is within a step of the floor under `stand`, and puts the camera
 * `target` above it (without a target: its current height, clamped into
 * min..max). A pose that cannot stand there moves horizontally or is rejected.
 */
export interface EyeSpec {
  /** Lowest and highest allowed camera height above the walkable surface (m). */
  min: number;
  max: number;
  /** Height above the walkable surface to stand the camera at; absent = keep
   *  its own height inside min..max (a spawn's Camera3D). */
  target?: number;
  /** Where the player stands (spawn origin, corridor seed): the floor under it
   *  is the walkable reference. */
  stand: Vec3;
}

export interface Candidate {
  id: string;
  position: Vec3;
  look_at: Vec3;
  fov: number;
  /** World points the thick sweep must reach (subject bounds or corridor line). */
  samples: Vec3[];
  /** Below this height above the ground under the camera the engine applies
   *  the low-angle rule (or raises the camera when it is not looking up).
   *  Ignored in eye mode. */
  min_clearance: number;
  low_angle_rule: boolean;
  /** Eye mode: eye_level and corridor poses. */
  eye?: EyeSpec;
  note?: string;
  /** Corridor only: 1 = from an open end looking in, 0 = looking out of a
   *  dead end, 0.5 = a through passage (both ends alike). */
  into?: number;
}

export interface SpawnInfo {
  path: string;
  origin: Vec3;
  forward: Vec3;
  camera?: { path: string; position: Vec3; forward: Vec3; fov: number };
}

export interface CorridorRun {
  seed: Vec3;
  dir: Vec3;
  fwd: number;
  back: number;
  left: number;
  right: number;
}

export interface CorridorAxis extends CorridorRun {
  /** Free length inside the subject bounds (+ a small margin) along dir. */
  usableFwd: number;
  usableBack: number;
  width: number;
  score: number;
  /** The free run continues past the subject bounds on that end: an
   *  entrance. A closed end is a dead end (or the far wall). */
  openFwd: boolean;
  openBack: boolean;
}

export interface CandidateContext {
  shot: ShotType;
  /** Merged bounds of the subject nodes (absent for a subject-less eye-level look). */
  subject?: Aabb;
  spawn?: SpawnInfo;
  corridor?: CorridorAxis;
  aspect: number;
  /** Overrides the shot type's default fov. */
  fov?: number;
  eyeHeight?: number;
  /** Ground height under the subject; defaults to the subject's lowest point. */
  groundY?: number;
}

export interface ShotDefaults {
  fov: number;
  /** Target share of the frame along the subject's limiting dimension. */
  fill: number;
}

export const SHOT_DEFAULTS: Record<ShotType, ShotDefaults> = {
  establishing: { fov: 55, fill: 0.78 },
  eye_level: { fov: 70, fill: 0.5 },
  low_angle: { fov: 60, fill: 0.85 },
  detail: { fov: 40, fill: 0.7 },
  corridor: { fov: 65, fill: 0 },
};

export const LOW_ANGLE_CLEARANCE = 0.35;
export const DEFAULT_CLEARANCE = 0.3;
export const MAX_FOV = 100;
export const DEFAULT_EYE_HEIGHT = 1.6;
/** A standing eye without an explicit eye_height: 1.5-1.8 m above the walkable
 *  surface under the camera. */
export const EYE_BAND: readonly [number, number] = [1.5, 1.8];

/** The eye band: exactly eye_height when given, else EYE_BAND. */
export function eyeBand(eyeHeight: number | undefined): [number, number] {
  return eyeHeight !== undefined ? [eyeHeight, eyeHeight] : [EYE_BAND[0], EYE_BAND[1]];
}

/** Nine points the thick sweep aims at: the center plus the eight corners
 *  pulled 40% toward it, so a subject standing on the ground still offers
 *  points above the ground plane. */
export function subjectSamples(box: Aabb): Vec3[] {
  const c = aabbCenter(box);
  return [c, ...aabbCorners(box).map((corner) => lerp(c, corner, 0.6))];
}

const AZIMUTHS_12 = Array.from({ length: 12 }, (_, i) => i * 30);
const AZIMUTHS_16 = Array.from({ length: 16 }, (_, i) => i * 22.5);

function ringCandidates(
  prefix: string,
  box: Aabb,
  lookAt: Vec3,
  elevations: number[],
  fov: number,
  fill: number,
  aspect: number,
  options: { minY?: number; lowAngle?: boolean; clearance: number }
): Candidate[] {
  const out: Candidate[] = [];
  const samples = subjectSamples(box);
  for (const elevation of elevations) {
    for (const azimuth of AZIMUTHS_12) {
      const toCamera = directionFromAngles(azimuth, elevation);
      const dist = fitDistance(box, lookAt, toCamera, fov, aspect, fill);
      let position = add(lookAt, scale(toCamera, dist));
      let camFov = fov;
      let note: string | undefined;
      if (options.lowAngle && options.minY !== undefined) {
        const rule = applyLowAngleRule(lookAt, toCamera, dist, fov, options.minY, MAX_FOV);
        if (rule.impossible) continue;
        position = rule.position;
        camFov = rule.fov;
        if (rule.adjusted) note = `low-angle rule: ${dist.toFixed(1)} m -> ${rule.distance.toFixed(1)} m, fov ${fov} -> ${rule.fov.toFixed(1)}`;
      }
      out.push({
        id: `${prefix}_az${String(azimuth).padStart(3, "0")}_el${elevation}`,
        position,
        look_at: lookAt,
        fov: Math.round(camFov * 100) / 100,
        samples,
        min_clearance: options.clearance,
        low_angle_rule: options.lowAngle === true,
        ...(note ? { note } : {}),
      });
    }
  }
  return out;
}

function eyeOf(ctx: CandidateContext): { eye: Vec3; source: string } {
  const spawn = ctx.spawn!;
  if (ctx.eyeHeight === undefined && spawn.camera) return { eye: spawn.camera.position, source: `camera ${spawn.camera.path}` };
  const h = ctx.eyeHeight ?? DEFAULT_EYE_HEIGHT;
  return { eye: add(spawn.origin, [0, h, 0]), source: `${h} m above the walkable surface at ${spawn.path}` };
}

function eyeLevelCandidates(ctx: CandidateContext, fovDefault: number): Candidate[] {
  const { eye, source } = eyeOf(ctx);
  const [min, max] = eyeBand(ctx.eyeHeight);
  // The engine stands the eye on the walkable surface under it: eye_height
  // (or 1.6 m) above it, or a spawn camera's own height clamped into
  // 1.5-1.8 m. Never higher.
  const ownCamera = ctx.eyeHeight === undefined && ctx.spawn!.camera !== undefined;
  const eyeSpec: EyeSpec = { min, max, ...(ownCamera ? {} : { target: ctx.eyeHeight ?? DEFAULT_EYE_HEIGHT }), stand: [...ctx.spawn!.origin] as Vec3 };
  const out: Candidate[] = [];
  const fovs = ctx.fov !== undefined ? [ctx.fov] : [fovDefault - 10, fovDefault + 5];
  if (ctx.subject) {
    const c = aabbCenter(ctx.subject);
    const flat = normalize([c[0] - eye[0], 0, c[2] - eye[2]]);
    const horizontal = Math.hypot(c[0] - eye[0], c[2] - eye[2]);
    const samples = subjectSamples(ctx.subject);
    for (const fov of fovs) {
      const yawStep = thirdsYawOffset(fov, ctx.aspect);
      for (const [tag, yaw] of [["c", 0], ["l3", yawStep], ["r3", -yawStep]] as const) {
        for (const [ptag, aimed] of [["level", false], ["aim", true]] as const) {
          const dir = rotateY(flat, yaw);
          // Eye level means a level camera; "aim" tilts at most 12 degrees
          // toward the subject's center, the way a player glances up.
          const rise = aimed ? Math.max(-0.21, Math.min(0.21, (c[1] - eye[1]) / Math.max(horizontal, 0.1))) : 0;
          out.push({
            id: `eye_${tag}_${ptag}_fov${fov}`,
            position: eye,
            look_at: add(eye, scale(normalize([dir[0], rise, dir[2]]), 10)),
            fov,
            samples,
            min_clearance: 0,
            low_angle_rule: false,
            eye: eyeSpec,
            note: `eye ${source}`,
          });
        }
      }
    }
    return out;
  }
  const fov = ctx.fov ?? fovDefault;
  const forward = normalize([ctx.spawn!.camera?.forward[0] ?? ctx.spawn!.forward[0], 0, ctx.spawn!.camera?.forward[2] ?? ctx.spawn!.forward[2]]);
  out.push({ id: "eye_spawn_forward", position: eye, look_at: add(eye, scale(forward, 10)), fov, samples: [], min_clearance: 0, low_angle_rule: false, eye: eyeSpec, note: `eye ${source}` });
  for (const azimuth of AZIMUTHS_16) {
    const dir = directionFromAngles(azimuth, 0);
    out.push({
      id: `eye_az${String(azimuth).padStart(5, "0")}`,
      position: eye,
      look_at: add(eye, scale(dir, 10)),
      fov,
      samples: [],
      min_clearance: 0,
      low_angle_rule: false,
      eye: eyeSpec,
      note: `eye ${source}`,
    });
  }
  return out;
}

/** Where a ray from `origin` along `dir` leaves `box` (slab test), or Infinity. */
export function exitDistance(box: Aabb, origin: Vec3, dir: Vec3): number {
  const lo = box.position;
  const hi = aabbMax(box);
  let tExit = Infinity;
  for (let k = 0; k < 3; k++) {
    const d = dir[k]!;
    if (Math.abs(d) < 1e-9) continue;
    const t1 = (lo[k]! - origin[k]!) / d;
    const t2 = (hi[k]! - origin[k]!) / d;
    tExit = Math.min(tExit, Math.max(t1, t2));
  }
  return Math.max(0, tExit);
}

/**
 * Pick the corridor axis from the engine's free-run scan: the longest free
 * line (clipped to the subject bounds + 2 m on each end) that is also narrow
 * enough to read as a corridor and wide enough to walk.
 */
export function chooseCorridorAxis(runs: readonly CorridorRun[], box: Aabb): CorridorAxis[] {
  const scored: CorridorAxis[] = [];
  for (const run of runs) {
    const exitFwd = exitDistance(box, run.seed, run.dir);
    const exitBack = exitDistance(box, run.seed, scale(run.dir, -1));
    const usableFwd = Math.min(run.fwd, exitFwd + 2);
    const usableBack = Math.min(run.back, exitBack + 2);
    const total = usableFwd + usableBack;
    const width = run.left + run.right;
    if (total < 4 || width < 1) continue;
    const slenderness = total / Math.max(width, 0.5);
    const score = total * Math.min(1, slenderness / 3);
    scored.push({ ...run, usableFwd, usableBack, width, score, openFwd: run.fwd > exitFwd + 0.5, openBack: run.back > exitBack + 0.5 });
  }
  scored.sort((a, b) => b.score - a.score);
  // Distinct axes only: drop near-duplicates (same direction, nearby seed).
  const distinct: CorridorAxis[] = [];
  for (const axis of scored) {
    const dup = distinct.some((d) => Math.abs(d.dir[0] * axis.dir[0] + d.dir[2] * axis.dir[2]) > 0.95 && Math.hypot(d.seed[0] - axis.seed[0], d.seed[2] - axis.seed[2]) < Math.max(2, d.width));
    if (!dup) distinct.push(axis);
    if (distinct.length >= 3) break;
  }
  return distinct;
}

/** The walkable floor along a corridor axis: the scan put its seed at eye
 *  height above the floor it found there. */
export function corridorFloorY(axis: CorridorRun, eyeHeight: number | undefined): number {
  return axis.seed[1] - (eyeHeight ?? DEFAULT_EYE_HEIGHT);
}

function corridorCandidates(ctx: CandidateContext, fovDefault: number): Candidate[] {
  const axis = ctx.corridor!;
  // The floor under the corridor line (the scan's seed), not the subject's
  // lowest point: walls sunk into the ground or a backing plane below the
  // floor would put every camera too low or, after the ground check, high.
  const floorY = corridorFloorY(axis, ctx.eyeHeight);
  const height = ctx.eyeHeight ?? DEFAULT_EYE_HEIGHT;
  const [min, max] = eyeBand(ctx.eyeHeight);
  const eyeSpec: EyeSpec = { min, max, target: height, stand: [...axis.seed] as Vec3 };
  const dir = normalize([axis.dir[0], 0, axis.dir[2]]);
  const perp: Vec3 = [dir[2], 0, -dir[0]];
  const halfWidth = Math.min(axis.left, axis.right, axis.width / 2);
  const fovs = ctx.fov !== undefined ? [ctx.fov] : [fovDefault - 5, fovDefault + 10];
  const out: Candidate[] = [];
  // "ab" starts at the back end and looks toward the forward end.
  const intoOf = (fromOpen: boolean, toOpen: boolean) => (fromOpen === toOpen ? 0.5 : fromOpen ? 1 : 0);
  const intoAb = intoOf(axis.openBack, axis.openFwd);
  // A corridor shot is about walking it: every camera stands at eye height.
  // The alternatives are horizontal only (how far in from the end, how far
  // off the centre line), never a raised eye.
  for (const reach of [0.92, 0.75]) {
    const endB = add(axis.seed, scale(dir, axis.usableFwd * reach));
    const endA = add(axis.seed, scale(dir, -axis.usableBack * reach));
    for (const [tag, from, to] of [["ab", endA, endB], ["ba", endB, endA]] as const) {
      const into = tag === "ab" ? intoAb : 1 - intoAb;
      const far: Vec3 = [to[0], floorY + height, to[2]];
      const samples: Vec3[] = [0.3, 0.55, 0.8, 1].map((t) => {
        const p = lerp(from, to, t);
        return [p[0], floorY + height, p[2]] as Vec3;
      });
      const mid = lerp(from, to, 0.55);
      for (const side of [-0.3, 0.3]) {
        const lat = scale(perp, side * halfWidth);
        samples.push([mid[0] + lat[0], floorY + height, mid[2] + lat[2]]);
      }
      for (const lateral of [-0.3, 0, 0.3]) {
        const offset = scale(perp, lateral * halfWidth);
        const position: Vec3 = [from[0] + offset[0], floorY + height, from[2] + offset[2]];
        for (const fov of fovs) {
          out.push({
            id: `corridor_${tag}_r${reach}_x${lateral}_fov${fov}`,
            position,
            look_at: far,
            fov,
            samples,
            min_clearance: DEFAULT_CLEARANCE,
            low_angle_rule: false,
            eye: eyeSpec,
            into,
            ...(into === 1 ? { note: "looks in from the open end" } : into === 0 ? { note: "looks out from the dead end" } : {}),
          });
        }
      }
    }
  }
  return out;
}

export function generateCandidates(ctx: CandidateContext): Candidate[] {
  const defaults = SHOT_DEFAULTS[ctx.shot];
  const fov = ctx.fov ?? defaults.fov;
  switch (ctx.shot) {
    case "establishing": {
      const box = ctx.subject!;
      return ringCandidates("wide", box, aabbCenter(box), [12, 25, 40], fov, defaults.fill, ctx.aspect, { clearance: DEFAULT_CLEARANCE });
    }
    case "detail": {
      const box = ctx.subject!;
      return ringCandidates("detail", box, aabbCenter(box), [8, 22, 38], fov, defaults.fill, ctx.aspect, { clearance: DEFAULT_CLEARANCE });
    }
    case "low_angle": {
      const box = ctx.subject!;
      const ground = ctx.groundY ?? box.position[1];
      return ringCandidates("low", box, aabbCenter(box), [-6, -14, -24], fov, defaults.fill, ctx.aspect, {
        minY: ground + LOW_ANGLE_CLEARANCE,
        lowAngle: true,
        clearance: LOW_ANGLE_CLEARANCE,
      });
    }
    case "eye_level":
      return eyeLevelCandidates(ctx, defaults.fov);
    case "corridor":
      return corridorCandidates(ctx, defaults.fov);
  }
}

/** Corridor "subject" box used for frame metrics: the free line it looks down. */
export function corridorBox(axis: CorridorAxis, floorY: number): Aabb {
  const dir = normalize([axis.dir[0], 0, axis.dir[2]]);
  const a = add(axis.seed, scale(dir, -axis.usableBack));
  const b = add(axis.seed, scale(dir, axis.usableFwd));
  const lo: Vec3 = [Math.min(a[0], b[0]) - 0.5, floorY, Math.min(a[2], b[2]) - 0.5];
  const hi: Vec3 = [Math.max(a[0], b[0]) + 0.5, floorY + 2.5, Math.max(a[2], b[2]) + 0.5];
  return { position: lo, size: sub(hi, lo) };
}
