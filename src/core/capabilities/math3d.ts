/**
 * math3d — the little 3D math the read and placement helpers need, in
 * Godot's conventions: a Basis is three ROWS (Transform3D literals list
 * xx, xy, xz, yx, ... then the origin), Euler angles default to YXZ order,
 * and a Node3D's local basis is rotation * scale.
 */

export type Vec3 = [number, number, number];
export type Mat3 = [Vec3, Vec3, Vec3];

export const IDENTITY3: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

export function mulMat3(a: Mat3, b: Mat3): Mat3 {
  const out: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) out[i]![j] = a[i]![0] * b[0]![j]! + a[i]![1] * b[1]![j]! + a[i]![2] * b[2]![j]!;
  }
  return out as Mat3;
}

export function applyMat3(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

/** Inverse, or null for a singular basis. */
export function invertMat3(m: Mat3): Mat3 | null {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

/** Godot Basis::from_euler (YXZ order, degrees) times scale: R * S. */
export function basisFromEulerScale(rotDeg: Vec3, scale: Vec3): Mat3 {
  const [x, y, z] = rotDeg.map((d) => (d * Math.PI) / 180) as Vec3;
  const xm: Mat3 = [[1, 0, 0], [0, Math.cos(x), -Math.sin(x)], [0, Math.sin(x), Math.cos(x)]];
  const ym: Mat3 = [[Math.cos(y), 0, Math.sin(y)], [0, 1, 0], [-Math.sin(y), 0, Math.cos(y)]];
  const zm: Mat3 = [[Math.cos(z), -Math.sin(z), 0], [Math.sin(z), Math.cos(z), 0], [0, 0, 1]];
  const s: Mat3 = [[scale[0], 0, 0], [0, scale[1], 0], [0, 0, scale[2]]];
  return mulMat3(mulMat3(mulMat3(ym, xm), zm), s);
}

/** "(1, 2, 3)" / "Vector3(1, 2, 3)" -> [1, 2, 3]. */
export function parseVec3(value: unknown): Vec3 | null {
  if (typeof value !== "string") return null;
  const match = /^\s*(?:Vector3)?\(\s*([-+0-9.eE]+)\s*,\s*([-+0-9.eE]+)\s*,\s*([-+0-9.eE]+)\s*\)\s*$/.exec(value);
  if (!match) return null;
  const out = [Number(match[1]), Number(match[2]), Number(match[3])] as Vec3;
  return out.every(Number.isFinite) ? out : null;
}

/** A `Transform3D(12 numbers)` literal -> basis rows + origin. */
export function parseTransform3D(value: string): { basis: Mat3; origin: Vec3 } | null {
  const match = /^\s*Transform3D\(([^)]*)\)\s*$/.exec(value);
  if (!match) return null;
  const n = match[1]!.split(",").map((part) => Number(part.trim()));
  if (n.length !== 12 || !n.every(Number.isFinite)) return null;
  return {
    basis: [[n[0]!, n[1]!, n[2]!], [n[3]!, n[4]!, n[5]!], [n[6]!, n[7]!, n[8]!]],
    origin: [n[9]!, n[10]!, n[11]!],
  };
}

function num3(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/** Vector3 literal at 3 decimals (for reports). */
export function vec3Literal(v: Vec3): string {
  return `Vector3(${v.map(num3).join(", ")})`;
}

/** Vector3 literal for writing a position back: 12 significant digits
 *  (beyond Godot's float32 storage) without binary-arithmetic noise. */
export function vec3LiteralExact(v: Vec3): string {
  return `Vector3(${v.map((value) => {
    const clean = Number(value.toPrecision(12));
    return String(Object.is(clean, -0) ? 0 : clean);
  }).join(", ")})`;
}

export function transformLiteral(basis: Mat3, origin: Vec3): string {
  return `Transform3D(${[...basis[0], ...basis[1], ...basis[2], ...origin].map(num3).join(", ")})`;
}
