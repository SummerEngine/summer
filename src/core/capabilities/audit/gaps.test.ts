/**
 * The gap detectors' judgment, on synthetic fixtures shaped like the
 * kernel's rows: one house with a band along its front, and one defect type
 * per case (a 2 cm seam, a module 3 cm proud, a removed duct elbow, a hole)
 * or a negative control (a door's recess, silhouettes):
 *
 *   front facade: wall modules x 0..9, z -0.1..0 (front +Z), 3 m tall
 *   right side:   wall modules z -6..0, x 8.9..9 (front +X)
 *   band:         0.54 m tall, 10 cm proud of each face (role struct, why
 *                 "band": what the kernel's geometry gives it)
 */
import { describe, expect, it } from "vitest";
import { judgeGaps, parseDoors, parseGkLines, type GkLine } from "./gaps.js";
import { AUDIT_CHECKS, type AuditCheck } from "./args.js";
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

/** Front band pieces x 0..9 (indices 5-7) and side band pieces z -6..0 (8-9). */
function dados() {
  const { rows, lines } = house();
  [0, 3, 6].forEach((x0, k) => rows.push(inst(`House/Band${k}`, [x0, 0, 0], [x0 + 3, 0.54, 0.1], { r: "struct", w: "band" })));
  [-3, -6].forEach((z0, k) => rows.push(inst(`House/SideBand${k}`, [9, 0, z0], [9.1, 0.54, z0 + 3], { r: "struct", w: "band", ...SIDE_FRONT })));
  return { rows, lines };
}

// ---------------------------------------------------------------------------
// The combined judgment: confirmation and severity
// ---------------------------------------------------------------------------

/** A kernel result for the house: by default a clean one. */
function kernel(over: Partial<Record<string, unknown>> = {}, b = dados()): { result: KernelResult; rows: InstRow[] } {
  const result: KernelResult = {
    instances: b.rows,
    gk: { eyes: 40, lines: b.lines, doors: [] },
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

describe("judgeGaps: confirmation and severity", () => {
  it("an open edge on a band piece (by geometry) warns; the band is never named from its node", () => {
    const { result, rows } = kernel({ exposed: { flags: [edge(5, "gap", [3, 0.27, 0.05])] } });
    const [e, ...rest] = judgeGaps(result, rows, ALL).issues;
    expect(rest).toEqual([]);
    expect(e).toMatchObject({ check: "exposed_edge", severity: "warn", path: "House/Band0" });
    expect(e!.why).toMatch(/^open band edge 50 cm long/);
    // The same edge on a piece the kernel did not find to be a band is an outline edge.
    const renamed = rows.map((r, k) => (k === 5 ? { ...r, w: "size" } : r));
    const [o] = judgeGaps({ ...result, instances: renamed }, renamed, ALL).issues;
    expect(o).toMatchObject({ check: "exposed_edge", severity: "look" });
    expect(o!.why).toMatch(/^open outline edge/);
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
    const rows = [...kernel().rows, inst("Lane2/Duct/Run_8", [25, 3.2, -8.8], [26.2, 3.9, -8.2], { r: "prop", k: "duct_double_a" })];
    const { result } = kernel({ instances: rows, fixture_ends: { ends: [[rows.length - 1, [26.2, 3.59, -8.5], [1, 0, 0], 0.39, [30, 1.7, -10]]] } });
    const g = judgeGaps(result, rows, ALL).issues.filter((i) => i.check === "open_fixture_end");
    expect(g).toMatchObject([{ severity: "warn", path: "Lane2/Duct/Run_8", ev: { radius_m: 0.39 } }]);
    expect(g[0]!.why).toMatch(/78 cm across/);
  });

  it("a depth_step hole next to a through_hole confirms it (warn -> error) instead of a second issue", () => {
    const hole: AuditIssue = { check: "through_hole", severity: "warn", path: "House/F1", pos: [4.5, 1.5, 0], why: "see-through gap 0.3x0.3 m", ev: { w: 0.3, h: 0.3 }, next: "x", score: 1 };
    const g = judgeGaps(kernel({ depth_steps: { flags: [depth("hole", 3.2, 5.8, 1.0, 2.25, 0.6, [4.5, 1.6, 0])] } }).result, kernel().rows, ALL, [hole]);
    expect(hole).toMatchObject({ severity: "error", ev: { confirmed_by: ["depth_step"] } });
    expect(g.issues.filter((i) => i.check === "depth_step")).toEqual([]);
  });

  it("doors: a depth run a door-like opening (an insert reaching the floor) covers is the door's recess, not a defect", () => {
    const b = dados();
    const { result, rows } = kernel({ depth_steps: { flags: [depth("band_through", 3.5, 5.5, 0.27, 0.27, 0.41, [4.5, 0.27, 0])] } }, b);
    result.gk = { ...(result.gk as Record<string, unknown>), doors: [[[3.4, 0, -0.3], [5.6, 2.2, 0.05]]] };
    expect(judgeGaps(result, rows, ALL).issues.filter((i) => i.check === "depth_step")).toEqual([]);
    // Without the door it is a look item.
    expect(judgeGaps(kernel({ depth_steps: { flags: [depth("band_through", 3.5, 5.5, 0.27, 0.27, 0.41, [4.5, 0.27, 0])] } }, b).result, rows, ALL).issues.filter((i) => i.check === "depth_step")).toHaveLength(1);
  });

  it("sky, far and mixed edge clusters are silhouettes, never issues", () => {
    const flags = ["sky", "far", "mixed"].map((cls) => edge(1, cls, [1, 2, 0]));
    expect(judgeGaps(kernel({ exposed: { flags } }).result, kernel().rows, ALL).issues.filter((i) => i.check === "exposed_edge")).toEqual([]);
  });

  it("no walkable eye points: the edge checks measured nothing and are marked so", () => {
    const { result, rows } = kernel({ gk: { eyes: 0, lines: dados().lines } });
    const g = judgeGaps(result, rows, ALL);
    expect(g.unmeasured.sort()).toEqual(["depth_step", "exposed_edge", "open_fixture_end"]);
    expect(g.notes[0]).toMatch(/no walkable eye points/);
  });

  it("parses the kernel's rows and tolerates missing sections", () => {
    expect(parseGkLines(undefined)).toEqual([]);
    expect(parseDoors(undefined)).toEqual([]);
    expect(parseDoors({ doors: [[[0, 0, 0], [1, 2, 0.2]]] })).toEqual([{ lo: [0, 0, 0], hi: [1, 2, 0.2] }]);
    expect(judgeGaps({ instances: [] }, [], ALL).issues).toEqual([]);
  });
});
