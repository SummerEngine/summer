import { describe, expect, it } from "vitest";
import {
  EYE_BAND,
  LOW_ANGLE_CLEARANCE,
  SHOT_DEFAULTS,
  chooseCorridorAxis,
  exitDistance,
  generateCandidates,
  subjectSamples,
  type CorridorRun,
} from "./candidates.js";
import { aabbCenter, frameFill, type Aabb } from "./math.js";

const ROW: Aabb = { position: [-22, 0, -8], size: [44, 18, 9] };
const ASPECT = 16 / 9;

describe("candidate poses per shot type", () => {
  it("establishing: a 12 x 3 ring around the subject at the target fill", () => {
    const c = generateCandidates({ shot: "establishing", subject: ROW, aspect: ASPECT });
    expect(c).toHaveLength(36);
    for (const cand of c) {
      expect(cand.look_at).toEqual(aabbCenter(ROW));
      expect(frameFill(cand, ASPECT, ROW)).toBeCloseTo(SHOT_DEFAULTS.establishing.fill, 2);
      expect(cand.position[1]).toBeGreaterThan(aabbCenter(ROW)[1]);
      expect(cand.samples).toHaveLength(9);
    }
    expect(new Set(c.map((x) => x.id)).size).toBe(36);
  });

  it("low_angle: cameras sit at the ground clearance, closer and wider (the low-angle rule)", () => {
    const c = generateCandidates({ shot: "low_angle", subject: ROW, aspect: ASPECT });
    expect(c.length).toBeGreaterThan(0);
    for (const cand of c) {
      expect(cand.position[1]).toBeGreaterThanOrEqual(ROW.position[1] + LOW_ANGLE_CLEARANCE - 1e-6);
      expect(cand.position[1]).toBeLessThan(cand.look_at[1]);
      expect(cand.low_angle_rule).toBe(true);
    }
    expect(c.some((cand) => cand.fov > SHOT_DEFAULTS.low_angle.fov)).toBe(true);
    expect(c.some((cand) => cand.note?.includes("low-angle rule"))).toBe(true);
  });

  it("eye_level: the spawn's own camera is the eye; without a subject it looks around", () => {
    const spawn = { path: "Walker", origin: [-1, 0, 13] as const, forward: [0, 0, -1] as const, camera: { path: "Walker/Camera3D", position: [-1, 1.7, 13] as const, forward: [0, 0, -1] as const, fov: 75 } };
    const around = generateCandidates({ shot: "eye_level", spawn, aspect: ASPECT });
    expect(around).toHaveLength(17);
    expect(around[0]!.id).toBe("eye_spawn_forward");
    for (const cand of around) {
      expect(cand.position).toEqual([-1, 1.7, 13]);
      expect(cand.look_at[1]).toBeCloseTo(1.7, 6);
      expect(cand.samples).toEqual([]);
    }
    const atRow = generateCandidates({ shot: "eye_level", spawn, subject: ROW, aspect: ASPECT, eyeHeight: 1.6 });
    expect(atRow).toHaveLength(12);
    for (const cand of atRow) expect(cand.position).toEqual([-1, 1.6, 13]);
  });

  // Eye_level and corridor winners could come back "adjusted: raised" far
  // above eye height. Every eye pose now carries an eye spec: the kernel
  // stands it on the walkable surface below and never raises it.
  it("eye_level: every pose is in eye mode, a spawn camera keeps its height inside 1.5-1.8 m, eye_height is exact", () => {
    const spawn = { path: "Walker", origin: [-1, 0, 13] as const, forward: [0, 0, -1] as const, camera: { path: "Walker/Camera3D", position: [-1, 1.7, 13] as const, forward: [0, 0, -1] as const, fov: 75 } };
    for (const cand of generateCandidates({ shot: "eye_level", spawn, aspect: ASPECT })) {
      expect(cand.eye).toEqual({ min: EYE_BAND[0], max: EYE_BAND[1], stand: [-1, 0, 13] });
    }
    for (const cand of generateCandidates({ shot: "eye_level", spawn: { ...spawn, camera: undefined }, subject: ROW, aspect: ASPECT })) {
      expect(cand.eye).toEqual({ min: 1.5, max: 1.8, target: 1.6, stand: [-1, 0, 13] });
      expect(cand.position[1]).toBe(1.6);
    }
    for (const cand of generateCandidates({ shot: "eye_level", spawn, subject: ROW, aspect: ASPECT, eyeHeight: 1.75 })) {
      expect(cand.eye).toEqual({ min: 1.75, max: 1.75, target: 1.75, stand: [-1, 0, 13] });
    }
  });

  it("corridor: every camera stands at eye height on the corridor floor; alternatives are horizontal, never raised", () => {
    const axis = chooseCorridorAxis([{ seed: [0, 1.6, 0], dir: [0, 0, 1], fwd: 12, back: 10, left: 1.5, right: 1.5 }], { position: [-3, 0, -10], size: [6, 8, 22] })[0]!;
    // groundY is the subject's lowest point: a wall sunk 1.8 m into the ground
    // must not move the cameras (the floor is the scan seed's).
    const c = generateCandidates({ shot: "corridor", corridor: axis, aspect: ASPECT, groundY: -1.8 });
    expect(c).toHaveLength(24);
    expect(new Set(c.map((x) => x.position[1]))).toEqual(new Set([1.6]));
    expect(new Set(c.map((x) => x.look_at[1]))).toEqual(new Set([1.6]));
    for (const cand of c) {
      expect(cand.eye).toEqual({ min: 1.5, max: 1.8, target: 1.6, stand: [0, 1.6, 0] });
      expect(cand.samples).toHaveLength(6);
      expect(Math.abs(cand.look_at[2] - cand.position[2])).toBeGreaterThan(12);
    }
    // Two distances in from each end and three lateral offsets.
    expect(new Set(c.map((x) => Math.round(x.position[2] * 1000) / 1000))).toEqual(new Set([11.04, 9, -9.2, -7.5]));
    const tall = generateCandidates({ shot: "corridor", corridor: chooseCorridorAxis([{ seed: [0, 1.75, 0], dir: [0, 0, 1], fwd: 12, back: 10, left: 1.5, right: 1.5 }], { position: [-3, 0, -10], size: [6, 8, 22] })[0]!, aspect: ASPECT, eyeHeight: 1.75 });
    expect(new Set(tall.map((x) => x.position[1]))).toEqual(new Set([1.75]));
    expect(tall[0]!.eye).toMatchObject({ min: 1.75, max: 1.75, target: 1.75 });
  });

  it("subjectSamples keeps every point inside the box", () => {
    for (const p of subjectSamples(ROW)) {
      for (let k = 0; k < 3; k++) {
        expect(p[k]!).toBeGreaterThanOrEqual(ROW.position[k]!);
        expect(p[k]!).toBeLessThanOrEqual(ROW.position[k]! + ROW.size[k]!);
      }
    }
  });
});

describe("corridor axis choice", () => {
  const box: Aabb = { position: [-10, 0, -10], size: [20, 8, 20] };
  it("prefers a long narrow free line, clipped to the subject bounds + 2 m", () => {
    const runs: CorridorRun[] = [
      { seed: [0, 1.6, 0], dir: [1, 0, 0], fwd: 4, back: 4, left: 10, right: 10 }, // open square
      { seed: [0, 1.6, 0], dir: [0, 0, 1], fwd: 120, back: 9, left: 1.2, right: 1.4 }, // lane to the street
    ];
    const [best] = chooseCorridorAxis(runs, box);
    expect(best!.dir).toEqual([0, 0, 1]);
    expect(best!.usableFwd).toBeCloseTo(12, 6);
    expect(best!.usableBack).toBeCloseTo(9, 6);
    // The run leaves the bounds forward (the street) and stops inside behind (a dead end).
    expect([best!.openFwd, best!.openBack]).toEqual([true, false]);
    const shots = generateCandidates({ shot: "corridor", corridor: best!, aspect: 16 / 9, groundY: 0 });
    const inward = shots.filter((c) => c.into === 1);
    expect(inward.length).toBe(12);
    // Looking in = from the open (forward) end toward the dead end.
    for (const c of inward) expect(c.look_at[2]).toBeLessThan(c.position[2]);
    expect(shots.filter((c) => c.into === 0).every((c) => c.note === "looks out from the dead end")).toBe(true);
  });

  it("returns nothing when no run is long and walkable", () => {
    expect(chooseCorridorAxis([{ seed: [0, 1, 0], dir: [1, 0, 0], fwd: 1, back: 1, left: 0.2, right: 0.2 }], box)).toEqual([]);
  });

  it("exitDistance is the slab exit along a direction", () => {
    expect(exitDistance(box, [0, 1, 0], [1, 0, 0])).toBeCloseTo(10, 9);
    expect(exitDistance(box, [0, 1, 0], [0, 0, -1])).toBeCloseTo(10, 9);
  });
});
