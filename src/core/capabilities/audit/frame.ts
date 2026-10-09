/**
 * Framing for render:"sheet": a camera per issue, on the OPEN side of the
 * problem. Each issue carries directions the kernel measured with two-sided
 * rays (any surface counts, front or back face), so a camera placed within
 * the measured clear distance is never behind a wall or inside geometry:
 * walls render one-sided, and a camera behind one sees straight through it.
 */
import { add, clamp, scale, type CameraPose, type Vec3 } from "../seeing/math.js";
import { fitCameraDistance } from "./math.js";
import type { FrameHint } from "./judge.js";

export const SHEET_FOV = 50;
export const SHEET_TILES = 6;
const MIN_DISTANCE = 0.7;
const CLEARANCE_MARGIN = 0.3;

/** The pose from the best measured direction: preference x share of the
 *  wanted distance that is actually clear. Null when nothing is clear. */
export function choosePose(hint: FrameHint | undefined, fov = SHEET_FOV): CameraPose | null {
  if (!hint) return null;
  if (hint.viewer) return { position: hint.viewer, look_at: hint.focus, fov };
  const want = clamp(fitCameraDistance(hint.size, fov), 1.5, 9);
  let best: { dir: Vec3; dist: number; score: number } | null = null;
  for (const d of hint.dirs) {
    const available = d.clear - CLEARANCE_MARGIN;
    if (available < MIN_DISTANCE || d.pref <= 0) continue;
    const dist = Math.min(want, available);
    const score = d.pref * (dist / want);
    if (!best || score > best.score) best = { dir: d.dir, dist, score };
  }
  if (!best) return null;
  return { position: add(hint.focus, scale(best.dir, best.dist)), look_at: hint.focus, fov };
}
