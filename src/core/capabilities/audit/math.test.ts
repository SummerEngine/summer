import { describe, expect, it } from "vitest";
import {
  basisAngleDegrees,
  clusterSamples,
  directionAngleDegrees,
  expectedHostOrigin,
  fitCameraDistance,
  footprintExtent,
  isFrontBackSymmetric,
  lineAngleDegrees,
  matchInsertHost,
  mostCommon,
  mountGap,
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

  it("direction angle is signed: a mount side pointing away from the wall is 180", () => {
    expect(directionAngleDegrees([0, 0, -1], [0, 0, 1])).toBeCloseTo(180, 6);
    expect(directionAngleDegrees([0, 0, -1], [1, 0, 0])).toBeCloseTo(90, 6);
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

describe("insert host matching (a manifest's fits_into)", () => {
  // A door insert at its frame's own transform; the manifest fits it into
  // wall_door_b at local (0, 0, -0.1).
  const insertOrigin = [31.5, 0, -7.9] as const;
  const offset = [0, 0, -0.1] as const;

  it("the host sits at the insert transform minus the offset, in the host's frame", () => {
    const e = expectedHostOrigin(insertOrigin, YAW_180, offset);
    expect(e[0]).toBeCloseTo(31.5, 6);
    expect(e[2]).toBeCloseTo(-8.0, 6);
    const unrotated = expectedHostOrigin([1, 0, 0], IDENTITY, [0, 0.3, -0.045]);
    expect(unrotated).toEqual([1, -0.3, 0.045]);
  });

  it("ok within 2 cm and 1 deg", () => {
    const m = matchInsertHost(insertOrigin, YAW_180, offset, "wall_door_b", [
      { index: 4, piece: "wall_door_b", origin: [31.51, 0, -8.0], basis: YAW_180 },
    ]);
    expect(m.status).toBe("ok");
  });

  it("the named host 10 cm away is a wrong offset; 2 deg off is not ok either", () => {
    const off = matchInsertHost(insertOrigin, YAW_180, offset, "wall_door_b", [
      { index: 4, piece: "wall_door_b", origin: [31.5, 0, -7.9], basis: YAW_180 },
    ]);
    expect(off.status).toBe("wrong_offset");
    expect(off.named!.distance).toBeCloseTo(0.1, 6);
    const turned = matchInsertHost([0, 0, 0], IDENTITY, [0, 0, 0], "host", [{ index: 1, piece: "host", origin: [0, 0, 0], basis: yaw(2) }]);
    expect(turned.status).toBe("wrong_offset");
    expect(turned.named!.angle).toBeCloseTo(2, 4);
  });

  it("another piece at the expected pose is reported as the actual host", () => {
    const m = matchInsertHost([0, 0, 0], IDENTITY, [0, 0, -0.1], "wall_door_b", [
      { index: 9, piece: "facade_frame_a", origin: [0, 0, 0.1], basis: IDENTITY },
    ]);
    expect(m.status).toBe("wrong_piece");
    expect(m.other).toMatchObject({ index: 9, piece: "facade_frame_a" });
  });

  it("nothing there is missing", () => {
    expect(matchInsertHost([0, 0, 0], IDENTITY, [0, 0, 0], "host", []).status).toBe("missing");
  });

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

describe("mount gap samples and front-back symmetry", () => {
  it("the gap is the largest of the centre and the 4 side midpoints; corners only count for the closest contact", () => {
    // 0 centre, 1-4 corners, 5-8 sides.
    expect(mountGap([0.102, 0.152, 0.152, 0.152, 0.152, 0.102, 0.152, 0.152, 0.152])).toEqual({ min: 0.102, gap: 0.152, at: 6 });
    expect(mountGap([0.06, 0.01, 0.06, 0.06, 0.06, 0.06, 0.06, 0.06, 0.06])).toMatchObject({ min: 0.01, gap: 0.06 });
    // A side ray past the wall's edge (80 cm into a recess) and missing rays are ignored.
    expect(mountGap([0.0, 0, 0, 0, 0, 0, null, 0.8, 0])).toEqual({ min: 0, gap: 0, at: 0 });
    expect(mountGap([null, null])).toEqual({ min: null, gap: null, at: -1 });
    // Older rows with only the centre (or a corner) still give a gap.
    expect(mountGap([0.059, 0.06])).toMatchObject({ gap: 0.059, at: 0 });
    expect(mountGap([null, 0.04])).toMatchObject({ gap: 0.04, at: 1 });
  });

  it("symmetric: bounds centred on the origin, equal largest planes at mirrored positions", () => {
    // A duct run (front/back planes at +-0.3, equal area) and a strap brace (+-0.345).
    expect(isFrontBackSymmetric([0.3, 0.5, -0.3, 0.5, -0.3, 0.3])).toBe(true);
    expect(isFrontBackSymmetric([0.345, 0.0018, -0.345, 0.0017, -0.345, 0.345])).toBe(true);
    // A wall lantern: the back plate is three times the front plane.
    expect(isFrontBackSymmetric([0.15, 0.01, -0.2, 0.03, -0.2, 0.15])).toBe(false);
    // Equal planes, but the bounds sit behind the origin (origin on the back face).
    expect(isFrontBackSymmetric([0.6, 0.5, 0, 0.5, 0, 0.6])).toBe(false);
    // Planes not mirrored.
    expect(isFrontBackSymmetric([0.3, 0.5, -0.1, 0.5, -0.3, 0.3])).toBe(false);
    expect(isFrontBackSymmetric(null)).toBe(false);
    expect(isFrontBackSymmetric([0.3, 0, -0.3, 0.5, -0.3, 0.3])).toBe(false);
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
