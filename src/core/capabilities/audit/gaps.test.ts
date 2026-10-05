/**
 * The gap detectors' judgment, on fixtures shaped like the kernel's rows.
 * Each fixture reproduces one defect type the gap-detection experiment
 * injected into three_houses_v2 / v3 (a corner piece removed, a band shifted
 * 15 cm, a band end removed, a 2 cm seam, a module 3 cm proud, a duct elbow
 * removed) or one of its negative controls (doors, windows, alley passages,
 * inside corners), at the facade of one house:
 *
 *   front facade: wall modules x 0..9, z -0.1..0 (front +Z), 3 m tall
 *   right side:   wall modules z -6..0, x 8.9..9 (front +X)
 *   dado (base):  0.54 m tall, 10 cm proud of each face
 */
import { describe, expect, it } from "vitest";
import {
  bandFlags,
  cornerSquare,
  facadeExtent,
  insideCorner,
  judgeGaps,
  parseBands,
  parseGkLines,
  squareCover,
  type BandRow,
  type GkLine,
} from "./gaps.js";
import { AUDIT_CHECKS, type AuditCheck } from "./args.js";
import { makeBox, xzCover } from "./math.js";
import type { AuditIssue, InstRow, KernelResult } from "./judge.js";

const ID9 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
type V = [number, number, number];

function inst(p: string, lo: V, hi: V, over: Partial<InstRow> = {}): InstRow {
  const c: V = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const e: V = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  return { p, k: p.split("/").pop()!.toLowerCase(), s: "", r: "wall", in: true, o: lo, b: ID9, sc: [1, 1, 1], det: 1, c, e, le: e, lc: c, m: 1, f: [0, 0, 1], ...over };
}

const SIDE_FRONT = { f: [1, 0, 0] as V };

/** Instances: 0-2 front modules, 3-4 side modules, then the bands. */
function house() {
  const rows: InstRow[] = [
    inst("House/F0", [0, 0, -0.1], [3, 3, 0]),
    inst("House/F1", [3, 0, -0.1], [6, 3, 0]),
    inst("House/F2", [6, 0, -0.1], [9, 3, 0]),
    inst("House/R0", [8.9, 0, -3], [9, 3, 0], SIDE_FRONT),
    inst("House/R1", [8.9, 0, -6], [9, 3, -3], SIDE_FRONT),
  ];
  const lines: GkLine[] = [
    { b: 1, ax: 0, c: -0.05, lo: 0, hi: 9, y0: 0, y1: 3, tmin: -0.1, tmax: 0, sides: [1], pieces: [0, 1, 2] },
    { b: 1, ax: 2, c: 8.95, lo: -6, hi: 0, y0: 0, y1: 3, tmin: 8.9, tmax: 9, sides: [1], pieces: [3, 4] },
  ];
  return { rows, lines };
}

const seen = (lo: number, hi: number): Array<[number, number]> => [
  [lo - 0.3, 1],
  [lo + 0.1, 1],
  [hi - 0.1, 1],
  [hi + 0.3, 1],
];

function band(i: number, lo: V, hi: V, front: V, line: number, ax: 0 | 2, type = "base"): BandRow {
  return { i, type, box: makeBox(lo, hi), front, line, probes: seen(lo[ax], hi[ax]) };
}

/** Front dado pieces x 0..9 (indices 5-7) and side dado pieces z -6..0 (8-9). */
function dados(skip: number[] = [], shift: Record<number, number> = {}) {
  const { rows, lines } = house();
  const bands: BandRow[] = [];
  [0, 3, 6].forEach((x0, k) => {
    const i = rows.length;
    const dx = shift[k] ?? 0;
    rows.push(inst(`House/Dado${k}`, [x0 + dx, 0, 0], [x0 + 3 + dx, 0.54, 0.1], { r: "struct" }));
    if (!skip.includes(k)) bands.push(band(i, [x0 + dx, 0, 0], [x0 + 3 + dx, 0.54, 0.1], [0, 0, 1], 0, 0));
  });
  [-3, -6].forEach((z0, k) => {
    const i = rows.length;
    rows.push(inst(`House/SideDado${k}`, [9, 0, z0], [9.1, 0.54, z0 + 3], { r: "struct", ...SIDE_FRONT }));
    bands.push(band(i, [9, 0, z0], [9.1, 0.54, z0 + 3], [1, 0, 0], 1, 2));
  });
  return { rows, lines, bands };
}

describe("band_continuity: the experiment's injected defects", () => {
  it("corner removed: two bands that touch only at the corner's edge leave the corner square empty", () => {
    const { rows, lines, bands } = dados();
    const flags = bandFlags(lines, bands, [], rows, 10);
    const corner = flags.filter((f) => f.kind === "corner_open");
    // The front run's right end and the side run's front end both meet at x 9, z 0.
    expect(corner.length).toBeGreaterThanOrEqual(1);
    expect(corner[0]).toMatchObject({ type: "base", cover: 0, visible: true });
    // The square is the side band's depth (x 9..9.1) x the front band's depth (z 0..0.1).
    expect(corner[0]!.box.lo[0]).toBeCloseTo(9, 5);
    expect(corner[0]!.box.hi[0]).toBeCloseTo(9.1, 5);
    expect(corner[0]!.box.lo[2]).toBeCloseTo(0, 5);
    expect(corner[0]!.box.hi[2]).toBeCloseTo(0.1, 5);
  });

  it("the corner-square case where the two pieces touch at a point: zero coverage, though their bounds touch", () => {
    const front = band(0, [6, 0, 0], [9, 0.54, 0.1], [0, 0, 1], 0, 0);
    const side = band(1, [9, 0, -3], [9.1, 0.54, 0], [1, 0, 0], 1, 2);
    const sq = cornerSquare(0, [front], side, 0, 0.54);
    expect(xzCover(front.box, sq)).toBe(0);
    expect(xzCover(side.box, sq)).toBe(0);
    expect(squareCover(sq, [front, side], [])).toBe(0);
    // A corner piece wrapping the corner covers it, and so does one band run past the corner.
    expect(squareCover(sq, [front, side], [{ i: 2, box: makeBox([8.8, 0, -0.2], [9.2, 0.6, 0.2]), door: false }])).toBe(1);
    const wrapped = band(0, [6, 0, 0], [9.1, 0.54, 0.1], [0, 0, 1], 0, 0);
    expect(squareCover(sq, [wrapped, side], [])).toBe(1);
  });

  it("a corner piece at the band's end closes the corner", () => {
    const { rows, lines, bands } = dados();
    const piece = { i: 99, box: makeBox([8.85, 0, -0.15], [9.15, 0.6, 0.15]), door: false };
    expect(bandFlags(lines, bands, [piece], rows, 10).filter((f) => f.kind === "corner_open")).toEqual([]);
  });

  it("band shifted 15 cm: the vacated strip is a missing run between its neighbours", () => {
    const { rows, lines, bands } = dados([], { 1: 0.15 });
    const gap = bandFlags(lines, bands, [], rows, 10).filter((f) => f.kind === "gap");
    expect(gap).toHaveLength(1);
    expect(gap[0]!.size).toBeCloseTo(0.15, 5);
    expect(gap[0]!.pos[0]).toBeCloseTo(3.075, 3);
  });

  it("band end removed: the run stops 3 m short of the facade end", () => {
    const { rows, lines, bands } = dados([2]);
    const short = bandFlags(lines, bands, [], rows, 10).filter((f) => f.kind === "short_end");
    expect(short).toHaveLength(1);
    expect(short[0]).toMatchObject({ type: "base" });
    expect(short[0]!.size).toBeCloseTo(3, 5);
  });

  it("a band that covers less than half its facade has no short ends (a dado only under one bay)", () => {
    const { rows, lines, bands } = dados([1, 2]);
    expect(bandFlags(lines, bands, [], rows, 10).filter((f) => f.kind === "short_end")).toEqual([]);
  });
});

describe("band_continuity: negative controls", () => {
  it("doors: a door, gate or shutter covering 80% of a gap over half the band height closes it; a narrow one does not", () => {
    const { rows, lines, bands } = dados([1]);
    const door = { i: 50, box: makeBox([3.1, 0, -0.2], [5.9, 2.2, 0.05]), door: true };
    expect(bandFlags(lines, bands, [door], rows, 10).filter((f) => f.kind === "gap")).toEqual([]);
    const narrow = { i: 50, box: makeBox([4, 0, -0.2], [5, 2.2, 0.05]), door: true };
    expect(bandFlags(lines, bands, [narrow], rows, 10).filter((f) => f.kind === "gap")).toHaveLength(1);
    // Over the gap's length but only a fifth of the band's height: not a cover.
    const sill = { i: 51, box: makeBox([3, 0.4, -0.2], [6, 0.5, 0.05]), door: true };
    expect(bandFlags(lines, bands, [sill], rows, 10).filter((f) => f.kind === "gap")).toHaveLength(1);
  });

  it("alley passages: the bands of two houses on one street are two runs, never a missing run between them", () => {
    const left = [inst("H1/F0", [0, 0, -0.1], [9, 3, 0])];
    const right = [inst("H2/F0", [12, 0, -0.1], [21, 3, 0])];
    const rows = [...left, ...right, inst("H1/Dado", [0, 0, 0], [9, 0.54, 0.1], { r: "struct" }), inst("H2/Dado", [12, 0, 0], [21, 0.54, 0.1], { r: "struct" })];
    const lines: GkLine[] = [
      { b: 1, ax: 0, c: -0.05, lo: 0, hi: 9, y0: 0, y1: 3, tmin: -0.1, tmax: 0, sides: [1], pieces: [0] },
      { b: 2, ax: 0, c: -0.05, lo: 12, hi: 21, y0: 0, y1: 3, tmin: -0.1, tmax: 0, sides: [1], pieces: [1] },
    ];
    const bands = [band(2, [0, 0, 0], [9, 0.54, 0.1], [0, 0, 1], 0, 0), band(3, [12, 0, 0], [21, 0.54, 0.1], [0, 0, 1], 1, 0)];
    expect(bandFlags(lines, bands, [], rows, 10)).toEqual([]);
  });

  it("inside corners: a band that ends against a wall running on in front of it is not an open corner", () => {
    // A party wall (line along z, band facing -X at x 4) meeting a rear block (line along x at z -15).
    const rows = [inst("Party/W0", [4, 0, -15], [4.3, 3, -6], { f: [-1, 0, 0] }), inst("Rear/F0", [-10, 0, -15.3], [20, 9, -15])];
    const lines: GkLine[] = [
      { b: 1, ax: 2, c: 4.15, lo: -15, hi: -6, y0: 0, y1: 3, tmin: 4, tmax: 4.3, sides: [1, -1], pieces: [0] },
      { b: 1, ax: 0, c: -15.15, lo: -10, hi: 20, y0: 0, y1: 9, tmin: -15.3, tmax: -15, sides: [1], pieces: [1] },
    ];
    expect(insideCorner(lines[1]!, 3.9, -1)).toBe(true);
    const crown = { ...band(2, [3.87, 2.6, -15], [4, 2.92, -6], [-1, 0, 0], 0, 2, "crown"), probes: seen(-15, -6) };
    rows.push(inst("Party/W0_crown", [3.87, 2.6, -15], [4, 2.92, -6], { r: "struct", f: [-1, 0, 0] }));
    expect(bandFlags(lines, [crown], [], rows, 10).filter((f) => f.kind === "corner_open")).toEqual([]);
    // The same end at an OUTSIDE corner (the other facade runs only behind the band) is checked.
    expect(insideCorner({ ...lines[1]!, lo: 4.3, hi: 20 }, 3.9, -1)).toBe(false);
  });

  it("a lower neighbour's wall top at a storey cornice is not this facade; its crown covers the span", () => {
    // House 1 is 12 m tall (x 0..9), the West block 9 m (x -9..0), both facing +Z on one line.
    const rows: InstRow[] = [
      inst("H1/F2", [0, 6, -0.1], [9, 9, 0]),
      inst("H1/F3", [0, 9, -0.1], [9, 12, 0]),
      inst("West/F2", [-9, 6, -0.1], [0, 9, 0]),
    ];
    const ln: GkLine = { b: 1, ax: 0, c: -0.05, lo: -9, hi: 9, y0: 0, y1: 12, tmin: -0.1, tmax: 0, sides: [1], pieces: [0, 1, 2] };
    // A storey cornice straddling 9 m on House 1 only.
    expect(facadeExtent(ln, rows, 8.92, 9.08, 0, [0, 0, 1], [0, 9])).toEqual({ lo: 0, hi: 9 });
    // The West block's crown on top of its wall: the facade is the West block's.
    expect(facadeExtent(ln, rows, 9.0, 9.32, 0, [0, 0, 1], [-9, 0])).toEqual({ lo: -9, hi: 0 });
  });

  it("walls facing the other way on the same plane (two blocks back to back) are not the band's facade", () => {
    const rows: InstRow[] = [inst("A/F0", [0, 0, -0.1], [9, 3, 0]), inst("B/Back", [9, 0, -0.1], [18, 3, 0], { f: [0, 0, -1] })];
    const ln: GkLine = { b: 1, ax: 0, c: -0.05, lo: 0, hi: 18, y0: 0, y1: 3, tmin: -0.1, tmax: 0, sides: [1, -1], pieces: [0, 1] };
    expect(facadeExtent(ln, rows, 0, 0.54, 0, [0, 0, 1], [0, 9])).toEqual({ lo: 0, hi: 9 });
  });

  it("only spots walkable space sees: an unseen spot is dropped; without eye points visibility is unknown", () => {
    const { rows, lines, bands } = dados([], { 1: 0.15 });
    const blind = bands.map((b) => ({ ...b, probes: b.probes.map(([s]) => [s, 0] as [number, number]) }));
    expect(bandFlags(lines, blind, [], rows, 10).every((f) => f.visible === false)).toBe(true);
    expect(bandFlags(lines, blind, [], rows, 0).every((f) => f.visible === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The combined judgment: confirmation and severity
// ---------------------------------------------------------------------------

/** A kernel result for the house: by default a clean one (its outside
 *  corner closed by a corner piece); pass `b` for a defect. */
function kernel(over: Partial<Record<string, unknown>> = {}, b = dados()): { result: KernelResult; rows: InstRow[] } {
  const bandsRows = b.bands.map((x) => [x.i, x.type, [...x.box.lo], [...x.box.hi], [...x.front], x.line, x.probes]);
  const result: KernelResult = {
    instances: b.rows,
    gk: { eyes: 40, lines: b.lines },
    bands: { bands: bandsRows, coverers: [[90, [8.85, 0, -0.15], [9.15, 0.6, 0.15], false]] },
    exposed: { flags: [] },
    depth_steps: { flags: [] },
    fixture_ends: { ends: [] },
    ...over,
  };
  return { result, rows: b.rows };
}

const ALL = new Set<AuditCheck>(AUDIT_CHECKS);
/** An exposed_edge row: [owner, class, length, samples, centre, min, max, reveal, gap, seam, bridge, sky, far, eye, hit]. */
const edge = (owner: number, cls: string, c: V, len = 0.5, step = 0.1): unknown[] => [owner, cls, len, 4, c, [c[0] - 0.01, c[1] - 0.2, c[2] - 0.01], [c[0] + 0.01, c[1] + 0.2, c[2] + 0.01], step, cls === "gap" ? 4 : 0, cls === "seam" ? 4 : 0, cls === "bridge" ? 4 : 0, 0, 0, [c[0], 1.7, c[2] + 5], -1];
/** A depth_step row: [kind, line, side, s0, s1, y0, y1, rows, depth, centre]. */
const depth = (kind: string, s0: number, s1: number, y0: number, y1: number, d: number, c: V, rows = 2): unknown[] => [kind, 0, 1, s0, s1, y0, y1, rows, d, c];

describe("judgeGaps: confirmation and severity (the experiment's recommendation)", () => {
  const shifted = () => dados([], { 1: 0.15 });

  it("band_continuity is an error when exposed_edge confirms it, and the confirming edge is folded in", () => {
    const { result, rows } = kernel({ exposed: { flags: [edge(5, "gap", [3, 0.27, 0.05])] } }, shifted());
    const g = judgeGaps(result, rows, ALL);
    const b = g.issues.filter((i) => i.check === "band_continuity");
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ severity: "error", ev: { kind: "gap", confirmed_by: ["exposed_edge"] } });
    expect(b[0]!.why).toMatch(/missing base run 15 cm .* exposed_edge confirms it/);
    expect(g.issues.filter((i) => i.check === "exposed_edge")).toEqual([]);
  });

  it("depth_step confirms a band spot too; alone the band spot is a warning", () => {
    const withC = judgeGaps(kernel({ depth_steps: { flags: [depth("band_recess", 3, 3.15, 0.27, 0.27, 0.1, [3.07, 0.27, 0.1])] } }, shifted()).result, shifted().rows, ALL);
    expect(withC.issues.find((i) => i.check === "band_continuity")).toMatchObject({ severity: "error", ev: { confirmed_by: ["depth_step"] } });
    expect(withC.issues.filter((i) => i.check === "depth_step")).toEqual([]);
    const alone = judgeGaps(kernel({}, shifted()).result, shifted().rows, ALL);
    expect(alone.issues.find((i) => i.check === "band_continuity")).toMatchObject({ severity: "warn" });
  });

  it("without exposed_edge and depth_step nothing confirms a band spot, and the result says so", () => {
    const { result, rows } = kernel({ exposed: { flags: [edge(5, "gap", [3, 0.27, 0.05])] } }, shifted());
    const g = judgeGaps(result, rows, new Set<AuditCheck>(["band_continuity"]));
    expect(g.issues.map((i) => i.severity)).toEqual(["warn"]);
    expect(g.notes.join(" ")).toMatch(/nothing confirms a band spot/);
  });

  it("a band facing into the wall is reported only when exposed_edge confirms it", () => {
    const b = dados();
    const flippedBands = b.bands.map((x, k) => (k === 1 ? { ...x, front: [0, 0, -1] as V } : x));
    const base = { ...b, bands: flippedBands };
    const none = judgeGaps(kernel({}, base).result, base.rows, ALL);
    expect(none.issues.filter((i) => i.ev.kind === "flipped")).toEqual([]);
    const confirmed = judgeGaps(kernel({ exposed: { flags: [edge(6, "gap", [4.5, 0.27, 0.1])] } }, base).result, base.rows, ALL);
    expect(confirmed.issues.filter((i) => i.ev.kind === "flipped")).toMatchObject([{ severity: "error", path: "House/Dado1" }]);
  });

  it("2 cm seam between wall modules (exposed_edge on a wall): look alone, warn when depth_step agrees", () => {
    const seam = edge(1, "seam", [3, 1.5, 0], 3);
    const alone = judgeGaps(kernel({ exposed: { flags: [seam] } }).result, kernel().rows, ALL).issues.filter((i) => i.check === "exposed_edge");
    expect(alone).toMatchObject([{ severity: "look", ev: { cls: "seam" } }]);
    expect(alone[0]!.why).toMatch(/a seam you can see into/);
    const both = judgeGaps(kernel({ exposed: { flags: [seam] }, depth_steps: { flags: [depth("seam", 2.98, 3.02, 0.5, 2.5, 0.2, [3, 1.5, 0], 3)] } }).result, kernel().rows, ALL).issues;
    expect(both.filter((i) => i.check === "exposed_edge")).toMatchObject([{ severity: "warn", ev: { confirmed_by: ["depth_step"] } }]);
    expect(both.filter((i) => i.check === "depth_step")).toEqual([]);
  });

  it("module 3 cm proud: an exposed band edge warns; the proud run alone is a depth_step look item", () => {
    const g = judgeGaps(kernel({ exposed: { flags: [edge(7, "gap", [6.1, 0.27, 0.1], 0.5, 0.03)] }, depth_steps: { flags: [depth("proud", 3, 6, 1.5, 2.75, -0.03, [4.5, 2.1, 0])] } }).result, kernel().rows, ALL).issues;
    expect(g.find((i) => i.check === "exposed_edge")).toMatchObject({ severity: "warn", ev: { reveal_m: 0.03 } });
    const c = g.find((i) => i.check === "depth_step")!;
    expect(c).toMatchObject({ severity: "look", ev: { kind: "proud", rows: 2 } });
    expect(c.why).toMatch(/stands 3 cm proud/);
  });

  it("duct elbow removed: the open end of the run is a warning", () => {
    const rows = [...kernel().rows, inst("Alley2/Duct/Run_8", [25, 3.2, -8.8], [26.2, 3.9, -8.2], { r: "mount", k: "modular_airduct_rectangular_01_double_01" })];
    const { result } = kernel({ instances: rows, fixture_ends: { ends: [[rows.length - 1, [26.2, 3.59, -8.5], [1, 0, 0], 0.39, [30, 1.7, -10]]] } });
    const g = judgeGaps(result, rows, ALL).issues.filter((i) => i.check === "open_fixture_end");
    expect(g).toMatchObject([{ severity: "warn", path: "Alley2/Duct/Run_8", ev: { radius_m: 0.39 } }]);
    expect(g[0]!.why).toMatch(/78 cm across/);
  });

  it("a depth_step hole next to a through_hole confirms it (warn -> error) instead of a second issue", () => {
    const hole: AuditIssue = { check: "through_hole", severity: "warn", path: "House/F1", pos: [4.5, 1.5, 0], why: "see-through gap 0.3x0.3 m", ev: { w: 0.3, h: 0.3 }, next: "x", score: 1 };
    const g = judgeGaps(kernel({ depth_steps: { flags: [depth("hole", 3.2, 5.8, 1.0, 2.25, 0.6, [4.5, 1.6, 0])] } }).result, kernel().rows, ALL, [hole]);
    expect(hole).toMatchObject({ severity: "error", ev: { confirmed_by: ["depth_step"] } });
    expect(g.issues.filter((i) => i.check === "depth_step")).toEqual([]);
  });

  it("doors and windows: a depth run a door covers is the door's recess, not a defect", () => {
    const b = dados();
    const { result, rows } = kernel({ depth_steps: { flags: [depth("band_through", 3.5, 5.5, 0.27, 0.27, 0.41, [4.5, 0.27, 0])] } }, b);
    result.bands = { ...(result.bands as Record<string, unknown>), coverers: [[40, [3.4, 0, -0.3], [5.6, 2.2, 0.05], true]] };
    expect(judgeGaps(result, rows, ALL).issues.filter((i) => i.check === "depth_step")).toEqual([]);
    // Without the door it is a look item.
    expect(judgeGaps(kernel({ depth_steps: { flags: [depth("band_through", 3.5, 5.5, 0.27, 0.27, 0.41, [4.5, 0.27, 0])] } }, b).result, rows, ALL).issues.filter((i) => i.check === "depth_step")).toHaveLength(1);
  });

  it("sky, far and mixed edge clusters are silhouettes, never issues", () => {
    const flags = ["sky", "far", "mixed"].map((cls) => edge(1, cls, [1, 2, 0]));
    expect(judgeGaps(kernel({ exposed: { flags } }).result, kernel().rows, ALL).issues.filter((i) => i.check === "exposed_edge")).toEqual([]);
  });

  it("no walkable eye points: the edge checks measured nothing and are marked so", () => {
    const { result, rows } = kernel({ gk: { eyes: 0, lines: dados().lines } }, shifted());
    const g = judgeGaps(result, rows, ALL);
    expect(g.unmeasured.sort()).toEqual(["depth_step", "exposed_edge", "open_fixture_end"]);
    expect(g.notes[0]).toMatch(/no walkable eye points/);
    expect(g.issues.find((i) => i.check === "band_continuity")!.ev.seen).toBe("unknown");
  });

  it("parses the kernel's rows and tolerates missing sections", () => {
    expect(parseGkLines(undefined)).toEqual([]);
    expect(parseBands(undefined)).toEqual({ bands: [], coverers: [] });
    expect(judgeGaps({ instances: [] }, [], ALL).issues).toEqual([]);
  });
});
