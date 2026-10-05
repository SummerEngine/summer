import { describe, expect, it } from "vitest";
import { chooseCorridorAxis, corridorBox, generateCandidates, type Candidate } from "./candidates.js";
import {
  EMPTY_LIMIT,
  eyeProblem,
  foregroundScore,
  horizonScore,
  lightScore,
  pickTop,
  poseYaw,
  rankOrder,
  rejectionCounts,
  scoreMeasurement,
  sideOf,
  thirdsScore,
  viewProblem,
  type Measurement,
  type ScoringOptions,
} from "./scoring.js";
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

  it("the image check marks featureless frame areas (sky excluded) and near/far value contrast", () => {
    const base = measurement();
    const cells = base.grid!.length;
    const textured = scoreMeasurement({ ...base, lum: "5".repeat(cells), tex: "4".repeat(cells) }, CAND, OPTS);
    const flat = scoreMeasurement({ ...base, lum: "5".repeat(cells), tex: "0".repeat(cells) }, CAND, OPTS);
    expect(textured.terms.detail).toBe(1);
    expect(flat.terms.detail).toBe(0);
    expect(flat.total).toBeLessThan(textured.total);
    // Sky cells are smooth on purpose: they never count as featureless.
    const skyOnlyFlat = scoreMeasurement({ ...base, lum: "5".repeat(cells), tex: [...base.grid!].map((c) => (c === "." ? "0" : "4")).join("") }, CAND, OPTS);
    expect(skyOnlyFlat.stats!.flat).toBe(0);
    // Near (ground, 20 m) dark vs far wall (90 m) light reads as contrast.
    const D = distance(CAND.position, aabbCenter(BOX));
    const g = grid((r) => (r < 7 ? ["H", D * 3] : ["H", D * 0.5]));
    const lum = [...g.grid].map((_, k) => (Math.floor(k / COLS) < 7 ? "8" : "3")).join("");
    const contrasted = scoreMeasurement({ ...base, ...g, lum, tex: "4".repeat(cells) }, CAND, OPTS);
    expect(contrasted.terms.contrast).toBe(1);
    expect(scoreMeasurement(base, CAND, OPTS).terms.detail).toBeUndefined();
  });

  it("corridor shots prefer looking in from the open end and walls on both sides", () => {
    const corridorOpts: ScoringOptions = { ...OPTS, shot: "corridor" };
    // Walls on both frame edges at similar distances, the far end in the middle.
    const both = grid((r, c) => (c < 6 || c >= 18 ? ["H", 4] : r < 4 ? [".", -1] : ["H", 20]));
    const oneSided = grid((r, c) => (c >= 18 ? ["H", 4] : c < 6 ? ["H", 30] : r < 4 ? [".", -1] : ["H", 20]));
    const inward = scoreMeasurement({ ...measurement(both), vis: "VVVVVV" }, { ...CAND, into: 1 }, corridorOpts);
    const outward = scoreMeasurement({ ...measurement(both), vis: "VVVVVV" }, { ...CAND, into: 0 }, corridorOpts);
    expect(inward.terms.entry).toBe(1);
    expect(inward.total).toBeGreaterThan(outward.total);
    const lopsided = scoreMeasurement({ ...measurement(oneSided), vis: "VVVVVV" }, { ...CAND, into: 1 }, corridorOpts);
    expect(inward.terms.balance!).toBeGreaterThan(lopsided.terms.balance!);
  });
});

describe("back faces: a camera behind a one-sided wall (proof run: frame_shot corridor winner behind Backdrop/BD_A)", () => {
  const corridorOpts: ScoringOptions = { ...OPTS, shot: "corridor" };

  it("rejects a corridor pose that looks through the back of a wall, even when every sight line slips through its door hole", () => {
    // The v2 winner: camera 3 m behind BD_A at z -19.2, every corridor sample
    // visible through the door hole, but most of the frame is BD_A's back.
    const behind = grid((r, c) => (c >= 9 && c <= 13 && r >= 5 ? ["H", 12] : ["B", 3]));
    const s = scoreMeasurement({ ...measurement(behind), vis: "VVVVVV" }, { ...CAND, into: 1 }, corridorOpts);
    expect(s.rejected).toBe("behind_surface");
    expect(s.stats!.back).toBeGreaterThan(0.25);
    // The same frame seeing those walls from the front ranks normally.
    const inside = scoreMeasurement({ ...measurement(grid((r, c) => (c >= 9 && c <= 13 && r >= 5 ? ["H", 12] : ["H", 3]))), vis: "VVVVVV" }, { ...CAND, into: 1 }, corridorOpts);
    expect(inside.rejected).toBeUndefined();
  });

  it("a sight line crossing a surface from behind blocks like a wall (centre sample, or a third of them)", () => {
    expect(scoreMeasurement(measurement({ vis: "BVVVVVVVV", blockers_back: ["Backdrop/BD_A"] }), CAND, OPTS).rejected).toBe("behind_surface");
    const third = scoreMeasurement(measurement({ vis: "VBBBBVVVV", blockers_back: ["Backdrop/BD_A"] }), CAND, OPTS);
    expect(third.rejected).toBe("behind_surface");
    expect(third.hardFraction).toBeCloseTo(4 / 9, 2);
    expect(third.blockers?.back).toEqual(["Backdrop/BD_A"]);
    const problem = viewProblem(measurement({ vis: "VBBBBVVVV", blockers_back: ["Backdrop/BD_A"] }));
    expect(problem).toMatchObject({ reason: "behind_surface", blockers: ["Backdrop/BD_A"] });
    expect(problem!.detail).toContain("4 of 9 sight lines");
  });

  it("a few back-face cells (an open box seen from above) only cost the solid term", () => {
    const open = grid((r, c) => (r < 4 ? [".", -1] : r < 10 && c > 6 && c < 18 ? (c < 9 ? ["B", 30] : ["S", 30]) : ["H", 20 + r]));
    const s = scoreMeasurement(measurement(open), CAND, OPTS);
    expect(s.rejected).toBeUndefined();
    expect(s.terms.solid!).toBeLessThan(1);
    expect(s.total).toBeLessThan(scoreMeasurement(measurement(), CAND, OPTS).total);
  });

  it("passes the engine's closed-shell and behind-surface lens rejections through with a reason", () => {
    const inside = viewProblem({ i: 0, position: [0, 1, 0], look_at: [0, 1, -5], fov: 50, rejected: "inside_volume" });
    expect(inside?.reason).toBe("inside_volume");
    expect(inside?.detail).toContain("closed shell");
    const behind = scoreMeasurement({ i: 0, position: CAND.position, look_at: CAND.look_at, fov: 55, rejected: "behind_surface", near_lens_hit: "Backdrop/BD_A" }, CAND, OPTS);
    expect(behind.rejected).toBe("behind_surface");
    expect(behind.blockers?.lens).toBe("Backdrop/BD_A");
  });
});

describe("transparent surfaces pass at partial weight (trial: foliage cards blocked like walls)", () => {
  it("sight lines through alpha/glass surfaces count 0.8, are never hard or soft overload", () => {
    const through = scoreMeasurement(measurement({ vis: "TTTTTTTTT", seen_through: ["Plants/IvyCards"] }), CAND, OPTS);
    expect(through.rejected).toBeUndefined();
    expect(through.terms.visibility).toBeCloseTo(0.8, 5);
    expect(through.blockers?.through).toEqual(["Plants/IvyCards"]);
    // The same cover as solid soft geometry is an overload.
    expect(scoreMeasurement(measurement({ vis: "FFFFFFFFF" }), CAND, OPTS).rejected).toBe("soft_overload");
  });

  it("transparent foreground cells weigh half a soft cell, so a foliage-card frame is not rejected as clutter", () => {
    const leaves = (code: string) => grid((r, c) => (r < 4 ? [".", -1] : r < 10 && c > 6 && c < 18 ? ["S", 30] : [code, 3]));
    const cards = scoreMeasurement(measurement(leaves("T")), CAND, OPTS);
    const solid = scoreMeasurement(measurement(leaves("F")), CAND, OPTS);
    expect(solid.rejected).toBe("soft_overload");
    expect(cards.rejected).toBeUndefined();
    expect(cards.stats!.translucent).toBeGreaterThan(0.4);
    expect(cards.stats!.foreground).toBeCloseTo(solid.stats!.foreground / 2, 5);
  });
});

describe("establishing shots: light direction, world edge, three different views", () => {
  const side: CameraPose = { position: [0, 5, 40], look_at: [0, 5, 0], fov: 50 };

  it("lightScore: side and front-side light beat a flat front-lit face and backlight", () => {
    // The camera looks -Z. Light travelling -Z comes from behind the camera.
    const fromBehindCamera = lightScore(side, [0, -0.5, -1]);
    const frontSide = lightScore(side, [0.7, -0.5, -0.7]);
    const fromSide = lightScore(side, [1, -0.5, 0]);
    const backlit = lightScore(side, [0, -0.5, 1]);
    expect(fromSide).toBe(1);
    expect(frontSide).toBe(1);
    expect(fromBehindCamera).toBeLessThan(0.45);
    expect(backlit).toBeGreaterThan(fromBehindCamera);
    expect(backlit).toBeLessThan(fromSide);
    // A sun near the zenith lights every side alike.
    expect(lightScore(side, [0, -1, -0.05])).toBeCloseTo(0.7, 1);
  });

  it("scores the key light: a side-lit view outranks the same view lit flat from behind the camera", () => {
    const m = measurement();
    const view = { position: m.position, look_at: m.look_at, fov: m.fov };
    const dir = [view.look_at[0] - view.position[0], 0, view.look_at[2] - view.position[2]] as const;
    const sideLit = scoreMeasurement(m, CAND, { ...OPTS, keyLight: [-dir[2], -0.6, dir[0]] });
    const flatLit = scoreMeasurement(m, CAND, { ...OPTS, keyLight: [dir[0], -0.6, dir[2]] });
    expect(sideLit.terms.light).toBe(1);
    expect(flatLit.terms.light!).toBeLessThan(0.45);
    expect(sideLit.total).toBeGreaterThan(flatLit.total);
    expect(scoreMeasurement(m, CAND, OPTS).terms.light).toBeUndefined();
  });

  it("penalises the world edge: sky or void below the horizon", () => {
    const clean = scoreMeasurement(measurement(), CAND, OPTS);
    // The bottom row misses everything: the ground plane ends in view.
    const edge = scoreMeasurement(measurement(grid((r, c) => (r < 4 ? [".", -1] : r === ROWS - 1 ? [".", -1] : r < 10 && c > 6 && c < 18 ? ["S", 30] : ["H", 20 + r]))), CAND, OPTS);
    expect(edge.stats!.void).toBeGreaterThan(0.04);
    expect(edge.terms.edge).toBe(0);
    expect(clean.terms.edge).toBe(1);
    expect(clean.total - edge.total).toBeGreaterThan(0.1);
  });

  it("pickTop spreads the top 3 around the subject (trial: az000 / az030 / az330, three near-identical front views)", () => {
    const ring = generateCandidates({ shot: "establishing", subject: BOX, aspect: 16 / 9 }).filter((c) => c.id.endsWith("_el12"));
    // Scores fall off with the angle from the front, like the trial's.
    const scored = ring.map((c, i) => {
      const s = scoreMeasurement({ ...measurement(), i, position: c.position, look_at: c.look_at, fov: c.fov }, c, OPTS);
      const az = Number(c.id.slice(c.id.indexOf("_az") + 3, c.id.indexOf("_el")));
      const off = Math.min(az, 360 - az);
      return { ...s, id: c.id, total: 0.8 - off / 1000 };
    });
    const plain = pickTop(scored, 3, 2);
    expect(plain.map((p) => p.id)).toEqual(["wide_az000_el12", "wide_az030_el12", "wide_az330_el12"]);
    const center = aabbCenter(BOX);
    const top = pickTop(scored, 3, 2, { around: center, minYaw: 25, sides: true });
    expect(top[0]!.id).toBe("wide_az000_el12");
    const sides = top.map((p) => sideOf(poseYaw(p.pose, center)));
    expect(new Set(sides).size).toBe(3);
    for (let a = 0; a < top.length; a++)
      for (let b = a + 1; b < top.length; b++) {
        const d = Math.abs(poseYaw(top[a]!.pose, center) - poseYaw(top[b]!.pose, center)) % 360;
        expect(Math.min(d, 360 - d)).toBeGreaterThanOrEqual(25);
      }
    // Past the score margin the side rule gives way to the yaw spacing rule.
    const steep = scored.map((s) => ({ ...s, total: s.id === "wide_az000_el12" ? 0.9 : s.id === "wide_az030_el12" || s.id === "wide_az330_el12" ? 0.85 : 0.3 }));
    const spaced = pickTop(steep, 3, 2, { around: center, minYaw: 25, sides: true });
    expect(spaced.map((p) => p.id)).toEqual(["wide_az000_el12", "wide_az030_el12", "wide_az330_el12"]);
  });
});

// Round 1 (three_houses_v3, 2026-10-04): corridor winners were "adjusted:
// raised" to 3.5-4.25 m, and the establishing winner (27.7 m, 40 deg down)
// showed the model on a table with the empty world all round.
describe("eye-level and corridor cameras stay at eye height (round 1: winners raised to 3.5-4.25 m)", () => {
  const axis = chooseCorridorAxis([{ seed: [0, 1.6, 0], dir: [0, 0, 1], fwd: 12, back: 10, left: 1.5, right: 1.5 }], { position: [-3, 0, -10], size: [6, 8, 22] })[0]!;
  const corridor = generateCandidates({ shot: "corridor", corridor: axis, aspect: 16 / 9 })[0]!;
  const COPTS: ScoringOptions = { ...OPTS, shot: "corridor", subject: corridorBox(axis, 0) };
  const walls = grid((r, c) => (r < 3 ? [".", -1] : c < 6 || c >= 18 ? ["H", 3 + r * 0.2] : ["S", 8]));
  const at = (y: number, extra: Partial<Measurement> = {}): Measurement => ({
    i: 0,
    position: [corridor.position[0], y, corridor.position[2]],
    look_at: [corridor.look_at[0], y, corridor.look_at[2]],
    fov: corridor.fov,
    vis: "VVVVVV",
    ...walls,
    ground_y: 0,
    ...extra,
  });

  it("ranks a pose 1.5-1.8 m above the surface below it and rejects one off eye height, raised or unmeasured", () => {
    expect(eyeProblem(at(1.6), corridor)).toBeNull();
    expect(scoreMeasurement(at(1.6), corridor, COPTS).rejected).toBeUndefined();
    // The old kernel's "raised" ground-clearance push never ranks.
    const raised = scoreMeasurement(at(4.25, { adjustments: [{ kind: "raised", by: 2.65 }] }), corridor, COPTS);
    expect(raised.rejected).toBe("raised_above_eye");
    expect(scoreMeasurement(at(3.5), corridor, COPTS).rejected).toBe("above_eye_height");
    expect(scoreMeasurement(at(1.2), corridor, COPTS).rejected).toBe("below_eye_height");
    // Standing on a 2 m platform at 3.6 m is still 1.6 m above the surface below.
    expect(scoreMeasurement(at(3.6, { ground_y: 2 }), corridor, COPTS).rejected).toBeUndefined();
    expect(scoreMeasurement(at(1.6, { ground_y: undefined }), corridor, COPTS).rejected).toBe("eye_height_unverified");
    expect(scoreMeasurement(at(1.6, { ground_y: null }), corridor, COPTS).rejected).toBe("eye_height_unverified");
    expect(scoreMeasurement(at(1.6), corridor, COPTS).groundY).toBe(0);
  });

  it("an explicit eye_height is exact, and the guard applies to eye_level too", () => {
    const exact = generateCandidates({ shot: "corridor", corridor: axis, aspect: 16 / 9, eyeHeight: 1.6 })[0]!;
    expect(eyeProblem(at(1.6), exact)).toBeNull();
    expect(eyeProblem(at(1.75), exact)).toBe("above_eye_height");
    const spawn = { path: "Walker", origin: [0, 0, 0] as [number, number, number], forward: [0, 0, -1] as [number, number, number] };
    const eye = generateCandidates({ shot: "eye_level", spawn, aspect: 16 / 9 })[0]!;
    expect(eyeProblem({ ...at(4.25), adjustments: [{ kind: "raised", by: 2.65 }] }, eye)).toBe("raised_above_eye");
    // Ring shots have no eye spec: their height is free.
    expect(eyeProblem(measurement({ ground_y: 0 }), CAND)).toBeNull();
  });
});

describe("establishing: empty ground and the world edge are decisive (round 1: the winner showed the empty world)", () => {
  const featureless = (rows: (r: number) => boolean) => {
    let tex = "";
    let lum = "";
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      tex += rows(r) ? "0" : "5";
      lum += "5";
    }
    return { tex, lum };
  };

  it("counts featureless ground outside the subject's footprint as empty ground", () => {
    // Rows below the subject hit flat ground 60 m out: far outside the box.
    const m = measurement({ ...grid((r, c) => (r < 4 ? [".", -1] : r < 10 && c > 6 && c < 18 ? ["S", 30] : ["H", 60])), ...featureless((r) => r >= 10) });
    const s = scoreMeasurement(m, CAND, OPTS);
    expect(s.stats!.emptyGround!).toBeGreaterThan(EMPTY_LIMIT);
    expect(s.tier).toBe(1);
    // Textured ground there is not empty.
    const textured = scoreMeasurement(measurement({ ...grid((r, c) => (r < 4 ? [".", -1] : r < 10 && c > 6 && c < 18 ? ["S", 30] : ["H", 60])), ...featureless(() => false) }), CAND, OPTS);
    expect(textured.stats!.emptyGround).toBe(0);
    expect(textured.tier).toBe(0);
  });

  it("a pose over 15% empty ground or world edge loses to every pose under it, whatever the scores", () => {
    const ring = generateCandidates({ shot: "establishing", subject: BOX, aspect: 16 / 9 }).filter((c) => c.id.endsWith("_el12"));
    const clean = grid((r, c) => (r < 4 ? [".", -1] : r < 10 && c > 6 && c < 18 ? ["S", 30] : ["H", 20 + r]));
    // The bottom three rows miss everything: 21% world edge.
    const edged = grid((r, c) => (r < 4 || r >= ROWS - 3 ? [".", -1] : r < 10 && c > 6 && c < 18 ? ["S", 30] : ["H", 20 + r]));
    const scored = ring.map((c, i) => {
      const s = scoreMeasurement({ ...measurement(), ...(i < 3 ? edged : clean), i, position: c.position, look_at: c.look_at, fov: c.fov }, c, OPTS);
      // The edged poses get a far better weighted score than the clean ones.
      return { ...s, id: c.id, total: i < 3 ? 0.95 : 0.4 + i / 100 };
    });
    expect(scored.slice(0, 3).every((s) => s.tier === 1 && s.stats!.empty > EMPTY_LIMIT)).toBe(true);
    expect(scored.slice(3).every((s) => s.tier === 0)).toBe(true);
    const top = pickTop(scored, 3, 2, { around: aabbCenter(BOX), minYaw: 25, sides: true });
    expect(top).toHaveLength(3);
    expect(top.every((s) => s.tier === 0)).toBe(true);
    // Only when the clean poses run out does an empty one fill a slot, last.
    const few = pickTop([...scored.slice(0, 3), scored[5]!], 3, 2);
    expect(few[0]!.id).toBe(scored[5]!.id);
    expect(few.slice(1).every((s) => s.tier === 1)).toBe(true);
    expect([...scored].sort(rankOrder)[0]!.tier).toBe(0);
  });

  it("is an establishing rule only: other shots rank by score", () => {
    const edged = measurement(grid((r, c) => (r < 4 || r >= ROWS - 3 ? [".", -1] : r < 10 && c > 6 && c < 18 ? ["S", 30] : ["H", 20 + r])));
    const detail = generateCandidates({ shot: "detail", subject: BOX, aspect: 16 / 9 })[0]!;
    expect(scoreMeasurement(edged, detail, { ...OPTS, shot: "detail" }).tier).toBeUndefined();
  });
});
