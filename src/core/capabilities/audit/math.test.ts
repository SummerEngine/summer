import { describe, expect, it } from "vitest";
import {
  basisAngleDegrees,
  clusterSamples,
  fitCameraDistance,
  footprintExtent,
  lineAngleDegrees,
  mostCommon,
  robustBounds,
  triangleArea,
  uvStretchRatio,
  wallDirection,
  depthResolution,
  zFightTolerance,
  type Basis9,
} from "./math.js";

const IDENTITY: Basis9 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
// 180 deg about +Y (a back-wall piece facing -Z), as the kernel writes it.
const YAW_180: Basis9 = [-1, 0, 8.742278e-8, 0, 1, 0, -8.742278e-8, 0, -1];
const yaw = (deg: number): Basis9 => {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), 0, -Math.sin(r), 0, 1, 0, Math.sin(r), 0, Math.cos(r)];
};

describe("clusterSamples", () => {
  it("joins grid neighbours (8-neighbourhood) and separates distant groups", () => {
    const s = 0.25;
    const left = [0, 1, 2, 3].map((j) => ({ u: 0, v: j * s }));
    const right = [0, 1].map((j) => ({ u: 2, v: j * s }));
    const diagonal = [{ u: 0.25, v: 1 }];
    const groups = clusterSamples([...left, ...right, ...diagonal], s * 1.5);
    expect(groups.map((g) => g.length)).toEqual([5, 2]);
    expect(groups[0]).toContain(6);
  });

  it("joins an off-grid seam sample within 1.5 cells and nothing farther", () => {
    const groups = clusterSamples([{ u: 0, v: 0 }, { u: 0.36, v: 0.05 }, { u: 0.9, v: 0 }], 0.375);
    expect(groups.map((g) => g.sort())).toEqual([[0, 1], [2]]);
  });

  it("handles nothing and one", () => {
    expect(clusterSamples([], 0.3)).toEqual([]);
    expect(clusterSamples([{ u: 5, v: 5 }], 0.3)).toEqual([[0]]);
  });

  it("is linear-ish: 20k samples in one strip cluster quickly", () => {
    const samples = Array.from({ length: 20000 }, (_, i) => ({ u: (i % 200) * 0.2, v: Math.floor(i / 200) * 0.2 }));
    const t0 = Date.now();
    const groups = clusterSamples(samples, 0.3);
    expect(groups).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("parallelism", () => {
  it("a bench long along X beside a wall whose normal is -X stands perpendicular (90 deg)", () => {
    const wall = wallDirection([-1, 0, 0]);
    expect(lineAngleDegrees([1, 0, 0], wall)).toBeCloseTo(90, 6);
    expect(lineAngleDegrees([-1, 0, 0], wall)).toBeCloseTo(90, 6);
  });

  it("parallel is 0 either way round; 10 deg off is 10", () => {
    const wall = wallDirection([0, 0, 1]);
    expect(lineAngleDegrees([1, 0, 0], wall)).toBeCloseTo(0, 6);
    expect(lineAngleDegrees([-1, 0, 0], wall)).toBeCloseTo(0, 6);
    const r = (10 * Math.PI) / 180;
    expect(lineAngleDegrees([Math.cos(r), 0, Math.sin(r)], wall)).toBeCloseTo(10, 6);
  });

  it("ignores the vertical component", () => {
    expect(lineAngleDegrees([1, 5, 0], wallDirection([0, 0, -1]))).toBeCloseTo(0, 6);
  });
});

describe("uvStretchRatio", () => {
  const p: [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]] = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ];

  it("square texels are 1", () => {
    expect(uvStretchRatio(p[0], p[1], p[2], [0, 0], [1, 0], [0, 1])).toBeCloseTo(1, 9);
    expect(uvStretchRatio(p[0], p[1], p[2], [0, 0], [0.5, 0], [0, 0.5])).toBeCloseTo(1, 9);
  });

  it("an 8:1 squeeze of one UV axis is 8", () => {
    expect(uvStretchRatio(p[0], p[1], p[2], [0, 0], [1 / 8, 0], [0, 1])).toBeCloseTo(8, 9);
  });

  it("is independent of rotation in UV and in world", () => {
    const a = (30 * Math.PI) / 180;
    const rot = (u: number, v: number): [number, number] => [u * Math.cos(a) - v * Math.sin(a), u * Math.sin(a) + v * Math.cos(a)];
    const r = uvStretchRatio([0, 0, 0], [0, 0, 1], [0, 1, 0], rot(0, 0), rot(0.25, 0), rot(0, 1));
    expect(r).toBeCloseTo(4, 6);
  });

  it("UVs collapsed to a line (a reveal mapped onto one texel column) are infinite", () => {
    expect(uvStretchRatio([0, 0, 0], [0.2, 0, 0], [0, 3, 0], [0.5, 0], [0.5, 0], [0.5, 1])).toBe(Number.POSITIVE_INFINITY);
  });

  it("triangleArea", () => {
    expect(triangleArea(p[0], p[1], p[2])).toBeCloseTo(0.5, 9);
  });
});

describe("basis angle", () => {
  it("basis angle", () => {
    expect(basisAngleDegrees(IDENTITY, yaw(90))).toBeCloseTo(90, 6);
    expect(basisAngleDegrees(IDENTITY, YAW_180)).toBeCloseTo(180, 4);
    expect(basisAngleDegrees(yaw(30), yaw(30))).toBeCloseTo(0, 4);
  });
});

describe("floor gap footprints", () => {
  it("area is the sum of the samples' own footprints, bounded by their box; sides long first", () => {
    const seam = Array.from({ length: 84 }, (_, k) => ({ x: 16.85 + k * 0.1, z: -7.558, sx: 0.1, sz: 0.04, area: 0.004 }));
    const e = footprintExtent(seam);
    expect(e.area).toBeCloseTo(0.336, 6);
    expect(e.long).toBeCloseTo(8.4, 6);
    expect(e.short).toBeCloseTo(0.04, 6);
    // Overlapping samples never count more than the ground they cover.
    const twice = footprintExtent([{ x: 0, z: 0, sx: 0.3, sz: 0.3, area: 0.09 }, { x: 0, z: 0, sx: 0.3, sz: 0.3, area: 0.09 }]);
    expect(twice.area).toBeCloseTo(0.09, 9);
    expect(footprintExtent([])).toMatchObject({ area: 0, long: 0 });
  });

  it("mostCommon picks the majority, the first seen on a tie, and a fallback when empty", () => {
    expect(mostCommon([4, 2, 4, 2, 4])).toBe(4);
    expect(mostCommon([7, 3])).toBe(7);
    expect(mostCommon([])).toBe(-1);
  });
});

describe("z_fight tolerance from depth precision", () => {
  it("one 24-bit depth step is about 1 mm at 30 m with Godot's default near 0.05 m, and grows with the square of the distance", () => {
    expect(depthResolution(30)).toBeCloseTo(0.00107, 5);
    expect(depthResolution(60) / depthResolution(30)).toBeCloseTo(4, 6);
    // A smaller near plane is coarser everywhere.
    expect(depthResolution(30, 0.01)).toBeCloseTo(5 * depthResolution(30, 0.05), 6);
  });

  it("the tolerance is twice the step, never under 0.1 mm", () => {
    expect(zFightTolerance(40, 0.01, 4000)).toBeCloseTo(0.0191, 4);
    expect(zFightTolerance(2, 0.01, 4000)).toBe(0.0001);
    expect(zFightTolerance(30)).toBeCloseTo(0.00215, 5);
  });
});

describe("robust bounds and framing distance", () => {
  it("one piece 2 km away is beyond the limit; the rest are inside", () => {
    const pts = Array.from({ length: 40 }, (_, i) => [i % 10, 0, Math.floor(i / 10)] as const);
    const b = robustBounds([...pts, [2000, 0, 0]]);
    expect(b.limit).toBeLessThan(200);
    expect(Math.hypot(2000 - b.center[0], 0, -b.center[2])).toBeGreaterThan(b.limit);
  });

  it("a 1 m subject at fov 50 is framed from about 2 m", () => {
    expect(fitCameraDistance(1, 50)).toBeGreaterThan(1.5);
    expect(fitCameraDistance(1, 50)).toBeLessThan(2.5);
  });
});
