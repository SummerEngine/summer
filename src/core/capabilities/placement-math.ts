/**
 * Small, dependency-free 3D math for the placement tools (tool/place-adjacent,
 * tool/attach-to-surface, tool/connect-ports, tool/repeat-along) and the
 * Godot variant-string formatting they send through SetProp.
 *
 * Conventions:
 * - A basis is three COLUMN vectors [x, y, z] (Godot's Basis.x/.y/.z).
 * - A transform is { basis, origin } and maps local -> parent space.
 * - "Scene space" is the scene root's frame, the same space GetWorldSnapshot
 *   and the placement scripts report; in the editor it equals world space.
 * - Godot's Transform3D(...) string lists the basis ROW-major, then the origin
 *   (core/variant/variant_parser.cpp), so toGodotTransform transposes.
 */

export type Vec3 = [number, number, number];
export type Basis3 = [Vec3, Vec3, Vec3];
export interface Xform {
  basis: Basis3;
  origin: Vec3;
}

export const AXIS_NAMES = ["+x", "-x", "+y", "-y", "+z", "-z"] as const;
export type SignedAxis = (typeof AXIS_NAMES)[number];
export const WORLD_AXES = ["x", "y", "z"] as const;
export type WorldAxis = (typeof WORLD_AXES)[number];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

export function normalize(a: Vec3): Vec3 {
  const len = length(a);
  if (!(len > 1e-12)) throw new Error("cannot normalize a zero-length vector");
  return scale(a, 1 / len);
}

export function isFiniteVec3(value: unknown): value is Vec3 {
  return Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number" && Number.isFinite(n));
}

export function axisIndex(axis: WorldAxis): 0 | 1 | 2 {
  return axis === "x" ? 0 : axis === "y" ? 1 : 2;
}

/** Unit vector for a signed axis name such as "-z". */
export function signedAxisVector(axis: SignedAxis): Vec3 {
  const sign = axis[0] === "-" ? -1 : 1;
  const out: Vec3 = [0, 0, 0];
  out[axisIndex(axis[1] as WorldAxis)] = sign;
  return out;
}

export function sameAxisLine(a: SignedAxis, b: SignedAxis): boolean {
  return a[1] === b[1];
}

export const IDENTITY_BASIS: Basis3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

export function basisMulVec(b: Basis3, v: Vec3): Vec3 {
  return [
    b[0][0] * v[0] + b[1][0] * v[1] + b[2][0] * v[2],
    b[0][1] * v[0] + b[1][1] * v[1] + b[2][1] * v[2],
    b[0][2] * v[0] + b[1][2] * v[1] + b[2][2] * v[2],
  ];
}

export function basisMul(a: Basis3, b: Basis3): Basis3 {
  return [basisMulVec(a, b[0]), basisMulVec(a, b[1]), basisMulVec(a, b[2])];
}

export function basisTranspose(b: Basis3): Basis3 {
  return [
    [b[0][0], b[1][0], b[2][0]],
    [b[0][1], b[1][1], b[2][1]],
    [b[0][2], b[1][2], b[2][2]],
  ];
}

export function basisDeterminant(b: Basis3): number {
  return dot(b[0], cross(b[1], b[2]));
}

/** General 3x3 inverse (parents may carry non-uniform scale). */
export function basisInverse(b: Basis3): Basis3 {
  const det = basisDeterminant(b);
  if (!(Math.abs(det) > 1e-12)) throw new Error("basis is not invertible");
  // Rows of the inverse are the cross products of the columns, divided by det.
  const r0 = scale(cross(b[1], b[2]), 1 / det);
  const r1 = scale(cross(b[2], b[0]), 1 / det);
  const r2 = scale(cross(b[0], b[1]), 1 / det);
  return basisTranspose([r0, r1, r2]);
}

export function xformMulPoint(t: Xform, p: Vec3): Vec3 {
  return add(basisMulVec(t.basis, p), t.origin);
}

export function xformCompose(a: Xform, b: Xform): Xform {
  return { basis: basisMul(a.basis, b.basis), origin: xformMulPoint(a, b.origin) };
}

export function xformInverse(t: Xform): Xform {
  const inv = basisInverse(t.basis);
  return { basis: inv, origin: scale(basisMulVec(inv, t.origin), -1) };
}

/** 12 numbers, basis columns then origin (the placement scripts' wire form). */
export function xformFromArray(values: unknown): Xform {
  if (!Array.isArray(values) || values.length !== 12 || !values.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new Error("expected a 12-number transform array");
  }
  const v = values as number[];
  return {
    basis: [
      [v[0]!, v[1]!, v[2]!],
      [v[3]!, v[4]!, v[5]!],
      [v[6]!, v[7]!, v[8]!],
    ],
    origin: [v[9]!, v[10]!, v[11]!],
  };
}

/** Column lengths: the per-axis scale a basis applies. */
export function basisScale(b: Basis3): Vec3 {
  return [length(b[0]), length(b[1]), length(b[2])];
}

/** Rotation by `angle` radians about unit `axis` (Rodrigues). */
export function rotationAbout(axis: Vec3, angle: number): Basis3 {
  const [x, y, z] = normalize(axis);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  // Columns of the rotation matrix.
  return [
    [t * x * x + c, t * x * y + s * z, t * x * z - s * y],
    [t * x * y - s * z, t * y * y + c, t * y * z + s * x],
    [t * x * z + s * y, t * y * z - s * x, t * z * z + c],
  ];
}

/** Shortest-arc rotation taking unit `from` onto unit `to`. For opposite
 *  vectors the half-turn axis is `fallbackAxis` made perpendicular to `from`. */
export function rotationBetween(from: Vec3, to: Vec3, fallbackAxis: Vec3 = [0, 1, 0]): Basis3 {
  const f = normalize(from);
  const t = normalize(to);
  const c = Math.max(-1, Math.min(1, dot(f, t)));
  const axis = cross(f, t);
  const axisLength = length(axis);
  if (axisLength < 1e-9) {
    if (c > 0) return IDENTITY_BASIS;
    let perpendicular = sub(fallbackAxis, scale(f, dot(fallbackAxis, f)));
    if (length(perpendicular) < 1e-6) {
      const other: Vec3 = Math.abs(f[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
      perpendicular = sub(other, scale(f, dot(other, f)));
    }
    return rotationAbout(perpendicular, Math.PI);
  }
  return rotationAbout(scale(axis, 1 / axisLength), Math.atan2(axisLength, c));
}

/** The rotation mapping local frame (a, b, a x b) onto world frame (A, B, A x B).
 *  a/b and A/B must each be orthonormal pairs. */
export function rotationFromFrames(localA: Vec3, localB: Vec3, worldA: Vec3, worldB: Vec3): Basis3 {
  const local: Basis3 = [localA, localB, cross(localA, localB)];
  const world: Basis3 = [worldA, worldB, cross(worldA, worldB)];
  return basisMul(world, basisTranspose(local));
}

/** Angle in degrees between two directions. */
export function angleDegrees(a: Vec3, b: Vec3): number {
  const c = dot(normalize(a), normalize(b));
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
}

/** Round for model-visible output (millimetres by default). */
export function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function roundVec(v: Vec3, digits = 3): Vec3 {
  return [round(v[0], digits), round(v[1], digits), round(v[2], digits)];
}

/** A number in Godot variant-string form: fixed-point, never exponent notation. */
export function godotNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error("non-finite number in a variant string");
  const fixed = value.toFixed(6).replace(/\.?0+$/, "");
  return fixed === "-0" || fixed === "" ? "0" : fixed;
}

export function toGodotVector3(v: Vec3): string {
  return `Vector3(${v.map(godotNumber).join(", ")})`;
}

export function toGodotTransform(t: Xform): string {
  const [x, y, z] = t.basis;
  const rows = [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
  return `Transform3D(${[...rows, ...t.origin].map(godotNumber).join(", ")})`;
}

const NUMBER = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
const VECTOR3_STRING = new RegExp(String.raw`^\s*Vector3\(\s*(${NUMBER})\s*,\s*(${NUMBER})\s*,\s*(${NUMBER})\s*\)\s*$`);
const TRANSFORM3D_STRING = new RegExp(
  String.raw`^\s*Transform3D\(\s*(${NUMBER}(?:\s*,\s*${NUMBER}){11})\s*\)\s*$`
);

/** Parse "Vector3(x, y, z)" into numbers, or null when it is not one. */
export function parseGodotVector3(value: string): Vec3 | null {
  const match = VECTOR3_STRING.exec(value);
  if (!match) return null;
  const out = [Number(match[1]), Number(match[2]), Number(match[3])] as Vec3;
  return out.every(Number.isFinite) ? out : null;
}

/** Parse "Transform3D(<12 numbers>)" (Godot row-major basis, then origin). */
export function parseGodotTransform(value: string): Xform | null {
  const match = TRANSFORM3D_STRING.exec(value);
  if (!match) return null;
  const n = match[1]!.split(",").map((part) => Number(part.trim()));
  if (n.length !== 12 || !n.every(Number.isFinite)) return null;
  return {
    basis: [
      [n[0]!, n[3]!, n[6]!],
      [n[1]!, n[4]!, n[7]!],
      [n[2]!, n[5]!, n[8]!],
    ],
    origin: [n[9]!, n[10]!, n[11]!],
  };
}
