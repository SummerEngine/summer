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
// insert_host: the host an insert expects, from pieces.json fits_into
// ---------------------------------------------------------------------------

/**
 * fits_into says: the insert has the host's rotation, and sits at
 * host.origin + host.basis * local_offset_m. So the host must be at
 * insert.origin - insert.basis * local_offset_m.
 */
export function expectedHostOrigin(insertOrigin: Vec3, insertBasis: Basis9, localOffset: Vec3): Vec3 {
  return sub(insertOrigin, basisMulVec(insertBasis, localOffset));
}

export interface HostCandidate {
  index: number;
  piece: string;
  origin: Vec3;
  basis: Basis9;
}

export interface HostMatch {
  status: "ok" | "wrong_offset" | "wrong_piece" | "missing";
  expected: Vec3;
  /** The host-named piece nearest the expected origin (any distance), if any. */
  named?: { index: number; distance: number; angle: number };
  /** A different piece sitting at the expected pose. */
  other?: { index: number; piece: string; distance: number; angle: number };
}

/** Match within `tolerance` metres and `maxAngle` degrees (spec: 2 cm, 1 deg). */
export function matchInsertHost(
  insertOrigin: Vec3,
  insertBasis: Basis9,
  localOffset: Vec3,
  hostPiece: string,
  candidates: readonly HostCandidate[],
  tolerance = 0.02,
  maxAngle = 1
): HostMatch {
  const expected = expectedHostOrigin(insertOrigin, insertBasis, localOffset);
  let named: HostMatch["named"];
  let other: HostMatch["other"];
  for (const c of candidates) {
    const distance = length(sub(c.origin, expected));
    const angle = basisAngleDegrees(insertBasis, c.basis);
    if (c.piece === hostPiece) {
      if (!named || distance < named.distance) named = { index: c.index, distance, angle };
    } else if (distance <= tolerance && angle <= maxAngle) {
      if (!other || distance < other.distance) other = { index: c.index, piece: c.piece, distance, angle };
    }
  }
  if (named && named.distance <= tolerance && named.angle <= maxAngle) return { status: "ok", expected, named };
  if (named && named.distance <= 0.5) return { status: "wrong_offset", expected, named, ...(other ? { other } : {}) };
  if (other) return { status: "wrong_piece", expected, other, ...(named ? { named } : {}) };
  return { status: "missing", expected, ...(named ? { named } : {}) };
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

/** Angle in [0, 180] between two directions (signed: 180 = pointing away). */
export function directionAngleDegrees(a: Vec3, b: Vec3): number {
  const c = Math.min(1, Math.max(-1, dot(normalize(a), normalize(b))));
  return (Math.acos(c) * 180) / Math.PI;
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
