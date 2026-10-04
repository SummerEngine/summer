/**
 * Camera math for the seeing tools — pure, engine-free, unit-tested.
 *
 * Conventions match the engine (Godot 4): right-handed, +Y up, a camera looks
 * down its local -Z, `lookAtBasis` mirrors Basis.looking_at, and the vertical
 * field of view is fixed (Camera3D KEEP_HEIGHT), so the horizontal extent
 * scales with the aspect ratio. Screen coordinates are normalized: u,v in 0..1
 * with v = 0 at the TOP of the image.
 */
import { ToolInputError } from "../../tool-errors.js";

export type Vec3 = readonly [number, number, number];

export interface Aabb {
  position: Vec3;
  size: Vec3;
}

export interface CameraPose {
  position: Vec3;
  look_at: Vec3;
  /** Vertical field of view, degrees. */
  fov: number;
}

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3): number => Math.sqrt(dot(a, a));
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => add(a, scale(sub(b, a), t));
export const deg = (rad: number): number => (rad * 180) / Math.PI;
export const rad = (degrees: number): number => (degrees * Math.PI) / 180;
export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  if (l < 1e-9) return [0, 0, 0];
  return [a[0] / l, a[1] / l, a[2] / l];
}

export function aabbCenter(box: Aabb): Vec3 {
  return add(box.position, scale(box.size, 0.5));
}

export function aabbMax(box: Aabb): Vec3 {
  return add(box.position, box.size);
}

export function aabbCorners(box: Aabb): Vec3[] {
  const [x0, y0, z0] = box.position;
  const [x1, y1, z1] = aabbMax(box);
  return [
    [x0, y0, z0], [x1, y0, z0], [x0, y1, z0], [x1, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x0, y1, z1], [x1, y1, z1],
  ];
}

export function mergeAabbs(boxes: readonly Aabb[]): Aabb {
  if (!boxes.length) throw new Error("mergeAabbs needs at least one box");
  let lo: Vec3 = boxes[0]!.position;
  let hi: Vec3 = aabbMax(boxes[0]!);
  for (const box of boxes.slice(1)) {
    const bmax = aabbMax(box);
    lo = [Math.min(lo[0], box.position[0]), Math.min(lo[1], box.position[1]), Math.min(lo[2], box.position[2])];
    hi = [Math.max(hi[0], bmax[0]), Math.max(hi[1], bmax[1]), Math.max(hi[2], bmax[2])];
  }
  return { position: lo, size: sub(hi, lo) };
}

/** Camera basis as three column vectors (x right, y up, z back) — Basis.looking_at. */
export interface Basis3 {
  x: Vec3;
  y: Vec3;
  z: Vec3;
}

export function lookAtBasis(position: Vec3, target: Vec3): Basis3 {
  const forward = normalize(sub(target, position));
  // Same guard as the engine: looking_at refuses an up parallel to the view.
  const up: Vec3 = Math.abs(dot(forward, [0, 1, 0])) > 0.999 ? [0, 0, -1] : [0, 1, 0];
  const z = scale(forward, -1);
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  return { x, y, z };
}

export interface Projected {
  u: number;
  v: number;
  /** Distance along the view direction; <= 0 means behind the lens. */
  depth: number;
}

export function project(pose: CameraPose, aspect: number, point: Vec3): Projected {
  const basis = lookAtBasis(pose.position, pose.look_at);
  const rel = sub(point, pose.position);
  const cx = dot(rel, basis.x);
  const cy = dot(rel, basis.y);
  const cz = dot(rel, basis.z);
  const depth = -cz;
  const tanV = Math.tan(rad(pose.fov) / 2);
  const tanH = tanV * aspect;
  if (depth <= 1e-6) return { u: Number.NaN, v: Number.NaN, depth };
  const xNdc = cx / (depth * tanH);
  const yNdc = cy / (depth * tanV);
  return { u: (xNdc + 1) / 2, v: (1 - yNdc) / 2, depth };
}

/** World direction of the ray through screen point (u, v). */
export function rayDirection(pose: CameraPose, aspect: number, u: number, v: number): Vec3 {
  const basis = lookAtBasis(pose.position, pose.look_at);
  const tanV = Math.tan(rad(pose.fov) / 2);
  const x = (u * 2 - 1) * tanV * aspect;
  const y = (1 - v * 2) * tanV;
  return normalize(add(add(scale(basis.x, x), scale(basis.y, y)), scale(basis.z, -1)));
}

export interface ScreenBox {
  /** Clipped to the frame, normalized 0..1. */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Unclipped extent (may exceed 0..1); NaN when a corner is behind the lens. */
  rawWidth: number;
  rawHeight: number;
  /** Fraction of the 8 corners that land inside the frame. */
  cornersInFrame: number;
  anyBehind: boolean;
}

export function screenBox(pose: CameraPose, aspect: number, box: Aabb): ScreenBox {
  let u0 = Infinity;
  let v0 = Infinity;
  let u1 = -Infinity;
  let v1 = -Infinity;
  let inside = 0;
  let behind = false;
  const corners = aabbCorners(box);
  for (const corner of corners) {
    const p = project(pose, aspect, corner);
    if (p.depth <= 1e-6) {
      behind = true;
      continue;
    }
    u0 = Math.min(u0, p.u);
    v0 = Math.min(v0, p.v);
    u1 = Math.max(u1, p.u);
    v1 = Math.max(v1, p.v);
    if (p.u >= 0 && p.u <= 1 && p.v >= 0 && p.v <= 1) inside += 1;
  }
  if (!Number.isFinite(u0)) {
    return { u0: 0, v0: 0, u1: 0, v1: 0, rawWidth: Number.NaN, rawHeight: Number.NaN, cornersInFrame: 0, anyBehind: true };
  }
  return {
    u0: clamp(u0, 0, 1),
    v0: clamp(v0, 0, 1),
    u1: clamp(u1, 0, 1),
    v1: clamp(v1, 0, 1),
    rawWidth: behind ? Number.NaN : u1 - u0,
    rawHeight: behind ? Number.NaN : v1 - v0,
    cornersInFrame: inside / corners.length,
    anyBehind: behind,
  };
}

/** How much of the frame the box spans along its limiting dimension
 *  (max of width and height fractions). Infinity when a corner is behind. */
export function frameFill(pose: CameraPose, aspect: number, box: Aabb): number {
  const s = screenBox(pose, aspect, box);
  if (s.anyBehind || !Number.isFinite(s.rawWidth)) return Infinity;
  return Math.max(s.rawWidth, s.rawHeight);
}

/** Unit vector from azimuth (0 = +Z, 90 = +X) and elevation (degrees, + = up). */
export function directionFromAngles(azimuthDeg: number, elevationDeg: number): Vec3 {
  const az = rad(azimuthDeg);
  const el = rad(elevationDeg);
  return [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
}

/**
 * Distance from `lookAt` along `toCamera` (unit) at which the box fills
 * `fill` of the frame along its limiting dimension. Binary search: fill falls
 * monotonically as the camera backs away once every corner is in front.
 */
export function fitDistance(box: Aabb, lookAt: Vec3, toCamera: Vec3, fov: number, aspect: number, fill: number): number {
  const dir = normalize(toCamera);
  const radius = Math.max(0.05, length(box.size) / 2);
  let lo = 0.05;
  let hi = Math.max(1, radius / Math.tan(rad(Math.min(fov, fov * aspect)) / 2) * 50);
  const fillAt = (d: number): number => frameFill({ position: add(lookAt, scale(dir, d)), look_at: lookAt, fov }, aspect, box);
  if (fillAt(hi) > fill) return hi;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (fillAt(mid) > fill) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Direction presets the screenshot tool uses (direction FROM the subject TO
 *  the camera). "iso" matches ScenePreview's 3/4 view (camera at -X, +Y, -Z). */
export const DIRECTION_PRESETS = {
  front: [0, 0, 1],
  back: [0, 0, -1],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, 1, 0],
  iso: [-1, 0.7, -1],
} as const satisfies Record<string, Vec3>;
export type DirectionPreset = keyof typeof DIRECTION_PRESETS;
export const DIRECTION_PRESET_NAMES = ["front", "back", "left", "right", "top", "iso"] as const satisfies readonly DirectionPreset[];

const NUM = "[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?";
const VECTOR3_LITERAL = new RegExp(`^\\s*Vector3\\s*\\(\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*\\)\\s*$`);

/** Parse a Godot "Vector3(x, y, z)" literal; throws ToolInputError (nothing sent). */
export function parseVector3(literal: string, label: string): Vec3 {
  const match = VECTOR3_LITERAL.exec(literal);
  if (!match) {
    throw new ToolInputError(`${label} must be a Godot literal like "Vector3(0, 5, 12)" (got ${JSON.stringify(literal)}). Nothing was sent.`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** "Vector3(x, y, z)" with 3 decimals — the literal the engine echoes. */
export function formatVector3(v: Vec3): string {
  const f = (n: number) => {
    const r = Math.round(n * 1000) / 1000;
    return Object.is(r, -0) ? "0" : String(r);
  };
  return `Vector3(${f(v[0])}, ${f(v[1])}, ${f(v[2])})`;
}

export function roundVec(v: Vec3, digits = 3): Vec3 {
  const k = 10 ** digits;
  return [Math.round(v[0] * k) / k, Math.round(v[1] * k) / k, Math.round(v[2] * k) / k];
}

/** Rotate `v` about +Y by `degrees` (counter-clockwise seen from above). */
export function rotateY(v: Vec3, degrees: number): Vec3 {
  const a = rad(degrees);
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
}

/** Horizontal angle (degrees) that moves a centered subject to a vertical
 *  third line for this fov/aspect. */
export function thirdsYawOffset(fov: number, aspect: number): number {
  const tanH = Math.tan(rad(fov) / 2) * aspect;
  return deg(Math.atan(tanH / 3));
}

/** Horizon line position (v, 0 = top) for a level camera pitched by `pitchDeg`
 *  (+ = looking up); null when the horizon is outside the frame. */
export function horizonV(pitchDeg: number, fov: number): number | null {
  const v = 0.5 + Math.tan(rad(pitchDeg)) / (2 * Math.tan(rad(fov) / 2));
  return v >= 0 && v <= 1 ? v : null;
}

export function pitchOf(pose: CameraPose): number {
  const f = normalize(sub(pose.look_at, pose.position));
  return deg(Math.asin(clamp(f[1], -1, 1)));
}

/**
 * The low-angle rule (camera-collision-avoidance): a camera that would sit
 * below `minY` on its line of sight to `lookAt` moves CLOSER along that line
 * and widens its FOV so the subject keeps its size in frame, instead of being
 * buried in the ground or pushed up out of the low angle.
 */
export function applyLowAngleRule(
  lookAt: Vec3,
  toCamera: Vec3,
  dist: number,
  fov: number,
  minY: number,
  maxFov: number
): { position: Vec3; distance: number; fov: number; adjusted: boolean; impossible?: boolean } {
  const dir = normalize(toCamera);
  const position = add(lookAt, scale(dir, dist));
  if (position[1] >= minY || dir[1] >= -0.02) return { position, distance: dist, fov, adjusted: false };
  const d2 = (minY - lookAt[1]) / dir[1];
  if (!(d2 >= 0.5)) return { position, distance: dist, fov, adjusted: false, impossible: true };
  const fov2 = clamp(deg(2 * Math.atan((Math.tan(rad(fov) / 2) * dist) / d2)), fov, maxFov);
  return { position: add(lookAt, scale(dir, d2)), distance: d2, fov: fov2, adjusted: true };
}

/**
 * Crop rectangle (normalized u0,v0,u1,v1 of a reference frame) padded and
 * grown to `aspect` (width/height in pixels of that frame), clamped to the
 * frame. Used by zoom to turn a mark box or region into a render window.
 */
export function cropForAspect(
  rect: { u0: number; v0: number; u1: number; v1: number },
  refAspect: number,
  outAspect: number,
  pad = 0.15
): [number, number, number, number] {
  let w = Math.max(1e-4, rect.u1 - rect.u0);
  let h = Math.max(1e-4, rect.v1 - rect.v0);
  const cu = (rect.u0 + rect.u1) / 2;
  const cv = (rect.v0 + rect.v1) / 2;
  w *= 1 + pad * 2;
  h *= 1 + pad * 2;
  // In pixels of the reference frame the crop's aspect is (w*refAspect)/h.
  const current = (w * refAspect) / h;
  if (current < outAspect) w = (h * outAspect) / refAspect;
  else h = (w * refAspect) / outAspect;
  if (w > 1) {
    h /= w;
    w = 1;
  }
  if (h > 1) {
    w /= h;
    h = 1;
  }
  const u0 = clamp(cu - w / 2, 0, 1 - w);
  const v0 = clamp(cv - h / 2, 0, 1 - h);
  return [u0, v0, u0 + w, v0 + h];
}
