/**
 * Pure math behind summer_scene_audit: everything the judgment side needs
 * that is worth testing without an engine. The in-engine kernel
 * (assets/audit/scene_audit.gd) only measures; these functions decide.
 *
 * Conventions match the engine: +Y up, a basis is three COLUMN vectors
 * (x, y, z), a transform maps local to world as origin + basis * v.
 */
import { add, dot, length, normalize, scale, sub, type Vec3 } from "../seeing/math.js";

export type { Vec3 };

/** Basis as the kernel writes it: [x.x, x.y, x.z, y.x, y.y, y.z, z.x, z.y, z.z]. */
export type Basis9 = readonly number[];

export function basisColumns(b: Basis9): [Vec3, Vec3, Vec3] {
  return [
    [b[0]!, b[1]!, b[2]!],
    [b[3]!, b[4]!, b[5]!],
    [b[6]!, b[7]!, b[8]!],
  ];
}

export function basisMulVec(b: Basis9, v: Vec3): Vec3 {
  const [x, y, z] = basisColumns(b);
  return add(add(scale(x, v[0]), scale(y, v[1])), scale(z, v[2]));
}

/** Rotation angle (degrees) between two bases, scale removed. */
export function basisAngleDegrees(a: Basis9, b: Basis9): number {
  const ca = basisColumns(a).map((c) => normalize(c));
  const cb = basisColumns(b).map((c) => normalize(c));
  // trace(A^T B) = sum of column dot products for orthonormal bases.
  const trace = dot(ca[0]!, cb[0]!) + dot(ca[1]!, cb[1]!) + dot(ca[2]!, cb[2]!);
  const c = Math.min(1, Math.max(-1, (trace - 1) / 2));
  return (Math.acos(c) * 180) / Math.PI;
}

// ---------------------------------------------------------------------------
// orientation: parallelism of a long axis to a wall
// ---------------------------------------------------------------------------

/** Horizontal direction along a wall whose (horizontal) normal is n. */
export function wallDirection(normal: Vec3): Vec3 {
  return normalize([-normal[2], 0, normal[0]]);
}

/** Angle in [0, 90] degrees between an axis and a line (sign-free). */
export function lineAngleDegrees(axis: Vec3, line: Vec3): number {
  const a = normalize([axis[0], 0, axis[2]]);
  const l = normalize([line[0], 0, line[2]]);
  const c = Math.min(1, Math.abs(dot(a, l)));
  return (Math.acos(c) * 180) / Math.PI;
}

// ---------------------------------------------------------------------------
// z_fight: depth precision decides how close is "coplanar"
// ---------------------------------------------------------------------------

/** Camera defaults when the scene has no perspective camera (Godot's Camera3D). */
export const DEFAULT_NEAR = 0.05;
export const DEFAULT_FAR = 4000;
/** Compatibility / WebGL2 depth buffer. */
export const DEPTH_BITS = 24;
/** The distance a surface is judged at when no viewpoint is known. */
export const TYPICAL_VIEW_M = 30;
/** Float noise in world transforms: never call a smaller gap resolvable. */
export const MIN_ZFIGHT_TOLERANCE = 0.0001;

/**
 * World distance one depth-buffer step spans at `distance` from a perspective
 * camera: z^2 (f - n) / (f n 2^bits). It grows with the square of the
 * distance and shrinks with a larger near plane.
 */
export function depthResolution(distance: number, near = DEFAULT_NEAR, far = DEFAULT_FAR, bits = DEPTH_BITS): number {
  const n = Math.max(1e-4, near);
  const f = Math.max(n * 1.0001, far);
  return (distance * distance * (f - n)) / (f * n * 2 ** bits);
}

/** Two faces closer than this flicker: twice the depth step at `distance`. */
export function zFightTolerance(distance: number, near = DEFAULT_NEAR, far = DEFAULT_FAR, factor = 2, bits = DEPTH_BITS): number {
  return Math.max(MIN_ZFIGHT_TOLERANCE, factor * depthResolution(distance, near, far, bits));
}

// ---------------------------------------------------------------------------
// uv_stretch: anisotropy of the UV -> world mapping of one triangle
// ---------------------------------------------------------------------------

export type Vec2 = readonly [number, number];

/**
 * Ratio of the two singular values of the 3x2 Jacobian d(world)/d(uv): how
 * much more world distance one UV direction covers than the other. 1 = square
 * texels, 8 = a texel stretched 8:1. Collapsed UVs (zero UV area) are
 * Infinity: the texture is smeared into a strip.
 */
export function uvStretchRatio(p0: Vec3, p1: Vec3, p2: Vec3, t0: Vec2, t1: Vec2, t2: Vec2): number {
  const e1 = sub(p1, p0);
  const e2 = sub(p2, p0);
  const u1: Vec2 = [t1[0] - t0[0], t1[1] - t0[1]];
  const u2: Vec2 = [t2[0] - t0[0], t2[1] - t0[1]];
  const det = u1[0] * u2[1] - u2[0] * u1[1];
  if (Math.abs(det) < 1e-12) return Number.POSITIVE_INFINITY;
  const inv = 1 / det;
  const du = scale(sub(scale(e1, u2[1]), scale(e2, u1[1])), inv);
  const dv = scale(sub(scale(e2, u1[0]), scale(e1, u2[0])), inv);
  const aa = dot(du, du);
  const bb = dot(dv, dv);
  const ab = dot(du, dv);
  const disc = Math.sqrt(Math.max(0, (aa - bb) * (aa - bb) + 4 * ab * ab));
  const s1 = (aa + bb + disc) / 2;
  const s2 = (aa + bb - disc) / 2;
  if (s2 <= 1e-14) return Number.POSITIVE_INFINITY;
  return Math.sqrt(s1 / s2);
}

export function triangleArea(p0: Vec3, p1: Vec3, p2: Vec3): number {
  const e1 = sub(p1, p0);
  const e2 = sub(p2, p0);
  const c: Vec3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  return length(c) / 2;
}

// ---------------------------------------------------------------------------
// Clustering ray samples on a 2D grid (through-hole rays on a facade, floor
// gap rays on the ground plane)
// ---------------------------------------------------------------------------

export interface Sample2 {
  u: number;
  v: number;
}

/**
 * Connected groups of samples: two samples are neighbours when both
 * coordinates differ by at most `reach` (1.5 x the grid spacing joins the
 * 8-neighbourhood and off-grid seam samples). Returns groups of indices,
 * largest first. Uses a bucket grid, so it is linear in practice.
 */
export function clusterSamples(samples: readonly Sample2[], reach: number): number[][] {
  const parent = samples.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const cell = Math.max(reach, 1e-6);
  const buckets = new Map<string, number[]>();
  const key = (i: number, j: number) => `${i},${j}`;
  samples.forEach((s, idx) => {
    const i = Math.floor(s.u / cell);
    const j = Math.floor(s.v / cell);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (const other of buckets.get(key(i + di, j + dj)) ?? []) {
          const o = samples[other]!;
          if (Math.abs(o.u - s.u) <= reach + 1e-9 && Math.abs(o.v - s.v) <= reach + 1e-9) union(idx, other);
        }
      }
    }
    const k = key(i, j);
    const list = buckets.get(k);
    if (list) list.push(idx);
    else buckets.set(k, [idx]);
  });
  const groups = new Map<number, number[]>();
  samples.forEach((_, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  });
  return [...groups.values()].sort((a, b) => b.length - a.length || a[0]! - b[0]!);
}

// ---------------------------------------------------------------------------
// floor_gap: what a cluster of missed down rays covers
// ---------------------------------------------------------------------------

/** One down-ray sample and the ground it stands for: a grid cell, 10 cm of a
 *  seam across its width, or one step of a strip along a wall base. */
export interface Footprint {
  x: number;
  z: number;
  sx: number;
  sz: number;
  area: number;
}

export interface FootprintExtent {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  w: number;
  d: number;
  /** The longer and the shorter side (a seam is 8.4 x 0.04 m). */
  long: number;
  short: number;
  area: number;
}

/**
 * Bounds and area of a cluster of missed rays. The area is the sum of the
 * samples' own footprints, never more than their bounding box: a 4 cm seam
 * walked by 84 rays is 0.34 m2, not 84 grid cells.
 */
export function footprintExtent(cells: readonly Footprint[]): FootprintExtent {
  if (!cells.length) return { x0: 0, x1: 0, z0: 0, z1: 0, w: 0, d: 0, long: 0, short: 0, area: 0 };
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  let sum = 0;
  for (const c of cells) {
    x0 = Math.min(x0, c.x - c.sx / 2);
    x1 = Math.max(x1, c.x + c.sx / 2);
    z0 = Math.min(z0, c.z - c.sz / 2);
    z1 = Math.max(z1, c.z + c.sz / 2);
    sum += Math.max(0, c.area);
  }
  const w = x1 - x0;
  const d = z1 - z0;
  return { x0, x1, z0, z1, w, d, long: Math.max(w, d), short: Math.min(w, d), area: Math.min(sum, w * d) };
}

/** The most frequent value (ties: the first seen); `fallback` when empty. */
export function mostCommon(values: readonly number[], fallback = -1): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = fallback;
  let n = 0;
  for (const [v, c] of counts) {
    if (c > n) {
      best = v;
      n = c;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Robust bounds for "far out of bounds"
// ---------------------------------------------------------------------------

export function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx]!;
}

/** Median centre and the distance beyond which a piece is "far out". */
export function robustBounds(points: readonly Vec3[]): { center: Vec3; radius: number; limit: number } {
  const center: Vec3 = [median(points.map((p) => p[0])), median(points.map((p) => p[1])), median(points.map((p) => p[2]))];
  const radius = percentile(points.map((p) => length(sub(p, center))), 95);
  return { center, radius, limit: Math.max(3 * radius, radius + 50) };
}

/** Distance along `dir` (unit) from `p` to the point where it would be seen. */
export function fitCameraDistance(size: number, fovDegrees: number, fill = 0.55): number {
  const half = Math.tan((fovDegrees * Math.PI) / 360);
  return size / (2 * half * fill);
}

// ---------------------------------------------------------------------------
// Axis labels (z_fight: which way to nudge)
// ---------------------------------------------------------------------------

/** World axis label of a vector's dominant component ("+X", "-Y", ...). */
export function axisName(v: Vec3): string {
  const k = Math.abs(v[0]) >= Math.abs(v[1]) && Math.abs(v[0]) >= Math.abs(v[2]) ? 0 : Math.abs(v[1]) >= Math.abs(v[2]) ? 1 : 2;
  return `${v[k]! >= 0 ? "+" : "-"}${"XYZ"[k]}`;
}

/** The local axis of a piece (basis columns) that a world direction runs along. */
export function localAxisName(b: readonly number[], v: Vec3): string {
  const cols = basisColumns(b);
  const local: Vec3 = [0, 1, 2].map((k) => {
    const c = cols[k]!;
    const L = length(c) || 1;
    return (c[0] * v[0] + c[1] * v[1] + c[2] * v[2]) / L;
  }) as unknown as Vec3;
  return axisName(local);
}

// ---------------------------------------------------------------------------
// Axis-aligned boxes (gap detectors: band runs, corner squares, confirmation)
// ---------------------------------------------------------------------------

export interface Box {
  lo: Vec3;
  hi: Vec3;
}

export function makeBox(a: Vec3, b: Vec3): Box {
  return { lo: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])], hi: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])] };
}

export function growBox(b: Box, g: number): Box {
  return { lo: [b.lo[0] - g, b.lo[1] - g, b.lo[2] - g], hi: [b.hi[0] + g, b.hi[1] + g, b.hi[2] + g] };
}

export function boxCenter(b: Box): Vec3 {
  return [(b.lo[0] + b.hi[0]) / 2, (b.lo[1] + b.hi[1]) / 2, (b.lo[2] + b.hi[2]) / 2];
}

/** Overlap of two boxes, or null when they do not overlap (touching counts). */
export function boxIntersection(a: Box, b: Box): Box | null {
  const lo: Vec3 = [Math.max(a.lo[0], b.lo[0]), Math.max(a.lo[1], b.lo[1]), Math.max(a.lo[2], b.lo[2])];
  const hi: Vec3 = [Math.min(a.hi[0], b.hi[0]), Math.min(a.hi[1], b.hi[1]), Math.min(a.hi[2], b.hi[2])];
  if (lo[0] > hi[0] || lo[1] > hi[1] || lo[2] > hi[2]) return null;
  return { lo, hi };
}

/** Shortest distance between two boxes (0 when they touch or overlap). */
export function boxDistance(a: Box, b: Box): number {
  let s = 0;
  for (let k = 0; k < 3; k++) {
    const d = a.hi[k]! < b.lo[k]! ? b.lo[k]! - a.hi[k]! : b.hi[k]! < a.lo[k]! ? a.lo[k]! - b.hi[k]! : 0;
    s += d * d;
  }
  return Math.sqrt(s);
}

/**
 * Share (0-1) of `square`'s XZ footprint that box `a` covers, when their
 * height ranges overlap. Two band pieces that meet only at the corner's edge
 * (they "touch at a point" seen from above) cover none of the corner square
 * out in front of both.
 */
export function xzCover(a: Box, square: Box): number {
  if (a.hi[1] < square.lo[1] || a.lo[1] > square.hi[1]) return 0;
  const ox = Math.min(a.hi[0], square.hi[0]) - Math.max(a.lo[0], square.lo[0]);
  const oz = Math.min(a.hi[2], square.hi[2]) - Math.max(a.lo[2], square.lo[2]);
  if (ox <= 0 || oz <= 0) return 0;
  return (ox * oz) / Math.max((square.hi[0] - square.lo[0]) * (square.hi[2] - square.lo[2]), 1e-9);
}

/** The band-height box a gap or an end of a band run spans: [a, b] along the
 *  band's axis, 10 cm deep around its plane c, the middle half of its height. */
export function bandSpanBox(ax: 0 | 2, a: number, b: number, c: number, y0: number, y1: number): Box {
  const th = 2 - ax;
  const lo: [number, number, number] = [0, y0 + (y1 - y0) * 0.25, 0];
  const hi: [number, number, number] = [0, y0 + (y1 - y0) * 0.75, 0];
  lo[ax] = Math.min(a, b);
  hi[ax] = Math.max(Math.max(a, b), Math.min(a, b) + 0.001);
  lo[th] = c - 0.05;
  hi[th] = c + 0.05;
  return { lo, hi };
}

/** Merge sorted [lo, hi] intervals that touch or overlap within `join`. */
export function mergeRuns(items: ReadonlyArray<readonly [number, number]>, join = 0.01): Array<[number, number]> {
  const sorted = [...items].sort((a, b) => a[0] - b[0]);
  const runs: Array<[number, number]> = [];
  for (const [lo, hi] of sorted) {
    const last = runs[runs.length - 1];
    if (last && lo <= last[1] + join) last[1] = Math.max(last[1], hi);
    else runs.push([lo, hi]);
  }
  return runs;
}
