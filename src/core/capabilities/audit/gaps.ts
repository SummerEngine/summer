/**
 * Judgment for the gap detectors of summer_scene_audit, ported from the
 * gap-detection experiment (2026-10-04: three town scenes, 45 injected
 * defects, negative controls). The kernel measures; this file decides.
 *
 * - band_continuity (B): band pieces (base / dado / plinth, cornice, crown,
 *   trim, band, sill by pieces.json category or name) grouped into runs per
 *   facade line, type and height. Flags a missing run over 5 cm (unless a
 *   door, gate or shutter, or a corner, end or pier piece, covers 80% of its
 *   length over half the band height), a short end over 5 cm (only when the
 *   band covers half the facade), an outside corner whose square (this
 *   band's depth x the return band's depth) is under 70% covered, and a band
 *   facing into the wall (only when exposed_edge confirms it). Only spots
 *   walkable space sees.
 * - exposed_edge (A): open outline edges of wall-, band- and pier-shaped
 *   pieces that nothing covers within 4-7 mm, seen from walkable space, with
 *   a 2-60 cm reveal behind them or a coplanar continuation within 4 cm
 *   (seam) or 35 cm (bridged gap).
 * - open_fixture_end: open ends of pipe, duct and gutter pieces nothing joins
 *   within a sleeve tolerance, seen from the open side.
 * - depth_step (C): runs of recessed or proud depth along each facade row.
 *
 * Severity (the experiment's recommendation): band_continuity is an error
 * when exposed_edge or depth_step confirms it within 0.6 m, else a warning;
 * exposed_edge warns on band pieces (and on walls when depth_step agrees),
 * else look; depth_step is look, and a depth_step hole next to a
 * through_hole confirms it (warn -> error). A confirming flag is folded into
 * the issue it confirms.
 */
import { add, distance, length, normalize, scale, sub, type Vec3 } from "../seeing/math.js";
import type { AuditCheck, Severity } from "./args.js";
import type { AuditIssue, FrameHint, InstRow, KernelResult } from "./judge.js";
import { bandSpanBox, basisMulVec, boxCenter, boxDistance, boxIntersection, growBox, makeBox, mergeRuns, xzCover, type Box } from "./math.js";

export const BAND_GAP_MIN = 0.05;
export const BAND_END_MIN = 0.05;
export const BAND_FACADE_SHARE = 0.5;
export const CORNER_COVER_MIN = 0.7;
export const COVER_LENGTH_SHARE = 0.8;
export const COVER_HEIGHT_SHARE = 0.5;
export const CONFIRM_RADIUS = 0.6;
/** A band spot counts as seen when a visibility probe within this distance
 *  of it along the band saw it (probes sit 0.3 m past each band end and
 *  every metre along it). */
export const PROBE_REACH = 0.35;
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

export interface BandRow {
  i: number;
  type: string;
  box: Box;
  front: Vec3;
  line: number;
  /** [position along the band axis, seen 1/0]. */
  probes: Array<[number, number]>;
}

export interface CovererRow {
  i: number;
  box: Box;
  door: boolean;
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

export function parseBands(raw: unknown): { bands: BandRow[]; coverers: CovererRow[] } {
  const r = obj(raw);
  const bands = (arr(r.bands).filter(Array.isArray) as unknown[][]).map((b) => ({
    i: num(b[0], -1),
    type: String(b[1] ?? ""),
    box: makeBox(vec(b[2]), vec(b[3])),
    front: vec(b[4]),
    line: num(b[5], -1),
    probes: (arr(b[6]).filter(Array.isArray) as unknown[][]).map((p) => [num(p[0]), num(p[1])] as [number, number]),
  }));
  const coverers = (arr(r.coverers).filter(Array.isArray) as unknown[][]).map((c) => ({ i: num(c[0], -1), box: makeBox(vec(c[1]), vec(c[2])), door: c[3] === true }));
  return { bands, coverers };
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

/** A piece's outward front in world space: its measured local front, else local +Z. */
export function worldFront(r: InstRow): Vec3 {
  const f: Vec3 = length(r.f) > 0.5 ? r.f : [0, 0, 1];
  return normalize(basisMulVec(r.b, f));
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

/**
 * Coverers (door / gate / shutter, corner / end / pier piece, short band)
 * over a band span: each overlaps the span (2 cm slack) over at least half
 * the band height and, when `full`, together they cover 80% of the span's
 * length along the band. Returns the first one, or null.
 */
export function coveredBy(coverers: readonly CovererRow[], span: Box, ax: 0 | 2, full: boolean, y0: number, y1: number): CovererRow | null {
  const along: Array<[number, number]> = [];
  let first: CovererRow | null = null;
  for (const cv of coverers) {
    const g = growBox(cv.box, 0.02);
    const inter = boxIntersection(g, span);
    if (!inter) continue;
    const oy = Math.min(cv.box.hi[1], y1) - Math.max(cv.box.lo[1], y0);
    if (oy < COVER_HEIGHT_SHARE * (y1 - y0) - 0.005) continue;
    if (!full) return cv;
    first ??= cv;
    along.push([inter.lo[ax]!, inter.hi[ax]!]);
  }
  if (!first) return null;
  // Several pieces together (a run of the neighbour's crown modules).
  const covered = mergeRuns(along, 0.02).reduce((sum, r) => sum + (r[1] - r[0]), 0);
  return covered >= COVER_LENGTH_SHARE * (span.hi[ax]! - span.lo[ax]!) ? first : null;
}

/**
 * The facade's extent along its axis at a band's height, grown from the
 * band's own run: the line's pieces (facing the band's way) behind the run
 * that overlap at least half the band's height, then their neighbours along
 * the line (within 10 cm) that do the same. A wall column that ENDS inside
 * the band's height belongs to a block capped there (a lower neighbour whose
 * crown meets this storey cornice) and stops the extent. A band that sits on
 * top of its wall (a crown) uses the columns it caps instead.
 */
export function facadeExtent(ln: GkLine, inst: readonly InstRow[], y0: number, y1: number, ax: 0 | 2, front?: Vec3, run?: readonly [number, number]): { lo: number; hi: number } {
  const h = Math.max(y1 - y0, 0.01);
  // Only the wall pieces that face the band's way: two blocks back to back
  // share a plane (a party wall's far face is not this facade).
  const th = 2 - ax;
  const same = (r: InstRow) => !front || Math.abs(front[th]!) < 0.5 || length(r.f) < 0.5 || worldFront(r)[th]! * front[th]! > 0;
  const boxes = ln.pieces.map((pi) => inst[pi]).filter((r): r is InstRow => !!r && same(r)).map(instBox);
  const width = (b: Box) => Math.max(b.hi[ax]! - b.lo[ax]!, 1e-6);
  const overlapAx = (a: Box, b: Box) => Math.min(a.hi[ax]!, b.hi[ax]!) - Math.max(a.lo[ax]!, b.lo[ax]!);
  const topOfColumn = (b: Box) => !boxes.some((c) => c !== b && overlapAx(c, b) >= 0.5 * Math.min(width(b), width(c)) && Math.abs(c.lo[1] - b.hi[1]) <= 0.1);
  const behind = (b: Box) => Math.min(b.hi[1], y1) - Math.max(b.lo[1], y0) >= 0.5 * h - 0.005 && !(topOfColumn(b) && b.hi[1] >= y0 - 0.02 && b.hi[1] <= y1 + 0.02);
  const capped = (b: Box) => topOfColumn(b) && Math.abs(b.hi[1] - y0) <= 0.1;
  const [rlo, rhi] = run ?? [-Infinity, Infinity];
  // Behind the run: overlapping it along the line by 10 cm or more.
  const near = (b: Box) => Math.min(b.hi[ax]!, rhi) - Math.max(b.lo[ax]!, rlo) >= Math.min(0.1, 0.5 * (rhi - rlo));
  let rule = behind;
  if (!boxes.some((b) => behind(b) && near(b))) rule = capped;
  const pick = boxes.filter(rule);
  let set = pick.filter(near);
  if (!set.length) return { lo: Infinity, hi: -Infinity };
  let lo = Math.min(...set.map((b) => b.lo[ax]!));
  let hi = Math.max(...set.map((b) => b.hi[ax]!));
  for (let grew = true; grew; ) {
    grew = false;
    for (const b of pick) {
      if (set.includes(b) || b.hi[ax]! < lo - 0.1 || b.lo[ax]! > hi + 0.1) continue;
      set = [...set, b];
      lo = Math.min(lo, b.lo[ax]!);
      hi = Math.max(hi, b.hi[ax]!);
      grew = true;
    }
  }
  return { lo, hi };
}

/**
 * The other facade at a band's end runs on in FRONT of the band (more than
 * 0.3 m past the band's plane on its front side): an inside corner or a
 * T-junction, where the band's end butts into that wall.
 */
export function insideCorner(other: GkLine, bandPlane: number, frontSign: number): boolean {
  if (Math.abs(frontSign) < 0.5) return false;
  return frontSign > 0 ? other.hi > bandPlane + 0.3 : other.lo < bandPlane - 0.3;
}

/** The perpendicular facade line of the same building that meets `ln` at its end `facEnd`. */
export function cornerLine(lines: readonly GkLine[], ln: GkLine, facEnd: number, y0: number, y1: number): number {
  const oth = 2 - ln.ax;
  for (let li = 0; li < lines.length; li++) {
    const o = lines[li]!;
    if (o.ax !== oth || o.b !== ln.b) continue;
    if (facEnd < o.tmin - 0.4 || facEnd > o.tmax + 0.4) continue;
    if (ln.c < o.lo - 0.4 || ln.c > o.hi + 0.4) continue;
    if (y1 < o.y0 || y0 > o.y1) continue;
    return li;
  }
  return -1;
}

/**
 * The outside-corner square: this band run's depth range (across its own
 * axis) x the return band's depth range (along this band's axis), over the
 * middle half of the band height. Bands that end at their wall planes leave
 * it empty, even when their bounds touch at the corner's edge.
 */
export function cornerSquare(ax: 0 | 2, items: readonly BandRow[], ret: BandRow, y0: number, y1: number): Box {
  const th = 2 - ax;
  const lo: [number, number, number] = [0, y0 + (y1 - y0) * 0.25, 0];
  const hi: [number, number, number] = [0, y0 + (y1 - y0) * 0.75, 0];
  lo[ax] = ret.box.lo[ax]!;
  hi[ax] = Math.max(ret.box.hi[ax]!, lo[ax] + 0.01);
  lo[th] = Math.min(...items.map((i) => i.box.lo[th]!));
  hi[th] = Math.max(Math.max(...items.map((i) => i.box.hi[th]!)), lo[th] + 0.01);
  return { lo, hi };
}

/** The largest share of the square any single band or coverer covers. */
export function squareCover(square: Box, bands: readonly BandRow[], coverers: readonly CovererRow[]): number {
  let cov = 0;
  for (const b of bands) cov = Math.max(cov, xzCover(b.box, square));
  for (const c of coverers) cov = Math.max(cov, xzCover(c.box, square));
  return cov;
}

// ---------------------------------------------------------------------------
// band_continuity: runs, gaps, ends, corners, facing
// ---------------------------------------------------------------------------

export type BandKind = "gap" | "short_end" | "corner_open" | "flipped";

export interface BandFlag {
  kind: BandKind;
  type: string;
  line: number;
  ax: 0 | 2;
  box: Box;
  pos: Vec3;
  size: number;
  /** The band piece the spot belongs to (instance index). */
  item: number;
  /** The other band piece across a gap, or the return band at a corner. */
  other?: number;
  cover?: number;
  noReturn?: boolean;
  front: Vec3;
  /** null when visibility could not be measured (no walkable eye points or no probes). */
  visible: boolean | null;
}

export interface BandGroup {
  line: number;
  type: string;
  ax: 0 | 2;
  c: number;
  y0: number;
  y1: number;
  items: BandRow[];
}

/** Bands per facade line, type, height (base within 15 cm) and facing (the
 *  two faces of a party wall are two runs). */
export function groupBands(bands: readonly BandRow[], lines: readonly GkLine[]): BandGroup[] {
  const sorted = bands.filter((b) => b.line >= 0 && b.line < lines.length).sort((a, b) => a.line - b.line || a.type.localeCompare(b.type) || a.box.lo[1] - b.box.lo[1] || a.box.lo[0] - b.box.lo[0] || a.box.lo[2] - b.box.lo[2]);
  const groups: BandGroup[] = [];
  const facing = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] > 0.5;
  for (const b of sorted) {
    const g = groups.find((x) => x.line === b.line && x.type === b.type && Math.abs(x.y0 - b.box.lo[1]) <= 0.15 && facing(x.items[0]!.front, b.front));
    if (g) g.items.push(b);
    else groups.push({ line: b.line, type: b.type, ax: lines[b.line]!.ax, c: 0, y0: b.box.lo[1], y1: b.box.hi[1], items: [b] });
  }
  for (const g of groups) {
    const th = 2 - g.ax;
    g.items.sort((a, b) => a.box.lo[g.ax]! - b.box.lo[g.ax]!);
    g.y0 = Math.min(...g.items.map((i) => i.box.lo[1]));
    g.y1 = Math.max(...g.items.map((i) => i.box.hi[1]));
    g.c = g.items.reduce((s, i) => s + (i.box.lo[th]! + i.box.hi[th]!) / 2, 0) / g.items.length;
  }
  return groups;
}

/** Seen when a visibility probe of these band pieces within `reach` of the
 *  span [s0, s1] (along the band) saw it; null when they have no probes. */
function seenNear(items: readonly BandRow[], s0: number, s1: number, reach = PROBE_REACH): boolean | null {
  let any = false;
  for (const it of items) {
    for (const [s, seen] of it.probes) {
      any = true;
      if (seen && s >= s0 - reach && s <= s1 + reach) return true;
    }
  }
  return any ? false : null;
}

function spotPos(ax: 0 | 2, s: number, c: number, y: number): Vec3 {
  const p: [number, number, number] = [0, y, 0];
  p[ax] = s;
  p[2 - ax] = c;
  return p;
}

function meanFront(items: readonly BandRow[]): Vec3 {
  const sum = items.reduce<Vec3>((s, i) => add(s, i.front), [0, 0, 0]);
  return length(sum) > 1e-6 ? normalize(sum) : [0, 0, 1];
}

/**
 * Every band flag the geometry supports, before visibility and confirmation:
 * gaps between runs, short ends, open outside corners, flipped pieces.
 * `eyes` = 0 marks every flag's visibility unknown (null).
 */
export function bandFlags(lines: readonly GkLine[], bands: readonly BandRow[], coverers: readonly CovererRow[], inst: readonly InstRow[], eyes: number): BandFlag[] {
  const flags: BandFlag[] = [];
  const vis = (items: readonly BandRow[], s0: number, s1: number, reach = PROBE_REACH) => (eyes > 0 ? seenNear(items, s0, s1, reach) : null);
  for (const g of groupBands(bands, lines)) {
    const ln = lines[g.line]!;
    const ax = g.ax;
    const th = 2 - ax;
    const { y0, y1, items } = g;
    const ymid = (y0 + y1) / 2;
    const front = meanFront(items);
    const runRange: [number, number] = [Math.min(...items.map((i) => i.box.lo[ax]!)), Math.max(...items.map((i) => i.box.hi[ax]!))];
    const { lo: extLo, hi: extHi } = facadeExtent(ln, inst, y0, y1, ax, front, runRange);
    // What can close a span of this run: coverers, and any other band piece
    // at its height (a lower block's crown under a storey cornice).
    const spanCover: CovererRow[] = [...coverers, ...bands.filter((b) => !items.includes(b)).map((b) => ({ i: b.i, box: b.box, door: false }))];
    // Facing: against the wall pieces directly behind the band (the wall
    // continues behind it over half its height). A band capping the top of a
    // wall (a crown on a separator seen from both sides) has no "into".
    for (const it of items) {
      let out: Vec3 = [0, 0, 0];
      const bh = Math.max(it.box.hi[1] - it.box.lo[1], 0.01);
      for (const pi of ln.pieces) {
        const r = inst[pi];
        if (!r) continue;
        const pb = instBox(r);
        if (pb.hi[ax]! <= it.box.lo[ax]! + 0.05 || pb.lo[ax]! >= it.box.hi[ax]! - 0.05) continue;
        if (Math.min(pb.hi[1], it.box.hi[1]) - Math.max(pb.lo[1], it.box.lo[1]) < 0.5 * bh) continue;
        out = add(out, worldFront(r));
      }
      if (length(out) <= 0.5) continue;
      const o = normalize(out);
      if (it.front[0] * o[0] + it.front[1] * o[1] + it.front[2] * o[2] < -0.5) {
        flags.push({ kind: "flipped", type: g.type, line: g.line, ax, box: it.box, pos: boxCenter(it.box), size: it.box.hi[ax]! - it.box.lo[ax]!, item: it.i, front: o, visible: vis([it], it.box.lo[ax]!, it.box.hi[ax]!) });
      }
    }
    const runs = mergeRuns(items.map((i) => [i.box.lo[ax]!, i.box.hi[ax]!] as const));
    const endItem = (s: number) => items.reduce((best, i) => (Math.min(Math.abs(i.box.lo[ax]! - s), Math.abs(i.box.hi[ax]! - s)) < Math.min(Math.abs(best.box.lo[ax]! - s), Math.abs(best.box.hi[ax]! - s)) ? i : best), items[0]!);
    for (let k = 0; k + 1 < runs.length; k++) {
      const a = runs[k]![1];
      const b = runs[k + 1]![0];
      if (b - a <= BAND_GAP_MIN) continue;
      const span = bandSpanBox(ax, a, b, g.c, y0, y1);
      if (coveredBy(spanCover, span, ax, true, y0, y1)) continue;
      const left = endItem(a);
      const right = endItem(b);
      flags.push({ kind: "gap", type: g.type, line: g.line, ax, box: span, pos: spotPos(ax, (a + b) / 2, g.c, ymid), size: b - a, item: left.i, other: right.i, front, visible: vis(items, a, b) });
    }
    if (extLo === Infinity) continue;
    const coveredLen = runs.reduce((s, r) => s + (r[1] - r[0]), 0);
    const checkEnds = coveredLen >= BAND_FACADE_SHARE * (extHi - extLo);
    for (const endI of [0, 1] as const) {
      if (!checkEnds) break;
      const bandEnd = endI === 0 ? runs[0]![0] : runs[runs.length - 1]![1];
      const facEnd = endI === 0 ? extLo : extHi;
      const short = endI === 0 ? bandEnd - facEnd : facEnd - bandEnd;
      const it = endItem(bandEnd);
      if (short > BAND_END_MIN) {
        const span = bandSpanBox(ax, Math.min(bandEnd, facEnd), Math.max(bandEnd, facEnd), g.c, y0, y1);
        if (!coveredBy(spanCover, span, ax, true, y0, y1)) {
          flags.push({ kind: "short_end", type: g.type, line: g.line, ax, box: span, pos: spotPos(ax, (bandEnd + facEnd) / 2, g.c, ymid), size: short, item: it.i, front, visible: eyes > 0 ? seenNear(items, Math.min(bandEnd, facEnd) + 0.05, Math.max(bandEnd, facEnd) - 0.05, 0) : null });
        }
        continue;
      }
      const corner = cornerLine(lines, ln, facEnd, y0, y1);
      if (corner < 0) continue;
      // An inside corner (the other facade runs on past this band's front:
      // a party wall meeting a rear block) hides the band's end: not a notch.
      if (insideCorner(lines[corner]!, g.c, front[th]!)) continue;
      // A corner piece at the band's end closes it.
      const cpt = spotPos(ax, bandEnd, g.c, ymid);
      const cbox = makeBox(sub(cpt, [0.05, (y1 - y0) * 0.25, 0.05]), add(cpt, [0.05, (y1 - y0) * 0.25, 0.05]));
      if (coveredBy(coverers, cbox, ax, false, y0, y1)) continue;
      const ret = returnBand(bands, g, corner);
      const outward = endI === 0 ? -1 : 1;
      if (!ret) {
        flags.push({ kind: "corner_open", type: g.type, line: g.line, ax, box: cbox, pos: cpt, size: 0, item: it.i, noReturn: true, front: cornerDir(front, ax, outward), visible: vis(items, bandEnd - 0.3, bandEnd + 0.3) });
        continue;
      }
      const sq = cornerSquare(ax, items, ret, y0, y1);
      const cov = squareCover(sq, bands, coverers);
      if (cov >= CORNER_COVER_MIN) continue;
      const centre = boxCenter(sq);
      const sx = sq.hi[ax]! - sq.lo[ax]!;
      const st = sq.hi[th]! - sq.lo[th]!;
      flags.push({
        kind: "corner_open",
        type: g.type,
        line: g.line,
        ax,
        box: sq,
        pos: [centre[0], ymid, centre[2]],
        size: Math.sqrt(sx * st),
        item: it.i,
        other: ret.i,
        cover: cov,
        front: cornerDir(front, ax, outward),
        visible: eyes > 0 ? anySeen(seenNear(items, bandEnd - 0.3, bandEnd + 0.3), seenNear([ret], sq.lo[th]! - 0.3, sq.hi[th]! + 0.3)) : null,
      });
    }
  }
  return flags;
}

/** Seen when either side saw it; unknown only when neither could tell. */
function anySeen(a: boolean | null, b: boolean | null): boolean | null {
  if (a === true || b === true) return true;
  if (a === null && b === null) return null;
  return false;
}

function cornerDir(front: Vec3, ax: 0 | 2, outward: number): Vec3 {
  const along: [number, number, number] = [0, 0, 0];
  along[ax] = outward;
  return normalize(add(front, along));
}

/** The same type of band on the corner's other facade line, at the same height, within 0.6 m. */
export function returnBand(bands: readonly BandRow[], g: BandGroup, cornerLineIdx: number): BandRow | null {
  let best: BandRow | null = null;
  let bd = Infinity;
  for (const b of bands) {
    if (b.line !== cornerLineIdx || b.type !== g.type || Math.abs(b.box.lo[1] - g.y0) > 0.15) continue;
    for (const it of g.items) {
      const d = boxDistance(b.box, it.box);
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
  }
  return bd <= 0.6 ? best : null;
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
 * band_continuity, exposed_edge, open_fixture_end and depth_step issues,
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
  const ran = (c: AuditCheck) => want.has(c) && result[c === "band_continuity" ? "bands" : c === "exposed_edge" ? "exposed" : c === "open_fixture_end" ? "fixture_ends" : "depth_steps"] !== undefined;
  if (eyes <= 0 && (ran("exposed_edge") || ran("open_fixture_end") || ran("depth_step") || ran("band_continuity"))) {
    notes.push("gap detectors: no walkable eye points (no open-sky floor), so nothing counts as seen; exposed_edge, open_fixture_end and depth_step measured nothing and band_continuity kept every spot.");
    for (const c of ["exposed_edge", "open_fixture_end", "depth_step"] as const) if (ran(c)) unmeasured.push(c);
  }
  const { bands, coverers } = parseBands(result.bands);
  const bandPieces = new Set(bands.map((b) => b.i));
  const edges = ran("exposed_edge") ? parseEdgeFlags(result.exposed).filter((f) => EDGE_CLASSES.has(f.cls) && inst[f.owner]) : [];
  const depth = ran("depth_step") ? parseDepthFlags(result.depth_steps).filter((f) => lines[f.line]) : [];
  const depthBoxes = depth.map((f) => depthBox(f, lines));
  const usedEdge = new Set<number>();
  const usedDepth = new Set<number>();

  // band_continuity first: it absorbs the A and C flags that confirm it.
  if (ran("band_continuity")) {
    if (!ran("exposed_edge") && !ran("depth_step")) notes.push("band_continuity ran without exposed_edge and depth_step: nothing confirms a band spot, so none is an error.");
    for (const f of bandFlags(lines, bands, coverers, inst, eyes)) {
      if (f.visible === false) continue;
      const byA = edges.map((e, k) => (boxDistance(e.box, f.box) <= CONFIRM_RADIUS ? k : -1)).filter((k) => k >= 0);
      const byC = depthBoxes.map((b, k) => (boxDistance(b, f.box) <= CONFIRM_RADIUS ? k : -1)).filter((k) => k >= 0);
      if (f.kind === "flipped" && !byA.length) continue;
      byA.forEach((k) => usedEdge.add(k));
      byC.forEach((k) => usedDepth.add(k));
      const by = [...(byA.length ? ["exposed_edge"] : []), ...(byC.length ? ["depth_step"] : [])];
      const r = inst[f.item];
      if (!r) continue;
      const other = f.other !== undefined ? inst[f.other] : undefined;
      const severity: Severity = by.length ? "error" : "warn";
      let why: string;
      let ev: Record<string, unknown>;
      let next: string;
      if (f.kind === "gap") {
        why = `missing ${f.type} run ${cm(f.size)} between ${r.p} and ${other?.p ?? "the next band piece"}`;
        ev = { type: f.type, kind: "gap", gap_m: r3(f.size), ...(other ? { other: other.p } : {}) };
        next = `summer_zoom at ${fmt(f.pos)}; close the gap: move ${r.p} or ${other?.p ?? "its neighbour"} flush (summer_place_adjacent), or add a band piece`;
      } else if (f.kind === "short_end") {
        why = `${f.type} stops ${cm(f.size)} before the facade end`;
        ev = { type: f.type, kind: "short_end", short_m: r3(f.size) };
        next = `summer_zoom at ${fmt(f.pos)}; extend the ${f.type} to the facade end or finish it with the kit's end piece`;
      } else if (f.kind === "corner_open") {
        const sq = [r2(f.box.hi[0] - f.box.lo[0]), r2(f.box.hi[2] - f.box.lo[2])];
        why = f.noReturn
          ? `${f.type} ends at an outside corner with no return band and no corner piece`
          : `outside corner: the ${f.type} corner square ${sq[0]} x ${sq[1]} m is ${Math.round((f.cover ?? 0) * 100)}% covered (the bands only touch${other ? `, ${other.p} on the other face` : ""}); no corner piece`;
        ev = { type: f.type, kind: "corner_open", ...(f.noReturn ? { return_band: null } : { square_m: sq, cover: r2(f.cover ?? 0), other: other?.p }) };
        next = `summer_zoom at ${fmt(f.pos)}; add the kit's ${f.type} corner piece at this corner (or wrap one band past the corner by its depth)`;
      } else {
        why = `${f.type} ${r.p} faces into the wall: its front points against the outward side of the wall behind it`;
        ev = { type: f.type, kind: "flipped" };
        next = `summer_inspect_node ${r.p}; turn it 180 deg about Y so its front faces away from the wall`;
      }
      if (by.length) {
        why += `; ${by.join(" and ")} ${by.length > 1 ? "confirm" : "confirms"} it`;
        ev.confirmed_by = by;
      }
      if (f.visible === null) ev.seen = "unknown";
      out.push({
        check: "band_continuity",
        severity,
        path: r.p,
        pos: v2(f.pos),
        why,
        ev,
        next,
        score: (by.length ? 1 : 0) + Math.min(1, Math.max(f.size, 0.1)),
        frame: { focus: f.pos, size: Math.max(1, f.size * 3), dirs: lookDirs(f.front, 3) },
      });
    }
  }

  // exposed_edge: the flags no band issue absorbed.
  if (ran("exposed_edge")) {
    edges.forEach((e, k) => {
      if (usedEdge.has(k)) return;
      const r = inst[e.owner]!;
      const cK = depthBoxes.map((b, j) => (!usedDepth.has(j) && boxDistance(b, e.box) <= CONFIRM_RADIUS ? j : -1)).filter((j) => j >= 0);
      const band = bandPieces.has(e.owner);
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
        next: `summer_zoom at ${fmt(f.c)}; add the next piece (summer_connect_ports ${r.p} ...), or end the run in the wall or with the kit's end piece`,
        score: f.r,
        frame: { focus: f.c, size: Math.max(0.6, 4 * f.r), dirs: [{ dir: normalize(sub(f.eye, f.c)), clear: distance(f.eye, f.c), pref: 1 }] },
      });
    }
  }

  // depth_step: holes confirm through_hole; the rest are look items. A run
  // that a door, gate or shutter covers over half its length is the door's
  // recess (the experiment's band_through false positives).
  if (ran("depth_step")) {
    const doors = coverers.filter((c) => c.door);
    depth.forEach((f, k) => {
      if (usedDepth.has(k)) return;
      const box = depthBoxes[k]!;
      const ax = lines[f.line]?.ax ?? 0;
      const run = growBox(box, 0.3);
      if (doors.some((d) => {
        const inter = boxIntersection(d.box, run);
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
