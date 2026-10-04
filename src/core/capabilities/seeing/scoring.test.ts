import { describe, expect, it } from "vitest";
import { generateCandidates, type Candidate } from "./candidates.js";
import { foregroundScore, horizonScore, pickTop, rejectionCounts, scoreMeasurement, thirdsScore, type Measurement, type ScoringOptions } from "./scoring.js";
import { aabbCenter, distance, type Aabb, type CameraPose } from "./math.js";

const BOX: Aabb = { position: [-5, 0, -5], size: [10, 10, 10] };
const COLS = 24;
const ROWS = 14;
const OPTS: ScoringOptions = { shot: "establishing", aspect: 16 / 9, gridCols: COLS, gridRows: ROWS, subject: BOX, maxHardFraction: 0.34, maxSoftFraction: 0.67 };
const CAND: Candidate = generateCandidates({ shot: "establishing", subject: BOX, aspect: 16 / 9 })[2]!;

/** A synthetic grid: top rows sky, a subject block in the middle, ground below. */
function grid(fill: (row: number, col: number) => [string, number]): { grid: string; dist: number[] } {
  let g = "";
  const d: number[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const [code, dist] = fill(r, c);
      g += code;
      d.push(dist);
    }
  }
  return { grid: g, dist: d };
}

function measurement(overrides: Partial<Measurement> = {}): Measurement {
  const base = grid((r, c) => (r < 4 ? [".", -1] : r < 10 && c > 6 && c < 18 ? ["S", 30] : ["H", 20 + r]));
  return { i: 2, position: CAND.position, look_at: CAND.look_at, fov: CAND.fov, vis: "VVVVVVVVV", ...base, ...overrides };
}

describe("smart framing scores", () => {
  it("scores a clear, well-filled view highly with every term in 0..1", () => {
    const s = scoreMeasurement(measurement(), CAND, OPTS);
    expect(s.rejected).toBeUndefined();
    expect(s.total).toBeGreaterThan(0.6);
    for (const v of Object.values(s.terms)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(s.terms.visibility).toBe(1);
  });

  it("rejects a pose whose subject is blocked by hard geometry (walls, terrain)", () => {
    const s = scoreMeasurement(measurement({ vis: "HHHHVVVVV", blockers_hard: ["Walls/North"] }), CAND, OPTS);
    expect(s.rejected).toBe("hard_blocked");
    expect(s.blockers?.hard).toEqual(["Walls/North"]);
    // The center sample blocked is enough on its own.
    expect(scoreMeasurement(measurement({ vis: "HVVVVVVVV" }), CAND, OPTS).rejected).toBe("hard_blocked");
  });

  it("allows soft occluders in front (framing) and rejects only an overload", () => {
    const framed = scoreMeasurement(measurement({ vis: "VFFVVVVVV", blockers_soft: ["Props/Fence"] }), CAND, OPTS);
    expect(framed.rejected).toBeUndefined();
    expect(framed.terms.visibility).toBeGreaterThan(0.8);
    expect(scoreMeasurement(measurement({ vis: "VFFFFFFFV" }), CAND, OPTS).rejected).toBe("soft_overload");
  });

  it("passes the engine's own rejections through (near lens, below ground)", () => {
    const s = scoreMeasurement({ i: 0, position: CAND.position, look_at: CAND.look_at, fov: 55, rejected: "near_lens_blocked", near_lens_hit: "Props/Pipe" }, CAND, OPTS);
    expect(s.rejected).toBe("near_lens_blocked");
    expect(s.blockers?.lens).toBe("Props/Pipe");
  });

  it("penalises a wall at the lens and empty frame areas", () => {
    const clear = scoreMeasurement(measurement(), CAND, OPTS);
    const walled = scoreMeasurement(measurement(grid((r, c) => (c < 12 ? ["H", 1.0] : r < 4 ? [".", -1] : ["S", 30]))), CAND, OPTS);
    expect(walled.terms.clear!).toBeLessThan(clear.terms.clear!);
    expect(walled.total).toBeLessThan(clear.total);
    const voidy = scoreMeasurement(measurement(grid((r) => (r < 4 ? [".", -1] : r < 9 ? ["S", 30] : [".", -1]))), CAND, OPTS);
    expect(voidy.terms.void!).toBeLessThan(clear.terms.void!);
  });

  it("rewards depth behind the subject over a flat wall right behind it", () => {
    const D = distance(CAND.position, aabbCenter(BOX));
    const deep = scoreMeasurement(measurement(grid((r, c) => (r < 4 ? [".", -1] : c > 6 && c < 18 && r < 10 ? ["S", D] : ["H", D * 3]))), CAND, OPTS);
    const flat = scoreMeasurement(measurement(grid((r, c) => (c > 6 && c < 18 && r < 10 ? ["S", D] : ["H", D * 1.1]))), CAND, OPTS);
    expect(deep.terms.depth!).toBeGreaterThan(flat.terms.depth!);
    expect(flat.stats!.wallBehind).toBeGreaterThan(0.3);
  });

  it("foreground framing is wanted up to a limit", () => {
    expect(foregroundScore(0.1, 0.1, 0.3)).toBe(1);
    expect(foregroundScore(0, 0.1, 0.3)).toBeLessThan(1);
    expect(foregroundScore(0.6, 0.1, 0.3)).toBe(0);
  });

  it("thirds favour a subject on a third line; horizon is level and centred only for eye-level shots", () => {
    const pose: CameraPose = { position: [0, 5, 40], look_at: [0, 5, 0], fov: 50 };
    const centered = thirdsScore(pose, 16 / 9, { position: [-1, 4, -1], size: [2, 2, 2] });
    const offset = thirdsScore({ ...pose, look_at: [5.5, 5, 0] }, 16 / 9, { position: [-1, 4, -1], size: [2, 2, 2] });
    expect(offset).toBeGreaterThan(centered);
    expect(horizonScore(pose, "establishing")).toBeLessThan(horizonScore(pose, "eye_level"));
  });

  it("pickTop skips near-duplicates and counts rejections by reason", () => {
    const a = scoreMeasurement(measurement(), CAND, OPTS);
    const b = { ...a, id: "dup", total: a.total - 0.01 };
    const c = { ...a, id: "other", total: a.total - 0.02, pose: { ...a.pose, position: [a.pose.position[0] + 50, a.pose.position[1], a.pose.position[2]] as const } };
    const r = scoreMeasurement(measurement({ vis: "HHHHHHHHH" }), CAND, OPTS);
    const top = pickTop([b, r, a, c], 3, 2);
    expect(top.map((t) => t.id)).toEqual([a.id, "other"]);
    expect(rejectionCounts([a, r])).toEqual({ hard_blocked: 1 });
  });
});
