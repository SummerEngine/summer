import type { Vec3 } from "./placement-math.js";

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
