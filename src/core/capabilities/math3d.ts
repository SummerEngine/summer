/**
 * Row matrices for the inspector's YXZ Euler transform fallback.
 * Godot's Transform3D literal lists matrix rows followed by the origin.
 * Placement and surface snapping use the basis columns in placement-math.ts.
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
