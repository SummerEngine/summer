/**
 * Judgment for the gap detectors of summer_scene_audit. The kernel
 * measures; this file decides.
 *
 * - exposed_edge (A): open outline edges of walls and facade members (bands,
 *   piers, joints: the kernel's geometric roles) that nothing covers within
 *   4-7 mm, seen from walkable space, with a 2-60 cm reveal behind them or a
 *   coplanar continuation within 4 cm (seam) or 35 cm (bridged gap).
 * - open_fixture_end: open ends of run pieces (two or more open rims of one
 *   size) nothing joins within a sleeve tolerance, seen from the open side.
 * - depth_step (C): runs of recessed or proud depth along each facade row.
 *
 * Severity: exposed_edge warns on band pieces (and on walls when depth_step
 * agrees), else look; open_fixture_end warns; depth_step is look, and a
 * depth_step hole next to a through_hole confirms it (warn -> error). A
 * confirming flag is folded into the issue it confirms.
 */
import { add, distance, normalize, scale, sub, type Vec3 } from "../seeing/math.js";
import type { AuditCheck, Severity } from "./args.js";
import type { AuditIssue, FrameHint, InstRow, KernelResult } from "./judge.js";
import { boxCenter, boxDistance, boxIntersection, growBox, makeBox, type Box } from "./math.js";

export const CONFIRM_RADIUS = 0.6;
/** exposed_edge classes that count (sky, far and mixed are silhouettes, not gaps). */
export const EDGE_CLASSES = new Set(["gap", "seam", "bridge"]);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const r2 = (n: number) => Math.round(n * 100) / 100 || 0;
const r3 = (n: number) => Math.round(n * 1000) / 1000 || 0;
const v2 = (v: Vec3): Vec3 => [r2(v[0]), r2(v[1]), r2(v[2])];
const fmt = (v: Vec3) => `(${r2(v[0])},${r2(v[1])},${r2(v[2])})`;
const cm = (m: number) => `${Math.round(m * 1000) / 10} cm`;

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function vec(v: unknown): Vec3 {
  return Array.isArray(v) && v.length >= 3 ? [num(v[0]), num(v[1]), num(v[2])] : [0, 0, 0];
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export interface GkLine {
  b: number;
  ax: 0 | 2;
  c: number;
  lo: number;
  hi: number;
  y0: number;
  y1: number;
  tmin: number;
  tmax: number;
  sides: number[];
  pieces: number[];
}

export interface EdgeFlag {
  owner: number;
  cls: string;
  len: number;
  n: number;
  c: Vec3;
  box: Box;
  step: number;
  counts: { gap: number; seam: number; bridge: number; sky: number; far: number };
  eye: Vec3;
  hit: number;
}

export interface FixtureEnd {
  i: number;
  c: Vec3;
  out: Vec3;
  r: number;
  eye: Vec3;
}

export interface DepthFlag {
  kind: string;
  line: number;
  side: number;
  s0: number;
  s1: number;
  y0: number;
  y1: number;
  rows: number;
  depth: number;
  c: Vec3;
}

export function parseGkLines(raw: unknown): GkLine[] {
  return arr(obj(raw).lines).map((l) => {
    const r = obj(l);
    return {
      b: num(r.b, -1),
      ax: num(r.ax) === 2 ? 2 : 0,
      c: num(r.c),
      lo: num(r.lo),
      hi: num(r.hi),
      y0: num(r.y0),
      y1: num(r.y1),
      tmin: num(r.tmin),
      tmax: num(r.tmax),
      sides: arr(r.sides).map((s) => num(s)),
      pieces: arr(r.pieces).map((p) => num(p, -1)),
    } as GkLine;
  });
}

/** Door-like openings the kernel found (inserts reaching the floor, 1.8 m
 *  or taller): world boxes. */
export function parseDoors(raw: unknown): Box[] {
  return (arr(obj(raw).doors).filter(Array.isArray) as unknown[][]).map((d) => makeBox(vec(d[0]), vec(d[1])));
}

export function parseEdgeFlags(raw: unknown): EdgeFlag[] {
  return (arr(obj(raw).flags).filter(Array.isArray) as unknown[][]).map((f) => ({
    owner: num(f[0], -1),
    cls: String(f[1] ?? ""),
    len: num(f[2]),
    n: num(f[3]),
    c: vec(f[4]),
    box: makeBox(vec(f[5]), vec(f[6])),
    step: num(f[7]),
    counts: { gap: num(f[8]), seam: num(f[9]), bridge: num(f[10]), sky: num(f[11]), far: num(f[12]) },
    eye: vec(f[13]),
    hit: num(f[14], -1),
  }));
}

export function parseFixtureEnds(raw: unknown): FixtureEnd[] {
  return (arr(obj(raw).ends).filter(Array.isArray) as unknown[][]).map((e) => ({ i: num(e[0], -1), c: vec(e[1]), out: vec(e[2]), r: num(e[3]), eye: vec(e[4]) }));
}

export function parseDepthFlags(raw: unknown): DepthFlag[] {
  return (arr(obj(raw).flags).filter(Array.isArray) as unknown[][]).map((f) => ({
    kind: String(f[0] ?? ""),
    line: num(f[1], -1),
    side: num(f[2], 1),
    s0: num(f[3]),
    s1: num(f[4]),
    y0: num(f[5]),
    y1: num(f[6]),
    rows: num(f[7], 1),
    depth: num(f[8]),
    c: vec(f[9]),
  }));
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

export function instBox(r: InstRow): Box {
  return makeBox(sub(r.c, scale(r.e, 0.5)), add(r.c, scale(r.e, 0.5)));
}

/** The world box a depth_step run covers (its rows, 10 cm deep at the facade). */
export function depthBox(f: DepthFlag, lines: readonly GkLine[]): Box {
  const ln = lines[f.line];
  const ax = ln?.ax ?? 0;
  const th = 2 - ax;
  const lo: [number, number, number] = [f.c[0], f.y0 - 0.05, f.c[2]];
  const hi: [number, number, number] = [f.c[0], f.y1 + 0.05, f.c[2]];
  lo[ax] = f.s0;
  hi[ax] = f.s1;
  lo[th] = f.c[th]! - 0.05;
  hi[th] = f.c[th]! + 0.05;
  return { lo, hi };
}

// ---------------------------------------------------------------------------
// The combined judgment
// ---------------------------------------------------------------------------

export interface GapJudgement {
  issues: AuditIssue[];
  /** Checks that ran but could measure nothing (no walkable eye points). */
  unmeasured: AuditCheck[];
  notes: string[];
}

function lookDirs(dir: Vec3, clear: number): FrameHint["dirs"] {
  return [{ dir: normalize(add(normalize(dir), [0, 0.35, 0])), clear, pref: 1 }];
}

function nearestLinePiece(line: GkLine | undefined, p: Vec3, inst: readonly InstRow[]): InstRow | undefined {
  if (!line) return undefined;
  let best: InstRow | undefined;
  let bd = Infinity;
  for (const pi of line.pieces) {
    const r = inst[pi];
    if (!r) continue;
    const d = boxDistance(instBox(r), makeBox(p, p));
    if (d < bd) {
      bd = d;
      best = r;
    }
  }
  return best;
}

const C_WHY: Record<string, (f: DepthFlag) => string> = {
  seam: (f) => `a ${cm(f.s1 - f.s0)} recess runs up the facade over ${f.rows} row(s): a seam between modules`,
  hole: (f) => (f.depth >= 2 ? `a ${r2(f.s1 - f.s0)} m wide opening with nothing within 1.2 m behind it, over ${f.rows} rows, the facade on both sides or above it: a hole or a missing module` : `a ${r2(f.s1 - f.s0)} m wide recess ${r2(f.depth)} m deep over ${f.rows} rows: a hole or a missing module`),
  proud: (f) => `a ${r2(f.s1 - f.s0)} m run stands ${cm(-f.depth)} proud of the facade over ${f.rows} rows: a module out of line`,
  band_recess: (f) => `the band level recesses ${cm(f.depth)} over ${cm(f.s1 - f.s0)}, flush both sides: a gap in the band`,
  band_end_recess: (f) => `the band level recesses ${cm(f.depth)} over ${cm(f.s1 - f.s0)} at a band end`,
  band_missing_run: (f) => `the band level recesses ${cm(f.depth)} over ${r2(f.s1 - f.s0)} m: a missing band run`,
  band_through: (f) => `the band level opens ${r2(f.depth)} m deep over ${cm(f.s1 - f.s0)}: through the band`,
};

/**
 * exposed_edge, open_fixture_end and depth_step issues,
 * with confirmation folded in. `holes` (the through_hole issues) are
 * updated in place when a depth_step hole confirms one.
 */
export function judgeGaps(result: KernelResult, inst: readonly InstRow[], want: ReadonlySet<AuditCheck>, holes: AuditIssue[] = []): GapJudgement {
  const out: AuditIssue[] = [];
  const notes: string[] = [];
  const unmeasured: AuditCheck[] = [];
  const gk = obj(result.gk);
  const lines = parseGkLines(gk);
  const eyes = num(gk.eyes);
  const ran = (c: AuditCheck) => want.has(c) && result[c === "exposed_edge" ? "exposed" : c === "open_fixture_end" ? "fixture_ends" : "depth_steps"] !== undefined;
  if (eyes <= 0 && (ran("exposed_edge") || ran("open_fixture_end") || ran("depth_step"))) {
    notes.push("gap detectors: no walkable eye points (no open-sky floor), so nothing counts as seen; exposed_edge, open_fixture_end and depth_step measured nothing.");
    for (const c of ["exposed_edge", "open_fixture_end", "depth_step"] as const) if (ran(c)) unmeasured.push(c);
  }
  // Band pieces: the kernel's geometric bands (a run of thin pieces at one
  // height along a facade wall).
  const isBand = (r: InstRow | undefined) => r?.r === "struct" && r.w === "band";
  const edges = ran("exposed_edge") ? parseEdgeFlags(result.exposed).filter((f) => EDGE_CLASSES.has(f.cls) && inst[f.owner]) : [];
  const depth = ran("depth_step") ? parseDepthFlags(result.depth_steps).filter((f) => lines[f.line]) : [];
  const depthBoxes = depth.map((f) => depthBox(f, lines));
  const usedDepth = new Set<number>();

  if (ran("exposed_edge")) {
    edges.forEach((e) => {
      const r = inst[e.owner]!;
      const cK = depthBoxes.map((b, j) => (!usedDepth.has(j) && boxDistance(b, e.box) <= CONFIRM_RADIUS ? j : -1)).filter((j) => j >= 0);
      const band = isBand(r);
      cK.forEach((j) => usedDepth.add(j));
      const severity: Severity = band || cK.length ? "warn" : "look";
      const reveal = e.cls === "seam" ? "a coplanar sheet continues within 4 cm: a seam you can see into" : e.cls === "bridge" ? "the next coplanar sheet starts within 35 cm: a gap between sheets" : `the reveal behind it is ${cm(e.step)} deep`;
      const behind = inst[e.hit];
      out.push({
        check: "exposed_edge",
        severity,
        path: r.p,
        pos: v2(e.c),
        why: `open ${band ? "band" : "outline"} edge ${cm(e.len)} long that nothing covers within 7 mm, seen from walkable space; ${reveal}${cK.length ? "; depth_step confirms it" : ""}`,
        ev: { cls: e.cls, len_m: r2(e.len), samples: e.n, ...(e.cls === "gap" ? { reveal_m: r3(e.step) } : {}), piece: r.k, seen_from: v2(e.eye), ...(behind && behind !== r ? { behind: behind.p } : {}), ...(cK.length ? { confirmed_by: ["depth_step"] } : {}) },
        next: `summer_zoom at ${fmt(e.c)}; summer_measure ${r.p} against its neighbour, then move it flush, add the missing piece or cover the end`,
        score: e.len + (band ? 0.5 : 0),
        frame: { focus: e.c, size: Math.max(0.8, Math.min(4, e.len)), dirs: [{ dir: normalize(sub(e.eye, e.c)), clear: distance(e.eye, e.c), pref: 1 }] },
      });
    });
  }

  if (ran("open_fixture_end")) {
    for (const f of parseFixtureEnds(result.fixture_ends)) {
      const r = inst[f.i];
      if (!r) continue;
      out.push({
        check: "open_fixture_end",
        severity: "warn",
        path: r.p,
        pos: v2(f.c),
        why: `open end of ${r.k} (${cm(2 * f.r)} across) seen from walkable space: nothing joins it within 2.5 cm (a missing elbow, coupler, section or end piece)`,
        ev: { radius_m: r3(f.r), opens: v2(f.out), seen_from: v2(f.eye) },
        next: `summer_zoom at ${fmt(f.c)}; add the next piece (summer_connect_ports ${r.p} ...), or end the run in the wall or with an end piece`,
        score: f.r,
        frame: { focus: f.c, size: Math.max(0.6, 4 * f.r), dirs: [{ dir: normalize(sub(f.eye, f.c)), clear: distance(f.eye, f.c), pref: 1 }] },
      });
    }
  }

  // depth_step: holes confirm through_hole; the rest are look items. A run
  // that a door-like opening (an insert reaching the floor) covers over half
  // its length is the door's recess, not a band running through it.
  if (ran("depth_step")) {
    const doors = parseDoors(gk);
    depth.forEach((f, k) => {
      if (usedDepth.has(k)) return;
      const box = depthBoxes[k]!;
      const ax = lines[f.line]?.ax ?? 0;
      const run = growBox(box, 0.3);
      if (doors.some((d) => {
        const inter = boxIntersection(d, run);
        return !!inter && inter.hi[ax]! - inter.lo[ax]! >= 0.5 * (f.s1 - f.s0);
      })) return;
      if (f.kind === "hole") {
        const hole = holes.find((h) => h.check === "through_hole" && boxDistance(growBox(makeBox(h.pos, h.pos), Math.max(num(h.ev.w), num(h.ev.h), 0.3) / 2), box) <= 1.0);
        if (hole) {
          hole.ev.confirmed_by = ["depth_step"];
          if (hole.severity === "warn") hole.severity = "error";
          hole.why += `; depth_step confirms a ${r2(f.s1 - f.s0)} m recess`;
          return;
        }
      }
      const ln = lines[f.line];
      const r = nearestLinePiece(ln, boxCenter(box), inst);
      if (!r) return;
      const side: [number, number, number] = [0, 0, 0];
      side[2 - (ln?.ax ?? 0)] = f.side;
      out.push({
        check: "depth_step",
        severity: "look",
        path: r.p,
        pos: v2(boxCenter(box)),
        why: (C_WHY[f.kind] ?? ((x: DepthFlag) => `a depth step (${x.kind}) of ${cm(x.depth)}`))(f),
        ev: { kind: f.kind, w_m: r2(f.s1 - f.s0), ...(f.depth >= 2 ? { open: true } : { depth_m: r3(f.depth) }), rows: f.rows, y: [r2(f.y0), r2(f.y1)] },
        next: `summer_zoom at ${fmt(boxCenter(box))}`,
        score: (f.s1 - f.s0) * Math.abs(f.depth),
        frame: { focus: boxCenter(box), size: Math.max(1, f.s1 - f.s0), dirs: lookDirs(side, 3) },
      });
    });
  }
  return { issues: out, unmeasured, notes };
}
