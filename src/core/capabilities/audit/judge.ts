/**
 * Judgment for summer_scene_audit: the kernel's raw measurements (rays that
 * passed, gaps under props, hull overlaps, mount rays, UV candidates, ...)
 * become issues with a check, a severity, a node path, a world position, a
 * one-line reason, the evidence numbers and the next tool to use.
 *
 * Every issue is a flag for the agent to LOOK at, never an auto-fix. The
 * thresholds are the spec's (2 cm floating, 3 cm embed/overlap, 5 cm mount,
 * 15 deg parallelism, UV stretch 8, insert host 2 cm / 1 deg); the severity
 * grading above them is ours and documented next to each check.
 */
import { add, length, normalize, scale, sub, type Vec3 } from "../seeing/math.js";
import type { AuditCheck, Severity } from "./args.js";
import {
  axisName,
  basisAngleDegrees,
  basisColumns,
  clusterSamples,
  DEFAULT_FAR,
  DEFAULT_NEAR,
  directionAngleDegrees,
  footprintExtent,
  isFrontBackSymmetric,
  lineAngleDegrees,
  localAxisName,
  matchInsertHost,
  median,
  mostCommon,
  mountGap,
  TYPICAL_VIEW_M,
  robustBounds,
  triangleArea,
  uvStretchRatio,
  wallDirection,
  zFightTolerance,
  type Basis9,
  type HostCandidate,
  type Vec2,
} from "./math.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FrameDir {
  dir: Vec3;
  clear: number;
  pref: number;
}

export interface FrameHint {
  focus: Vec3;
  size: number;
  dirs: FrameDir[];
  /** A viewpoint the kernel proved can see the spot (uv_stretch). */
  viewer?: Vec3;
}

export interface AuditIssue {
  check: AuditCheck;
  severity: Severity;
  path: string;
  pos: Vec3;
  why: string;
  ev: Record<string, unknown>;
  next: string;
  /** Magnitude for ordering within a severity (bigger first). */
  score: number;
  frame?: FrameHint;
}

export interface InstRow {
  p: string;
  k: string;
  s: string;
  r: string;
  in: boolean;
  o: Vec3;
  b: Basis9;
  sc: Vec3;
  det: number;
  c: Vec3;
  e: Vec3;
  le: Vec3;
  lc: Vec3;
  m: number;
  f: Vec3;
  nan?: boolean;
  lo?: Vec3;
  cl?: number[];
  cat?: string;
  /** Mount hint (local axis) and where it came from (pieces | pieces_auto | pack_text). */
  mh?: Vec3;
  ms?: string;
  /** Its LOCAL transform is identity / its parent's GLOBAL transform is identity. */
  li?: boolean;
  pi?: boolean;
}

export interface KernelResult {
  instances?: InstRow[];
  lines?: unknown[];
  floors?: Record<string, unknown>;
  support?: unknown[];
  overlaps?: unknown[];
  mounts?: unknown[];
  long_props?: unknown[];
  uv?: unknown[];
  inserts?: unknown[];
  /** Ground alternatives packs document: [pack dir, source file, material, clause]. */
  packs?: unknown[];
  /** z_fight from planar face groups: {near, far, pairs, in_mesh}. */
  zfight_geo?: Record<string, unknown>;
  lights?: Record<string, unknown>;
  resources?: Record<string, unknown>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// `|| 0` turns -0 into 0.
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

/** The 16 clearance directions the kernel measures around every instance
 *  (8 azimuths at 20 deg up, then 8 at 45 deg up). */
export function clearanceDirections(): Vec3[] {
  const out: Vec3[] = [];
  for (const elev of [20, 45]) {
    const ce = Math.cos((elev * Math.PI) / 180);
    const se = Math.sin((elev * Math.PI) / 180);
    for (let k = 0; k < 8; k++) {
      const a = (2 * Math.PI * k) / 8;
      out.push([Math.sin(a) * ce, se, Math.cos(a) * ce]);
    }
  }
  return out;
}
const CLEAR_DIRS = clearanceDirections();

function instDirs(row: InstRow | undefined, pref: (dir: Vec3, k: number) => number = (_d, k) => (k < 8 ? 1 : 0.7)): FrameDir[] {
  if (!row?.cl || row.cl.length !== CLEAR_DIRS.length) return [];
  return CLEAR_DIRS.map((dir, k) => ({ dir, clear: num(row.cl![k]), pref: pref(dir, k) }));
}

function instFrame(row: InstRow | undefined, focus?: Vec3, pref?: (dir: Vec3, k: number) => number): FrameHint | undefined {
  if (!row) return undefined;
  const dirs = instDirs(row, pref);
  if (!dirs.length) return undefined;
  return { focus: focus ?? row.c, size: Math.max(0.6, Math.max(row.e[0], row.e[1], row.e[2])), dirs };
}

function axisLabel(local: Vec3): string {
  const names: Array<[number, string]> = [
    [local[0], "X"],
    [local[1], "Y"],
    [local[2], "Z"],
  ];
  const best = names.reduce((a, b) => (Math.abs(b[0]) > Math.abs(a[0]) ? b : a));
  return `${best[0] >= 0 ? "+" : "-"}${best[1]}`;
}

function framesNodes(paths: string[], from: Vec3): string {
  return `summer_frame_nodes nodes=[${paths.join(",")}] from=${fmt(from)}`;
}

// ---------------------------------------------------------------------------
// through_hole
// ---------------------------------------------------------------------------

interface LineRow {
  n: Vec3;
  t: Vec3;
  d: number;
  spacing: number;
  through: number[][];
  pieces: number[][];
  inserts: number[][];
  zfight: unknown[];
}

function parseLine(raw: unknown): LineRow | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  return {
    n: vec(r.n),
    t: vec(r.t),
    d: num(r.d),
    spacing: num(r.spacing, 0.25),
    through: arr(r.through).filter(Array.isArray) as number[][],
    pieces: arr(r.pieces).filter(Array.isArray) as number[][],
    inserts: arr(r.inserts).filter(Array.isArray) as number[][],
    zfight: arr(r.zfight),
  };
}

interface HoleCluster {
  rays: number;
  w: number;
  h: number;
  pos: Vec3;
  host?: InstRow;
  beside: string[];
  far: number;
  clear: number;
  ray: { origin: Vec3; direction: Vec3 };
}

/** Clusters of see-through rays on each facade line; clusters beside the same
 *  host and insert (both sides of a too-narrow door) become one issue. */
export function judgeThroughHoles(lines: unknown[], inst: InstRow[]): AuditIssue[] {
  const out: AuditIssue[] = [];
  for (const raw of lines) {
    const line = parseLine(raw);
    if (!line || !line.through.length) continue;
    const s = line.spacing;
    const groups = clusterSamples(
      line.through.map((row) => ({ u: num(row[0]), v: num(row[1]) })),
      s * 1.5
    );
    const clusters: HoleCluster[] = [];
    for (const group of groups) {
      const rows = group.map((i) => line.through[i]!);
      const tlo = Math.min(...rows.map((r) => num(r[4], num(r[0]))));
      const thi = Math.max(...rows.map((r) => num(r[5], num(r[0]))));
      const ylo = Math.min(...rows.map((r) => num(r[6], num(r[1]))));
      const yhi = Math.max(...rows.map((r) => num(r[7], num(r[1]))));
      const tc = (tlo + thi) / 2;
      const yc = (ylo + yhi) / 2;
      // Host: the smallest piece rect containing the centre (a frame beats a wall).
      const containing = line.pieces
        .filter((p) => num(p[1]) - 0.05 <= tc && tc <= num(p[2]) + 0.05 && num(p[3]) - 0.05 <= yc && yc <= num(p[4]) + 0.05)
        .sort((a, b) => (num(a[2]) - num(a[1])) * (num(a[4]) - num(a[3])) - (num(b[2]) - num(b[1])) * (num(b[4]) - num(b[3])));
      const host = inst[num(containing[0]?.[0], -1)];
      const near = (rects: number[][]) =>
        rects
          .filter((p) => num(p[1]) < thi + 0.25 && num(p[2]) > tlo - 0.25 && num(p[3]) < yhi + 0.25 && num(p[4]) > ylo - 0.25)
          .map((p) => inst[num(p[0], -1)]?.p)
          .filter((p): p is string => !!p && p !== host?.p);
      const beside = [...near(line.inserts), ...near(line.pieces)].filter((p, i, a) => a.indexOf(p) === i).slice(0, 3);
      const clears = rows.map((r) => num(r[8], NaN)).filter((c) => Number.isFinite(c));
      const centerRow = rows.reduce((best, r) => (Math.hypot(num(r[0]) - tc, num(r[1]) - yc) < Math.hypot(num(best[0]) - tc, num(best[1]) - yc) ? r : best), rows[0]!);
      clusters.push({
        rays: rows.length,
        w: Math.max(0.03, thi - tlo),
        h: Math.max(0.03, yhi - ylo),
        pos: add(add(scale(line.t, tc), scale(line.n, line.d)), [0, yc, 0]),
        ...(host ? { host } : {}),
        beside,
        far: Math.min(...rows.map((r) => num(r[3], 4))),
        clear: clears.length ? median(clears) : 6,
        ray: { origin: add(add(scale(line.t, num(centerRow[0])), scale(line.n, line.d + 0.6)), [0, num(centerRow[1]), 0]), direction: scale(line.n, -1) },
      });
    }
    const merged = new Map<string, HoleCluster[]>();
    clusters.forEach((c, k) => {
      const key = c.host ? `${c.host.p}|${c.beside[0] ?? ""}` : `#${k}`;
      const list = merged.get(key);
      if (list) list.push(c);
      else merged.set(key, [c]);
    });
    for (const list of merged.values()) {
      list.sort((a, b) => b.rays - a.rays);
      const main = list[0]!;
      const rays = list.reduce((sum, c) => sum + c.rays, 0);
      const path = main.host?.p ?? main.beside[0] ?? "?";
      const severity: Severity = rays >= 3 || main.h >= 0.4 ? "error" : "warn";
      const sizes = `${list.map((c) => `${r2(c.w)}x${r2(c.h)}`).join(" + ")} m`;
      out.push({
        check: "through_hole",
        severity,
        path,
        pos: v2(main.pos),
        why: `see-through ${list.length > 1 ? "gaps" : "gap"} ${sizes}: ${rays} rays pass the wall to the far side of the building`,
        ev: {
          w: r2(main.w),
          h: r2(main.h),
          rays,
          ...(list.length > 1 ? { gaps: list.slice(0, 3).map((c) => [...v2(c.pos), r2(c.w), r2(c.h)]) } : {}),
          ...(main.beside.length ? { beside: main.beside.slice(0, 2) } : {}),
          ray: [v2(main.ray.origin), v2(main.ray.direction)],
        },
        next: framesNodes([path, ...main.beside.slice(0, 1)], add(line.n, [0, 0.2, 0])),
        score: rays * s * s,
        frame: {
          focus: main.pos,
          size: Math.max(1, main.w, main.h),
          dirs: [{ dir: normalize(line.n), clear: main.clear, pref: 1 }],
        },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// floor_gap
// ---------------------------------------------------------------------------

/** A ground alternative a pack documents (PACK.json how_to_use or
 *  ASSEMBLY.md): "for any other ground use material ... on a PlaneMesh". */
export interface PackGround {
  dir: string;
  source: string;
  material: string;
  plane: boolean;
}

export function parsePackGrounds(raw: unknown): PackGround[] {
  return (arr(raw).filter(Array.isArray) as unknown[][])
    .map((p) => ({ dir: String(p[0] ?? ""), source: String(p[1] ?? ""), material: String(p[2] ?? ""), plane: /plane ?mesh/i.test(String(p[3] ?? "")) }))
    .filter((p) => p.dir.startsWith("res://") && p.material.startsWith("res://"));
}

/** The ground alternative of the pack a piece's scene lives in (deepest pack folder wins). */
export function packGroundFor(scene: string | undefined, packs: readonly PackGround[]): PackGround | undefined {
  if (!scene) return undefined;
  return packs.filter((p) => scene.startsWith(p.dir.endsWith("/") ? p.dir : `${p.dir}/`)).sort((a, b) => b.dir.length - a.dir.length)[0];
}

function groundNext(pack: PackGround | undefined): string {
  return pack ? `; the pack documents a ground alternative (${pack.source}): ${pack.material}${pack.plane ? " on a PlaneMesh" : ""}` : "";
}

/** One gap row as the kernel writes it (older kernels: the first 6-7 fields). */
interface GapRow {
  x: number;
  z: number;
  top: number;
  owner: number;
  hit: number;
  hitY: number | null;
  clear: number;
  /** 0 grid cell, 1 seam between tiles, 2 bare strip between a tile edge and a wall. */
  kind: number;
  sx: number;
  sz: number;
  area: number;
  /** The floor's own surface under the underlay the ray hit first, if any. */
  below: number | null;
  belowInst: number;
  wall: number;
}

function parseGapRow(g: unknown[], cell: number): GapRow {
  const sx = num(g[8], cell);
  const sz = num(g[9], cell);
  return {
    x: num(g[0]),
    z: num(g[1]),
    top: num(g[2]),
    owner: num(g[3], -1),
    hit: num(g[4], -1),
    hitY: typeof g[5] === "number" ? g[5] : null,
    clear: num(g[6], NaN),
    kind: num(g[7], 0),
    sx,
    sz,
    area: num(g[10], sx * sz),
    below: typeof g[11] === "number" ? g[11] : null,
    belowInst: num(g[12], -1),
    wall: num(g[13], -1),
  };
}

/** "8.4 x 0.04 m": the long side first; centimetre precision below 10 cm. */
function dims(long: number, short: number): string {
  const f = (n: number) => (n < 0.1 ? r3(n) : r2(n));
  return `${f(long)} x ${f(short)} m`;
}

const TOP_DOWN = normalize([0.3, 1, 0.25]);

/**
 * floor_gap. Down rays over the tile footprints (a grid, plus rays along the
 * seams between tiles) and along each tile edge that a wall bounds within
 * 1 m (the strip between the last tile and the wall base). Each row says
 * which surface the ray hit FIRST:
 * - nothing: the void shows (error);
 * - an underlay with the floor's own surface right under it: the underlay
 *   plane sits above a drain channel or dip and paints over it ("covers the
 *   floor", warn), not a hole;
 * - an underlay with nothing under it: a hole in the tile, or a bare strip
 *   outside the tiles.
 * A piece whose own mesh has holes (or whose low surfaces the underlay
 * covers) in every tile is ONE issue for the piece. Areas are the sum of the
 * missed rays' own footprints, with the strip's dimensions.
 */
export function judgeFloorGaps(floors: Record<string, unknown> | undefined, inst: InstRow[], packs: readonly PackGround[] = []): AuditIssue[] {
  if (!floors) return [];
  const out: AuditIssue[] = [];
  const cell = num(floors.cell, 0.3);
  const rows = (arr(floors.gaps).filter(Array.isArray) as unknown[][]).map((g) => parseGapRow(g, cell));
  const pieceOf = (g: GapRow) => inst[g.owner]?.k ?? "";
  const perOwner = arr(floors.per_owner).filter(Array.isArray) as number[][];
  // A piece whose OWN mesh has holes shows them in every instance: one issue
  // per piece, not one per hole.
  const byPiece = new Map<string, Array<{ i: number; holes: number; void: number; covered: number }>>();
  for (const row of perOwner) {
    const i = num(row[0], -1);
    const cells = num(row[1]);
    const r = inst[i];
    if (!r || cells < 10) continue;
    const list = byPiece.get(r.k) ?? [];
    list.push({ i, holes: num(row[2]) / cells, void: num(row[3]) / cells, covered: num(row[4]) / cells });
    byPiece.set(r.k, list);
  }
  const holed = new Set<string>();
  const coveredPieces = new Set<string>();
  for (const [piece, list] of byPiece) {
    const showing = list.filter((x) => x.holes >= 0.05);
    if (showing.length >= 2) {
      holed.add(piece);
      const worst = showing.reduce((a, b) => (b.holes > a.holes ? b : a));
      const r = inst[worst.i]!;
      const meanFrac = showing.reduce((sum, x) => sum + x.holes, 0) / showing.length;
      const voidShare = showing.reduce((sum, x) => sum + x.void, 0) / showing.length;
      const shows = voidShare > meanFrac / 2 ? "the void" : "the underlay";
      const focus: Vec3 = [r.c[0], r.c[1] + r.e[1] / 2, r.c[2]];
      const pack = packGroundFor(r.s, packs);
      out.push({
        check: "floor_gap",
        severity: shows === "the void" ? "error" : "warn",
        path: r.p,
        pos: v2(focus),
        why: `${piece} has holes in its own mesh: ${Math.round(meanFrac * 100)}% of each tile shows ${shows} (${showing.length}/${list.length} tiles)`,
        ev: { piece, tiles: showing.length, fraction: r2(meanFrac), worst: r2(worst.holes), also: showing.filter((x) => x !== worst).slice(0, 2).map((x) => inst[x.i]!.p), ...(pack ? { pack_ground: pack.material } : {}) },
        next: `summer_frame_nodes nodes=[${r.p}] direction=top${groundNext(pack)}`,
        score: meanFrac * showing.length,
        frame: { focus, size: Math.max(r.e[0], r.e[2]) * 0.6, dirs: [{ dir: TOP_DOWN, clear: 8, pref: 1 }] },
      });
    }
    const covering = list.filter((x) => x.covered >= 0.05);
    if (covering.length >= 2) {
      coveredPieces.add(piece);
      const worst = covering.reduce((a, b) => (b.covered > a.covered ? b : a));
      const r = inst[worst.i]!;
      const meanFrac = covering.reduce((sum, x) => sum + x.covered, 0) / covering.length;
      const mine = rows.filter((g) => g.below !== null && g.kind !== 2 && pieceOf(g) === piece);
      const underlay = inst[mostCommon(mine.map((g) => g.hit))];
      const lowest = mine.length ? Math.min(...mine.map((g) => g.below!)) : null;
      const focus: Vec3 = [r.c[0], r.c[1] + r.e[1] / 2, r.c[2]];
      out.push({
        check: "floor_gap",
        severity: "warn",
        path: r.p,
        pos: v2(focus),
        why: `${underlay?.p ?? "the underlay"} covers ${piece}'s own low surfaces: ${Math.round(meanFrac * 100)}% of each tile (${covering.length}/${list.length} tiles); the underlay plane sits above the floor there and paints over it, not a hole`,
        ev: { piece, tiles: covering.length, fraction: r2(meanFrac), ...(underlay ? { underlay: underlay.p } : {}), ...(lowest !== null ? { floor_low_y: r3(lowest) } : {}) },
        next: `summer_set_prop ${underlay?.p ?? "<underlay>"} position: lower it${lowest !== null ? ` under y ${r3(lowest - 0.005)}` : ""} (the floor's lowest surface), then re-seat props`,
        score: meanFrac * covering.length,
        frame: { focus, size: Math.max(r.e[0], r.e[2]) * 0.6, dirs: [{ dir: TOP_DOWN, clear: 8, pref: 1 }] },
      });
    }
  }
  // The rest cluster by location, one class at a time.
  const covered = rows.filter((g) => g.below !== null && !(g.kind !== 2 && coveredPieces.has(pieceOf(g))));
  const strips = rows.filter((g) => g.below === null && g.kind === 2);
  const holes = rows.filter((g) => g.below === null && g.kind !== 2 && !holed.has(pieceOf(g)));
  const clusters = (list: GapRow[]) => clusterSamples(list.map((g) => ({ u: g.x, v: g.z })), cell * 1.5).map((group) => group.map((i) => list[i]!));
  const place = (group: GapRow[]) => {
    const ext = footprintExtent(group);
    const top = Math.max(...group.map((g) => g.top));
    const ownerIdx = mostCommon(group.map((g) => g.owner));
    const pos: Vec3 = [(ext.x0 + ext.x1) / 2, top, (ext.z0 + ext.z1) / 2];
    const clears = group.map((g) => g.clear).filter((c) => Number.isFinite(c));
    const frame: FrameHint = { focus: pos, size: Math.max(1.2, Math.sqrt(ext.area) * 2, Math.min(ext.long, 6) * 0.6), dirs: [{ dir: TOP_DOWN, clear: clears.length ? median(clears) : 4, pref: 1 }] };
    const ray = `summer_raycast origin=${fmt([group[0]!.x, top + 0.6, group[0]!.z])} direction=(0,-1,0)`;
    return { ext, top, ownerIdx, owner: inst[ownerIdx], pos, frame, ray, size: { rays: group.length, w: r3(ext.w), d: r3(ext.d), area_m2: r3(ext.area) } };
  };
  for (const group of clusters(holes)) {
    const { ext, ownerIdx, owner, pos, frame, ray, size } = place(group);
    const voidRows = group.filter((g) => g.hit < 0).length;
    const fellTo = voidRows > group.length / 2 ? "void" : (inst[group.find((g) => g.hit >= 0)?.hit ?? -1]?.p ?? "void");
    const severity: Severity = fellTo === "void" ? "error" : group.length >= 3 ? "warn" : "look";
    const beside = [...new Set(group.map((g) => g.owner))].filter((k) => k !== ownerIdx).map((k) => inst[k]?.p).filter((p): p is string => !!p).slice(0, 2);
    const pack = packGroundFor(owner?.s, packs);
    out.push({
      check: "floor_gap",
      severity,
      path: owner?.p ?? "?",
      pos: v2(pos),
      why: `floor gap ${r2(ext.area)} m2 (${dims(ext.long, ext.short)}): ${group.length} down rays miss the floor and fall to ${fellTo === "void" ? "the void" : fellTo}`,
      ev: { ...size, ...(beside.length ? { beside } : {}), ...(pack ? { pack_ground: pack.material } : {}) },
      next: `${ray}${groundNext(pack)}`,
      score: ext.area,
      frame,
    });
  }
  for (const group of clusters(covered)) {
    const { ext, owner, pos, frame, ray, size } = place(group);
    const underlay = inst[mostCommon(group.map((g) => g.hit))];
    const floor = inst[mostCommon(group.map((g) => g.belowInst).filter((i) => i >= 0))] ?? owner;
    const lowest = Math.min(...group.map((g) => g.below!));
    const above = Math.max(...group.map((g) => (g.hitY ?? g.top) - g.below!));
    out.push({
      check: "floor_gap",
      severity: "warn",
      path: floor?.p ?? owner?.p ?? "?",
      pos: v2(pos),
      why: `${underlay?.p ?? "the underlay"} covers the floor over ${r2(ext.area)} m2 (${dims(ext.long, ext.short)}): it sits up to ${cm(above)} above the floor's own surface (a drain channel or dip) and paints over it; not a hole`,
      ev: { ...size, ...(underlay ? { underlay: underlay.p } : {}), floor_low_y: r3(lowest), above_m: r3(above) },
      next: `${ray}; lower ${underlay?.p ?? "the underlay"} under y ${r3(lowest - 0.005)} with summer_set_prop`,
      score: ext.area,
      frame,
    });
  }
  for (const group of clusters(strips)) {
    const { ext, owner, pos, frame, size } = place(group);
    const wall = inst[mostCommon(group.map((g) => g.wall).filter((i) => i >= 0))];
    const voidRows = group.filter((g) => g.hit < 0).length;
    const shows = voidRows > group.length / 2 ? "the void" : (inst[mostCommon(group.map((g) => g.hit).filter((i) => i >= 0))]?.p ?? "the underlay");
    const pack = packGroundFor(owner?.s, packs);
    out.push({
      check: "floor_gap",
      severity: shows === "the void" ? "error" : ext.area >= 0.05 ? "warn" : "look",
      path: owner?.p ?? "?",
      pos: v2(pos),
      why: `bare strip ${dims(ext.long, ext.short)} (${r2(ext.area)} m2) between ${owner?.p ?? "the floor"}'s edge and ${wall?.p ?? "a wall"}: the floor stops short of the wall and ${shows} shows`,
      ev: { ...size, ...(wall ? { wall: wall.p } : {}), ...(pack ? { pack_ground: pack.material } : {}) },
      next: `summer_measure ${owner?.p ?? "<floor>"} vs ${wall?.p ?? "<wall>"}; extend the floor to the wall${groundNext(pack)}`,
      score: ext.area,
      frame,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// floating / sunken
// ---------------------------------------------------------------------------

export function judgeSupport(support: unknown[], inst: InstRow[], wallMounted: Set<number>): AuditIssue[] {
  const out: AuditIssue[] = [];
  for (const raw of support) {
    if (!Array.isArray(raw)) continue;
    const i = num(raw[0], -1);
    const r = inst[i];
    if (!r) continue;
    const ymin = num(raw[1]);
    const hits = arr(raw[3]).map((h) => (Array.isArray(h) ? { y: num(h[0]), at: num(h[1], -1) } : null));
    const touch = typeof raw[4] === "number" ? (raw[4] as number) : null;
    const floorTop = typeof raw[5] === "number" ? (raw[5] as number) : null;
    const found = hits.filter((h): h is { y: number; at: number } => h !== null);
    const focus: Vec3 = [r.c[0], ymin + Math.min(0.3, r.e[1] / 2), r.c[2]];
    // Framed on the instance centre: that is where the clearances were measured.
    const frame = instFrame(r, r.c, (_d, k) => (k < 8 ? 1 : 0.5));
    if (wallMounted.has(i)) continue;
    // Clear of the ground but against a wall (a lantern, a sign, an AC unit):
    // held by the wall, not floating. With a mount hint, a wall within 15 cm
    // of its bounds counts (a bracket tip is thinner than its box); without
    // one it must touch and be well off the ground (a crate 5 cm up a wall
    // still floats).
    const topY = found.length ? Math.max(...found.map((h) => h.y)) : -Infinity;
    if (touch !== null && (r.mh !== undefined ? touch <= 0.15 : touch <= 0.05 && ymin - topY > 0.3)) continue;
    // Sunken, from ABOVE: the first surface a ray down through the footprint
    // meets (below the prop's own top) is what the prop stands in. The
    // support ray from mid-height never sees a floor top above its start, so
    // a bottle buried 16.7 cm in a floor tile read as "sunk into the
    // underlay" under it. Older kernels send no rows here: the support rays
    // below decide.
    const above = arr(raw[6])
      .map((h) => (Array.isArray(h) ? { y: num(h[0]), at: num(h[1], -1) } : null))
      .filter((h): h is { y: number; at: number } => h !== null && h.y <= ymin + r.e[1] - 0.005);
    if (above.length) {
      const embed = median(above.map((h) => h.y)) - ymin;
      if (embed > 0.03) {
        if (r.r === "dressing") continue;
        const buried = above.filter((h) => h.y - ymin > 0.03);
        const at = mostCommon(buried.map((h) => h.at));
        const support = inst[at];
        const surfaceY = median(buried.filter((h) => h.at === at).map((h) => h.y));
        const height = Math.max(0.01, r.e[1]);
        const below = found.length ? inst[found.reduce((a, b) => (b.y > a.y ? b : a)).at] : undefined;
        out.push({
          check: "sunken",
          severity: embed >= height * 0.5 ? "error" : embed > 0.1 ? "warn" : "look",
          path: r.p,
          pos: v2(focus),
          why: `sunk ${cm(embed)} into ${support?.p ?? "the surface"} (the first surface from above, at y ${r3(surfaceY)})${embed >= height * 0.5 ? `: ${Math.round((embed / height) * 100)}% of its height` : ""}`,
          ev: { embed_m: r3(embed), height_m: r3(height), support: support?.p ?? null, support_y: r3(surfaceY), ...(below && below !== support ? { under_it: below.p } : {}) },
          next: `summer_snap_to_surface ${r.p}`,
          score: embed,
          ...(frame ? { frame } : {}),
        });
        continue;
      }
    }
    if (!found.length) {
      out.push({
        check: "floating",
        severity: "error",
        path: r.p,
        pos: v2(focus),
        why: `nothing under its footprint within 1 m${touch !== null ? ` and no wall within 5 cm (nearest ${cm(Math.max(0, touch))})` : ""}: it hangs in the air`,
        ev: { gap_m: ">1", samples: 0, ...(touch !== null ? { wall_m: r3(touch) } : {}) },
        next: `summer_snap_to_surface ${r.p}`,
        score: 2,
        ...(frame ? { frame } : {}),
      });
      continue;
    }
    const best = found.reduce((a, b) => (b.y > a.y ? b : a));
    const gap = ymin - best.y;
    const support = inst[best.at];
    if (gap > 0.02) {
      // Standing at the floor level over a hole in the floor tile, with only
      // the underlay below: the floor is the problem (floor_gap), not the prop.
      const overHole = support?.r === "underlay" && (gap <= 0.06 || (floorTop !== null && Math.abs(ymin - floorTop) <= 0.04));
      out.push({
        check: "floating",
        severity: overHole ? "look" : gap > 0.1 ? "error" : "warn",
        path: r.p,
        pos: v2(focus),
        why: overHole ? `stands at floor level over a hole in the floor: only ${support?.p ?? "the underlay"} is under it, ${cm(gap)} down` : `floats ${cm(gap)} above ${support?.p ?? "the surface below"}`,
        ev: { gap_m: r3(gap), support: support?.p ?? null, samples: `${found.length}/${hits.length}` },
        next: `summer_snap_to_surface ${r.p}`,
        score: gap,
        ...(frame ? { frame } : {}),
      });
      continue;
    }
    if (r.r === "dressing" || above.length) continue;
    const ys = found.map((h) => h.y);
    const embed = median(ys) - ymin;
    if (embed > 0.03) {
      const height = Math.max(0.01, r.e[1]);
      const deepest = found.reduce((a, b) => (b.y > a.y ? b : a));
      out.push({
        check: "sunken",
        severity: embed >= height * 0.5 ? "error" : embed > 0.1 ? "warn" : "look",
        path: r.p,
        pos: v2(focus),
        why: `sunk ${cm(embed)} into ${inst[deepest.at]?.p ?? "the surface"}${embed >= height * 0.5 ? ` (${Math.round((embed / height) * 100)}% of its height)` : ""}`,
        ev: { embed_m: r3(embed), height_m: r3(height), support: inst[deepest.at]?.p ?? null },
        next: `summer_snap_to_surface ${r.p}`,
        score: embed,
        ...(frame ? { frame } : {}),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// interpenetration
// ---------------------------------------------------------------------------

/** Overlaps the kernel reports start at 1 cm; a prop is an issue when its
 *  deepest overlap is over 3 cm, and then every partner it cuts is named. */
export const OVERLAP_MIN = 0.03;
export const OVERLAP_PARTNERS = 3;

export function judgeOverlaps(overlaps: unknown[], inst: InstRow[]): AuditIssue[] {
  // One issue per prop: its deepest overlap first, then every other piece it
  // cuts (up to 3 in all), shallower ones included: a lamp 18.7 cm into a
  // duct that also clips the door band beside it is one problem with two
  // partners, and moving it out of the duct alone does not fix it.
  const byProp = new Map<number, Array<{ b: InstRow; depth: number; point: Vec3 }>>();
  for (const raw of overlaps) {
    if (!Array.isArray(raw)) continue;
    const ai = num(raw[0], -1);
    const b = inst[num(raw[1], -1)];
    const depth = num(raw[2]);
    if (!inst[ai] || !b || depth < 0.01) continue;
    const list = byProp.get(ai) ?? [];
    list.push({ b, depth, point: vec(raw[3]) });
    byProp.set(ai, list);
  }
  const kindOf = (b: InstRow) => (b.r === "prop" ? "another prop" : b.r === "mount" ? "a mounted piece" : "the structure");
  const out: AuditIssue[] = [];
  for (const [ai, list] of byProp) {
    const a = inst[ai]!;
    list.sort((x, y) => y.depth - x.depth);
    const { b, depth, point } = list[0]!;
    if (depth <= OVERLAP_MIN) continue;
    const partners = list.slice(0, OVERLAP_PARTNERS);
    const also = partners.slice(1).map((o) => `${o.b.p} (${kindOf(o.b)}) ${cm(o.depth)}`);
    out.push({
      check: "interpenetration",
      severity: depth >= 0.1 ? "warn" : "look",
      path: a.p,
      pos: v2(point),
      why: `overlaps ${b.p} (${kindOf(b)}) by ${cm(depth)}${also.length ? `; also ${also.join(", ")}` : ""}`,
      ev: {
        depth_m: r3(depth),
        other: b.p,
        other_role: b.r,
        partners: partners.map((o) => [o.b.p, r3(o.depth)]),
        ...(list.length > OVERLAP_PARTNERS ? { more: list.length - OVERLAP_PARTNERS } : {}),
      },
      next: `summer_test_placement ${a.p} (lists every overlap), then summer_measure ${a.p} vs ${b.p}`,
      score: depth,
      ...(instFrame(a) ? { frame: instFrame(a)! } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// insert_host
// ---------------------------------------------------------------------------

export function judgeInserts(inserts: unknown[], inst: InstRow[]): AuditIssue[] {
  const out: AuditIssue[] = [];
  for (const raw of inserts) {
    if (!Array.isArray(raw)) continue;
    const r = inst[num(raw[0], -1)];
    if (!r) continue;
    const hostPiece = String(raw[1] ?? "");
    if (!hostPiece) continue;
    const offset = vec(raw[2]);
    const origin = vec(raw[3]);
    const basis = arr(raw[4]).map((x) => num(x));
    const candidates: HostCandidate[] = (arr(raw[5]).filter(Array.isArray) as unknown[][]).map((n) => ({
      index: num(n[0], -1),
      piece: String(n[1] ?? ""),
      origin: vec(n[2]),
      basis: arr(n[3]).map((x) => num(x)),
    }));
    const containing = arr(raw[6]).map((x) => num(x, -1));
    const m = matchInsertHost(origin, basis, offset, hostPiece, candidates);
    if (m.status === "ok") continue;
    let why: string;
    let found: Record<string, unknown> = {};
    if (m.status === "wrong_offset" && m.named) {
      const h = inst[m.named.index];
      why = `its host ${hostPiece} ${h?.p ?? ""} is ${cm(m.named.distance)} / ${r2(m.named.angle)} deg from where pieces.json puts it`;
      found = { path: h?.p, piece: hostPiece, off_m: r3(m.named.distance), angle: r2(m.named.angle) };
    } else if (m.status === "wrong_piece" && m.other) {
      const h = inst[m.other.index];
      why = `pieces.json fits it into ${hostPiece}; it sits on ${m.other.piece} ${h?.p ?? ""}`;
      found = { path: h?.p, piece: m.other.piece, off_m: r3(m.other.distance) };
    } else {
      const h = inst[containing[0] ?? -1];
      const dist = h ? length(sub(h.o, m.expected)) : -1;
      why = h ? `pieces.json fits it into ${hostPiece}; it sits in ${h.k} ${h.p}` : `no ${hostPiece} at the pose pieces.json expects`;
      found = h ? { path: h.p, piece: h.k, off_m: r3(dist) } : {};
    }
    const front = normalize(basisColumns(basis)[2]);
    const frame = instFrame(r, r.c, (dir) => Math.max(0, dir[0] * front[0] + dir[2] * front[2]));
    out.push({
      check: "insert_host",
      severity: "error",
      path: r.p,
      pos: v2(r.c),
      why,
      ev: { insert: r.k, host_at: v2(m.expected), found: found.piece ?? null, off_m: found.off_m ?? null },
      next: `summer_replace_node ${String(found.path ?? r.p)} -> ${hostPiece}, or a fitting insert`,
      score: 1,
      ...(frame ? { frame } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// mount_gap + orientation of mounted pieces
// ---------------------------------------------------------------------------

/** World bounds of two pieces touch (within `slack`) on all three axes. */
export function boundsTouch(a: InstRow, b: InstRow, slack = 0.02): boolean {
  for (let k = 0; k < 3; k++) {
    if (Math.abs(a.c[k]! - b.c[k]!) > (a.e[k]! + b.e[k]!) / 2 + slack) return false;
  }
  return true;
}

/** Another mounted piece's world bounds touch this one's (2 cm slack). */
export function touchesMount(i: number, inst: InstRow[]): boolean {
  const a = inst[i];
  if (!a) return false;
  return inst.some((b, j) => j !== i && (b.r === "mount" || b.mh !== undefined) && boundsTouch(a, b));
}

/** A bracket, clamp, strap or hanger: what holds a pipe off its wall. */
const HOLDER_RE = /(brac|clamp|clip|hanger|strap|holder|support)/i;

export interface MountJudgement {
  issues: AuditIssue[];
  /** Instances a wall holds (gap <= 10 cm behind): never "floating". */
  wallMounted: Set<number>;
}

interface MountRow {
  i: number;
  r: InstRow;
  wax: Vec3;
  gaps: Array<number | null>;
  hitAt: number[];
  hit?: InstRow;
  nearest: { dir: Vec3; dist: number; at: number } | null;
  src: string;
  local: Vec3;
  chain: number | null;
  ground: number | null;
  standoff: number | null;
  standoffSrc: string;
  symmetric: boolean;
  /** Closest contact behind the mount side (any of the 9 samples). */
  min: number | null;
  /** Closest contact with the facade itself (a bracket ring around a pipe is not the wall). */
  wallMin: number | null;
  /** The gap the check judges: the largest of the centre and side samples. */
  gap: number | null;
  at: number;
  /** A symmetric piece turned 180 degrees: measured on the side facing the wall. */
  flipped: boolean;
}

function parseMountRow(raw: unknown[], inst: InstRow[]): MountRow | null {
  const i = num(raw[0], -1);
  const r = inst[i];
  if (!r) return null;
  const wax = vec(raw[1]);
  const gaps = arr(raw[2]).map((g) => (typeof g === "number" && Number.isFinite(g) ? g : null));
  const around = (arr(raw[4]).filter(Array.isArray) as unknown[][]).map((a) => ({ dir: vec(a[0]), dist: num(a[1]), at: num(a[2], -1) }));
  const nearest = around.length ? around.reduce((a, b) => (b.dist < a.dist ? b : a)) : null;
  const meta = raw[13];
  const planes = Array.isArray(raw[12]) ? (raw[12] as unknown[]).map((x) => num(x, NaN)) : null;
  const symmetric = meta === true || (meta !== false && isFrontBackSymmetric(planes));
  const measured = mountGap(gaps);
  let { min, gap, at } = measured;
  // Turned 180 degrees, a symmetric piece's mount side faces away and finds
  // no wall; its real gap is on the side that faces the wall.
  const flipped = symmetric && nearest !== null && directionAngleDegrees(wax, nearest.dir) > 135 && (min === null || nearest.dist < min);
  if (flipped) {
    min = nearest!.dist;
    gap = nearest!.dist;
    at = -1;
  }
  const hitAt = arr(raw[14]).map((x) => num(x, -1));
  const facade = gaps.map((g, k) => (g !== null && FACADE_ROLES.has(inst[hitAt[k] ?? -1]?.r ?? "") ? g : null));
  const wallMin = flipped ? min : hitAt.length ? mountGap(facade).min : min;
  return {
    wallMin,
    i,
    r,
    wax,
    gaps,
    hitAt: arr(raw[14]).map((x) => num(x, -1)),
    ...(inst[num(raw[3], -1)] ? { hit: inst[num(raw[3], -1)]! } : {}),
    nearest,
    src: String(raw[6] ?? ""),
    local: raw[7] ? vec(raw[7]) : ([0, 0, -1] as Vec3),
    chain: typeof raw[8] === "number" ? raw[8] : null,
    ground: typeof raw[9] === "number" ? raw[9] : null,
    standoff: typeof raw[10] === "number" && Number.isFinite(raw[10]) ? raw[10] : null,
    standoffSrc: String(raw[11] ?? ""),
    symmetric,
    min,
    gap,
    at,
    flipped,
  };
}

/** Which side of the mount face sample k sits on (the kernel's u / v axes). */
function sampleSide(local: Vec3, k: number): string {
  if (k === 0) return "centre";
  const u: Vec3 = [local[1], local[2], local[0]];
  const v: Vec3 = [local[1] * u[2] - local[2] * u[1], local[2] * u[0] - local[0] * u[2], local[0] * u[1] - local[1] * u[0]];
  const dir = k === 5 ? u : k === 6 ? scale(u, -1) : k === 7 ? v : k === 8 ? scale(v, -1) : null;
  return dir ? `${axisLabel(dir)} side` : "corner";
}

/**
 * Pieces held off the wall by design: a mounted sibling touching it that
 * touches the wall itself (a bracket, clamp or strap by name, or a piece
 * clearly smaller than it) holds it; along a run, a piece touching a held
 * piece at about the same standoff (within 3 cm) is held too (the outlet
 * at the foot of a braced gutter). Returns held index -> the holder's path.
 */
const FACADE_ROLES = new Set(["wall", "struct", "insert"]);

function heldByBrackets(rows: readonly MountRow[]): Map<number, string> {
  const onWall = (m: MountRow) => m.wallMin !== null && m.wallMin <= 0.05;
  const size = (r: InstRow) => Math.max(r.e[0], r.e[1], r.e[2]);
  const held = new Map<number, string>();
  const anchors = rows.filter(onWall);
  for (const m of rows) {
    // A piece that touches the wall at one edge (a downpipe passing a proud
    // dado) can still be held off it by a bracket at its centre.
    const holder = anchors.find((a) => a.i !== m.i && boundsTouch(m.r, a.r) && (HOLDER_RE.test(a.r.k) || HOLDER_RE.test(a.r.p.split("/").pop() ?? "") || size(a.r) <= 0.6 * size(m.r)));
    if (holder && !(HOLDER_RE.test(m.r.k) && onWall(m))) held.set(m.i, holder.r.p);
  }
  const queue = [...held.keys()];
  const byIndex = new Map(rows.map((m) => [m.i, m] as const));
  while (queue.length) {
    const h = byIndex.get(queue.shift()!)!;
    for (const n of rows) {
      if (held.has(n.i) || n.i === h.i || n.gap === null || h.gap === null) continue;
      if (n.gap > h.gap + 0.03 || !boundsTouch(n.r, h.r)) continue;
      held.set(n.i, held.get(h.i)!);
      queue.push(n.i);
    }
  }
  return held;
}

export function judgeMounts(mounts: unknown[], inst: InstRow[], checks: Set<AuditCheck>): MountJudgement {
  const issues: AuditIssue[] = [];
  const wallMounted = new Set<number>();
  const rows = (mounts.filter(Array.isArray) as unknown[][]).map((raw) => parseMountRow(raw, inst)).filter((m): m is MountRow => m !== null);
  const held = heldByBrackets(rows);
  for (const m of rows) {
    const { i, r, wax, nearest } = m;
    // Held by another mounted piece: a ray contact, or bounds that touch
    // (open duct and pipe ends have no face at the joint for a ray to hit).
    const chained = (m.chain !== null && m.chain <= 0.05) || touchesMount(i, inst);
    const standing = m.ground !== null && Math.abs(m.ground) <= 0.05;
    const side = axisLabel(m.local);
    if (m.min !== null && m.min <= 0.1) wallMounted.add(i);
    // Weak hints: a pack's prose, or a piece that stands on the floor
    // against a wall in the pack's reference scene (a utility cabinet).
    const textOnly = m.src === "pack_text" || m.src === "pieces_floor";
    // A hint read from a pack's prose is weak: if the piece touches a wall on
    // ANY side, the geometry says it is mounted (a lantern whose bracket runs
    // along X) and the prose is what is wrong. Only structured metadata
    // (pieces.json wall_side) is held against a piece that touches a wall.
    if (textOnly && nearest && nearest.dist <= 0.05) {
      wallMounted.add(i);
      continue;
    }
    const metadata = m.src === "pack_text" ? "PACK.json text" : m.src === "pieces_floor" ? "pieces.json (stands on the floor against a wall in the pack's scene)" : m.src === "pieces_auto" ? "pieces.json (mounted in the pack's scene; side measured: the nearest wall)" : "pieces.json";
    const frame = instFrame(r, r.c, (dir) => 1 - Math.abs(dir[0] * wax[0] + dir[2] * wax[2]) * 0.7);
    if (checks.has("mount_gap")) {
      if (m.min === null && !nearest) {
        // Free-standing. pieces.json says it mounts on a wall: flag it, unless
        // it stands on the ground (a fence post) or hangs from another mounted
        // piece. A hint read from a pack's prose is not enough either.
        if (!textOnly && !standing && !chained) {
          issues.push({
            check: "mount_gap",
            severity: "warn",
            path: r.p,
            pos: v2(r.c),
            why: `no wall within 1 m behind or beside it (${metadata} mounts it on ${side})`,
            ev: { gap_m: ">1", mount_side: side, metadata },
            next: `summer_attach_to_surface ${r.p} backAxis=${side}`,
            score: 1,
            ...(frame ? { frame } : {}),
          });
        }
      } else if (m.gap !== null && m.min !== null) {
        // A wall IS behind the mount side, too far at the centre or a side.
        // (A wall only beside or in front of it is the orientation check's
        // finding.) The pack may document a standoff (ducts "about 0.1 m off
        // the wall"); a bracket that touches the wall may hold it off by design.
        const limit = m.standoff !== null ? Math.max(0.05, m.standoff + 0.05) : 0.05;
        if (m.gap > limit && !(chained && m.gap > 0.3) && !held.has(i)) {
          const wall = (m.at >= 0 ? inst[m.hitAt[m.at] ?? -1] : undefined) ?? (m.flipped && nearest ? inst[nearest.at] : undefined) ?? m.hit;
          const atSide = m.at > 0 && m.gap - m.min > 0.01 ? sampleSide(m.local, m.at) : null;
          // The largest gap opens onto a recessed window or door while another
          // sample is on the wall within the allowance: the recess is by design.
          const recess = wall?.r === "insert" && m.wallMin !== null && m.wallMin <= limit;
          issues.push({
            check: "mount_gap",
            severity: textOnly || recess || m.gap <= limit + 0.05 ? "look" : "warn",
            path: r.p,
            pos: v2(r.c),
            why: `stands ${cm(m.gap)} off ${wall?.p ?? "the wall"} on its mount side (${side})${atSide ? ` at its ${atSide} (closest ${cm(m.min)})` : ""}${recess ? `, a recessed window or door; ${cm(m.wallMin!)} from the wall itself` : ""}${m.flipped ? ", measured on the side facing the wall (front-back symmetric)" : ""}${m.standoff !== null ? `; the pack allows ${cm(m.standoff)} (${m.standoffSrc})` : ""}`,
            ev: {
              gap_m: r3(m.gap),
              mount_side: side,
              metadata,
              ...(wall ? { wall: wall.p } : {}),
              ...(atSide ? { at: atSide, min_m: r3(m.min) } : {}),
              ...(m.standoff !== null ? { standoff_m: r3(m.standoff) } : {}),
            },
            next: `summer_attach_to_surface ${r.p} backAxis=${side}`,
            score: m.gap,
            ...(frame ? { frame } : {}),
          });
        }
      }
    }
    // A front-back symmetric piece looks the same either way round: which
    // way its mount side points says nothing.
    if (checks.has("orientation") && nearest && nearest.dist <= 0.5 && !m.symmetric) {
      const angle = directionAngleDegrees(wax, nearest.dir);
      const behindOk = m.min !== null && m.min <= 0.1;
      if (angle > 45 && !behindOk) {
        issues.push({
          check: "orientation",
          severity: "look",
          path: r.p,
          pos: v2(r.c),
          why: `its mount side (${side}, ${metadata}) points ${Math.round(angle)} deg away from the nearest wall ${inst[nearest.at]?.p ?? ""} (${cm(Math.max(0, nearest.dist))} away)`,
          ev: { angle: Math.round(angle), mount_side: side, wall: inst[nearest.at]?.p ?? null, wall_dir: v2(nearest.dir), metadata },
          next: `summer_frame_nodes nodes=[${r.p}] direction=top; decide the facing yourself`,
          score: angle / 180,
          ...(frame ? { frame } : {}),
        });
      }
    }
  }
  return { issues, wallMounted };
}

// ---------------------------------------------------------------------------
// orientation: long props near a wall
// ---------------------------------------------------------------------------

export function judgeLongProps(rows: unknown[], inst: InstRow[]): AuditIssue[] {
  const out: AuditIssue[] = [];
  for (const raw of rows) {
    if (!Array.isArray(raw)) continue;
    const r = inst[num(raw[0], -1)];
    const best = arr(raw[4]);
    if (!r || best.length < 3) continue;
    const axis = vec(raw[1]);
    const len = num(raw[2]);
    const depth = num(raw[3]);
    const clearance = num(best[0]);
    const wall = inst[num(best[1], -1)];
    const normal = vec(best[2]);
    if (clearance > 1.2) continue;
    const angle = lineAngleDegrees(axis, wallDirection(normal));
    if (angle <= 15) continue;
    out.push({
      check: "orientation",
      severity: "look",
      path: r.p,
      pos: v2(r.c),
      why: `its long axis (${r2(len)} m) is ${Math.round(angle)} deg off the wall ${wall?.p ?? ""} ${clearance < 0 ? `it pokes ${cm(-clearance)} into` : `${cm(clearance)} away`}`,
      ev: { angle: Math.round(angle), clearance_m: r3(clearance), length_m: r2(len), depth_m: r2(depth), wall: wall?.p ?? null, long_axis: v2(axis) },
      next: `summer_frame_nodes nodes=[${r.p}] direction=top; decide the facing yourself`,
      score: angle / 90,
      ...(instFrame(r, r.c, (_d, k) => (k >= 8 ? 1 : 0.6)) ? { frame: instFrame(r, r.c, (_d, k) => (k >= 8 ? 1 : 0.6))! } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// uv_stretch
// ---------------------------------------------------------------------------

export const UV_STRETCH_LIMIT = 8;
export const UV_MIN_AREA = 0.02;

/** UVs of a triangle all within this distance sample one texel: a flat
 *  colour, never a visible stretch. */
export const UV_POINT_EPSILON = 0.002;

export function judgeUv(rows: unknown[], inst: InstRow[]): AuditIssue[] {
  const out: AuditIssue[] = [];
  for (const raw of rows) {
    const u = raw as Record<string, unknown> | null;
    if (!u || typeof u !== "object") continue;
    const tris = arr(u.tris).filter(Array.isArray) as unknown[][];
    const meshName = String(u.mesh ?? "its mesh").split("::")[0]!;
    const ratios: number[] = [];
    const areas: number[] = [];
    let bad = 0;
    tris.forEach((t, k) => {
      const p = [vec(t[0]), vec(t[1]), vec(t[2])] as const;
      const uv = [t[3], t[4], t[5]].map((x) => (Array.isArray(x) ? ([num(x[0]), num(x[1])] as Vec2) : ([0, 0] as Vec2)));
      const span = Math.max(Math.hypot(uv[0]![0] - uv[1]![0], uv[0]![1] - uv[1]![1]), Math.hypot(uv[1]![0] - uv[2]![0], uv[1]![1] - uv[2]![1]), Math.hypot(uv[0]![0] - uv[2]![0], uv[0]![1] - uv[2]![1]));
      const ratio = span < UV_POINT_EPSILON ? 1 : uvStretchRatio(p[0], p[1], p[2], uv[0]!, uv[1]!, uv[2]!);
      const area = triangleArea(p[0], p[1], p[2]);
      ratios.push(ratio);
      areas.push(area);
      if (ratio > UV_STRETCH_LIMIT && area >= UV_MIN_AREA) bad |= 1 << k;
    });
    if (!bad) continue;
    const users = num(u.users, 1);
    const entries = arr(u.shown).filter(Array.isArray) as unknown[][];
    const shown = entries.filter((s) => (num(s[1]) & bad) !== 0);
    if (!shown.length) continue;
    // A stretched face that inserts or mounted pieces cover in other
    // instances (a door, a shutter in front of it) is meant to be hidden:
    // where it shows, it is EXPOSED (warn). Otherwise it is the asset's own
    // mapping as it looks in normal use: one look item for the mesh.
    // Normal use covers a face when at least as many instances cover it as
    // show it (doors in 2 of 4 frames, shutters in the other 2).
    let normallyCovered = 0;
    for (let k = 0; k < tris.length; k++) {
      const covered = entries.filter((e) => num(e[4]) & (1 << k)).length;
      const visible = entries.filter((e) => num(e[1]) & (1 << k)).length;
      if (covered >= 1 && covered >= visible) normallyCovered |= 1 << k;
    }
    const exposedBits = bad & normallyCovered;
    const everywhere = bad & ~normallyCovered;
    const exposed = shown.filter((s) => (num(s[1]) & exposedBits) !== 0);
    const describe = (bits: number) => {
      let area = 0;
      let worst = 0;
      for (let k = 0; k < tris.length; k++) {
        if (!(bits & (1 << k))) continue;
        area += areas[k]!;
        worst = Math.max(worst, ratios[k]!);
      }
      return { area, worst, text: Number.isFinite(worst) ? `${Math.round(worst * 10) / 10}:1` : "UVs collapsed to a line" };
    };
    const emit = (list: unknown[][], bits: number, severity: Severity, why: (d: ReturnType<typeof describe>) => string) => {
      const first = list[0]!;
      const r = inst[num(first[0], -1)];
      if (!r) return;
      const d = describe(bits);
      const viewer = Array.isArray(first[2]) ? vec(first[2]) : undefined;
      const center = Array.isArray(first[3]) ? vec(first[3]) : r.c;
      out.push({
        check: "uv_stretch",
        severity,
        path: r.p,
        pos: v2(center),
        why: why(d),
        ev: {
          mesh: meshName,
          ratio: Number.isFinite(d.worst) ? r2(d.worst) : "line",
          area_m2: r2(d.area),
          shown_in: list.length,
          users,
          ...(list.length > 1 ? { more: list.slice(1, 3).map((s) => inst[num(s[0], -1)]?.p).filter(Boolean) } : {}),
        },
        next: `summer_zoom at ${fmt(center)}`,
        score: d.area,
        frame: { focus: center, size: 1.2, dirs: viewer ? [{ dir: normalize(sub(viewer, center)), clear: length(sub(viewer, center)) + 0.3, pref: 1 }] : [], ...(viewer ? { viewer } : {}) },
      });
    };
    if (exposed.length) {
      emit(exposed, exposedBits, "warn", (d) => `stretched texture (${d.text}) on ${r2(d.area)} m2 of ${meshName}, a face other instances cover: exposed in ${exposed.length} of ${users}`);
    }
    const plain = shown.filter((s) => (num(s[1]) & everywhere) !== 0);
    if (plain.length) {
      emit(plain, everywhere, "look", (d) => `stretched texture (${d.text}) on ${r2(d.area)} m2 of ${meshName} in ${plain.length}/${users} instance(s), not normally covered: the asset's own mapping`);
    }
  }
  // The asset's own mappings are one look item for the whole scene.
  const own = out.filter((i) => i.severity === "look");
  if (own.length < 2) return out;
  own.sort((a, b) => b.score - a.score);
  const first = own[0]!;
  const merged: AuditIssue = {
    ...first,
    why: `${own.length} meshes stretch their texture in normal use (the assets' own UV mapping): ${own.slice(0, 3).map((i) => String(i.ev.mesh)).join(", ")}${own.length > 3 ? ` +${own.length - 3}` : ""}`,
    ev: { meshes: own.length, area_m2: r2(own.reduce((sum, i) => sum + num(i.ev.area_m2), 0)), worst: first.ev.mesh, at: first.path },
    score: own.reduce((sum, i) => sum + i.score, 0),
  };
  return [...out.filter((i) => i.severity !== "look"), merged];
}

// ---------------------------------------------------------------------------
// duplicate / z_fight
// ---------------------------------------------------------------------------

export function judgeDuplicates(inst: InstRow[]): { issues: AuditIssue[]; pairs: Set<string> } {
  const issues: AuditIssue[] = [];
  const pairs = new Set<string>();
  const groups = new Map<string, number[]>();
  inst.forEach((r, i) => {
    if (!r.s) return;
    const key = `${r.s}|${Math.round(r.o[0] * 100)}|${Math.round(r.o[1] * 100)}|${Math.round(r.o[2] * 100)}`;
    const g = groups.get(key);
    if (g) g.push(i);
    else groups.set(key, [i]);
  });
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const ra = inst[list[a]!]!;
        const rb = inst[list[b]!]!;
        if (basisAngleDegrees(ra.b, rb.b) > 1) continue;
        if (Math.abs(ra.sc[0] - rb.sc[0]) > 0.01 || Math.abs(ra.sc[1] - rb.sc[1]) > 0.01 || Math.abs(ra.sc[2] - rb.sc[2]) > 0.01) continue;
        pairs.add(`${Math.min(list[a]!, list[b]!)}:${Math.max(list[a]!, list[b]!)}`);
        if (!ra.in && !rb.in) continue;
        issues.push({
          check: "duplicate",
          severity: "error",
          path: rb.p,
          pos: v2(rb.c),
          why: `a second ${rb.k} at the same transform as ${ra.p} (doubled geometry, z-fighting)`,
          ev: { other: ra.p, scene: rb.s },
          next: `summer_remove_node ${rb.p}`,
          score: 1,
          ...(instFrame(rb) ? { frame: instFrame(rb)! } : {}),
        });
      }
    }
  }
  return { issues, pairs };
}

export function judgeZFight(lines: unknown[], floors: Record<string, unknown> | undefined, inst: InstRow[], duplicatePairs: Set<string>, alreadyReported: ReadonlySet<string> = new Set()): AuditIssue[] {
  const rows: unknown[][] = [];
  for (const raw of lines) rows.push(...(parseLine(raw)?.zfight.filter(Array.isArray) as unknown[][] ?? []));
  rows.push(...(arr(floors?.zfight).filter(Array.isArray) as unknown[][]));
  const byPair = new Map<string, { a: number; b: number; count: number; p: Vec3; n: Vec3; lo: Vec3; hi: Vec3; clear: number }>();
  for (const row of rows) {
    const a = num(row[0], -1);
    const b = num(row[1], -1);
    const key = `${a}:${b}`;
    const lo = vec(row[5]);
    const hi = vec(row[6]);
    const prev = byPair.get(key);
    if (prev) {
      prev.count += num(row[2]);
      prev.lo = [Math.min(prev.lo[0], lo[0]), Math.min(prev.lo[1], lo[1]), Math.min(prev.lo[2], lo[2])];
      prev.hi = [Math.max(prev.hi[0], hi[0]), Math.max(prev.hi[1], hi[1]), Math.max(prev.hi[2], hi[2])];
    } else {
      byPair.set(key, { a, b, count: num(row[2]), p: vec(row[3]), n: vec(row[4]), lo, hi, clear: num(row[7], 0) });
    }
  }
  const out: AuditIssue[] = [];
  for (const [key, z] of byPair) {
    if (duplicatePairs.has(key) || alreadyReported.has(key)) continue;
    const ra = inst[z.a];
    const rb = inst[z.b];
    if (!ra || !rb || (!ra.in && !rb.in)) continue;
    const ext = sub(z.hi, z.lo);
    const center = scale(add(z.lo, z.hi), 0.5);
    const subject = ra.in ? ra : rb;
    const other = subject === ra ? rb : ra;
    out.push({
      check: "z_fight",
      severity: z.count >= 2 ? "warn" : "look",
      path: subject.p,
      pos: v2(center),
      why: `coplanar overlapping faces with ${other.p}: ${z.count} ray(s) see both within 3 mm (flicker)`,
      ev: { other: other.p, rays: z.count, extent_m: v2(ext), normal: v2(z.n), nudge: nudgeAxes(subject, z.n) },
      next: `summer_measure ${subject.p} vs ${other.p}; nudge it along world ${axisName(z.n)[1]} (the plane's normal; its local ${localAxisName(subject.b, z.n)[1]})`,
      score: z.count,
      frame: { focus: z.p, size: Math.max(1, length(ext)), dirs: z.clear > 0 ? [{ dir: normalize(z.n), clear: z.clear, pref: 1 }] : [] },
    });
  }
  return out;
}

/** "on one plane" / "3.2 mm apart". */
function gapText(gap: number): string {
  return gap < 0.00005 ? "on the same plane" : `${Math.round(gap * 10000) / 10} mm apart`;
}

const mm = (m: number) => Math.round(m * 10000) / 10;

/** Which way to nudge a z-fighting face: the plane's normal as a world axis
 *  and as the piece's own local axis (what summer_set_prop moves). */
export function nudgeAxes(subject: InstRow, normal: Vec3): { world: string; local: string } {
  return { world: axisName(normal), local: localAxisName(subject.b, normal) };
}

/**
 * z_fight from geometry: the kernel's planar face groups, compared between
 * instances (any role: props, roofs, ledges, side walls, ceilings, inserts
 * against hosts, decals and overlay cards) and within one mesh (two
 * surfaces on one plane). A pair counts when its plane gap is under twice
 * the 24-bit depth step at its view distance (the nearest walkable eye
 * point, camera or bookmark; 30 m without one) for the main camera's near
 * and far. Severity: warn over 0.05 m2 seen from a viewpoint; look
 * otherwise, and look (never skipped) when render_priority, a depth or
 * normal offset, or a decal or overlay name may make it intentional.
 * Returns the issues and the instance pairs they cover (the ray samples do
 * not report those again).
 */
export function judgeZFightGeometry(geo: Record<string, unknown> | undefined, inst: InstRow[], duplicatePairs: Set<string>): { issues: AuditIssue[]; pairs: Set<string> } {
  const issues: AuditIssue[] = [];
  const pairs = new Set<string>();
  if (!geo) return { issues, pairs };
  const near = num(geo.near, DEFAULT_NEAR);
  const far = num(geo.far, DEFAULT_FAR);
  const strings = (v: unknown) => arr(v).map((x) => String(x)).filter(Boolean);
  const grade = (area: number, seen: boolean, demoted: string[]): Severity => (demoted.length ? "look" : area > 0.05 && seen ? "warn" : "look");
  for (const raw of arr(geo.pairs)) {
    if (!Array.isArray(raw)) continue;
    const a = num(raw[0], -1);
    const b = num(raw[1], -1);
    const ra = inst[a];
    const rb = inst[b];
    if (!ra || !rb || (!ra.in && !rb.in)) continue;
    const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
    if (duplicatePairs.has(key)) continue;
    const area = num(raw[2]);
    const gap = num(raw[3]);
    const view = num(raw[6], TYPICAL_VIEW_M);
    const tol = zFightTolerance(view, near, far);
    if (gap > tol || area < 0.01) continue;
    pairs.add(key);
    const seen = raw[8] === true;
    const demoted = [...new Set([...strings(raw[9]), ...strings(raw[10])])];
    const subject = ra.in ? ra : rb;
    const other = subject === ra ? rb : ra;
    const centre = vec(raw[4]);
    const normal = vec(raw[5]);
    const opposite = raw[13] === true;
    const total = num(raw[14], area);
    const groups = num(raw[15], 1);
    const viewer = String(raw[7] ?? "");
    const sameNode = ra.p === rb.p;
    const otherName = sameNode ? `its own mesh ${String(subject === ra ? raw[17] : raw[16])}` : other.p;
    issues.push({
      check: "z_fight",
      severity: grade(total, seen, demoted),
      path: subject.p,
      pos: v2(centre),
      why: `coplanar overlapping faces with ${otherName}${opposite ? " (facing opposite ways, both double-sided)" : ""}: ${r2(total)} m2 ${gapText(gap)}, under ${mm(tol)} mm (2 depth steps at ${Math.round(view)} m from the ${viewer || "typical view"}); they flicker${demoted.length ? `. Look only: ${demoted.join("; ")}` : seen ? "" : ". Not seen from a viewpoint"}`,
      ev: {
        other: other.p,
        area_m2: r3(total),
        gap_mm: mm(gap),
        tol_mm: mm(tol),
        view_m: r2(view),
        viewer: viewer || "typical view distance",
        near,
        far,
        surfaces: [String(raw[11] ?? ""), String(raw[12] ?? "")],
        seen,
        normal: v2(normal),
        nudge: nudgeAxes(subject, normal),
        ...(groups > 1 ? { faces: groups } : {}),
        ...(demoted.length ? { demoted } : {}),
      },
      next: `summer_zoom at ${fmt(centre)}; move ${subject.p} more than ${mm(tol)} mm along world ${axisName(normal)[1]} (the shared plane's normal ${fmt(normal)}; its local ${localAxisName(subject.b, normal)[1]}), not along the facade, or remove the doubled face`,
      score: total,
      frame: { focus: centre, size: Math.max(1, Math.sqrt(total) * 2), dirs: [{ dir: normalize(normal), clear: Math.min(6, Math.max(1.5, view)), pref: 1 }] },
    });
  }
  for (const raw of arr(geo.in_mesh)) {
    if (!Array.isArray(raw)) continue;
    const shows = arr(raw[7]).map((x) => inst[num(x, -1)]).filter((r): r is InstRow => !!r);
    const first = shows[0];
    if (!first) continue;
    const area = num(raw[5]);
    const gap = num(raw[6]);
    const view = num(raw[11], TYPICAL_VIEW_M);
    const tol = zFightTolerance(view, near, far);
    if (gap > tol || area < 0.01) continue;
    const mesh = String(raw[0] ?? "its mesh").split("::")[0]!;
    const seen = raw[13] === true;
    const demoted = [...new Set([...strings(raw[14]), ...strings(raw[15])])];
    const surfaces = [String(raw[3] ?? `surface ${num(raw[1])}`), String(raw[4] ?? `surface ${num(raw[2])}`)];
    const centre = vec(raw[9]);
    const users = num(raw[8], shows.length);
    issues.push({
      check: "z_fight",
      severity: grade(area, seen, demoted),
      path: first.p,
      pos: v2(centre),
      why: `${mesh} has coplanar faces of two surfaces (${surfaces.join(" / ")})${raw[16] === true ? " facing opposite ways" : ""}: ${r2(area)} m2 ${gapText(gap)}, under ${mm(tol)} mm at ${Math.round(view)} m; in the asset itself, so every instance flickers (${shows.length} shown of ${users})${demoted.length ? `. Look only: ${demoted.join("; ")}` : ""}`,
      ev: { mesh, surfaces, area_m2: r3(area), gap_mm: mm(gap), tol_mm: mm(tol), view_m: r2(view), instances: shows.slice(0, 3).map((r) => r.p), users, seen, ...(demoted.length ? { demoted } : {}) },
      next: `summer_zoom at ${fmt(centre)}; summer_inspect_asset ${first.s || first.k} (the overlay surface needs an offset or render_priority)`,
      score: area,
      frame: { focus: centre, size: Math.max(1, Math.sqrt(area) * 2), dirs: [{ dir: normalize(vec(raw[10])), clear: Math.min(6, Math.max(1.5, view)), pref: 1 }] },
    });
  }
  return { issues, pairs };
}

// ---------------------------------------------------------------------------
// lights
// ---------------------------------------------------------------------------

export function judgeLights(lights: Record<string, unknown> | undefined, inst: InstRow[]): AuditIssue[] {
  if (!lights) return [];
  const out: AuditIssue[] = [];
  const renderer = String(lights.renderer ?? "");
  const limit = num(lights.limit, 8);
  const perObjectLimit = renderer === "gl_compatibility" || renderer === "mobile";
  if (perObjectLimit) {
    for (const raw of arr(lights.over)) {
      if (!Array.isArray(raw)) continue;
      const r = inst[num(raw[0], -1)];
      if (!r) continue;
      const omni = num(raw[2]);
      const spot = num(raw[3]);
      out.push({
        check: "lights",
        severity: "warn",
        path: r.p,
        pos: v2(r.c),
        why: `lit by ${omni} omni + ${spot} spot lights; ${renderer} keeps ${limit} of each per mesh, so light cuts off at its seams`,
        ev: { omni, spot, limit, mesh: String(raw[1] ?? ""), first: arr(raw[4]).map(String) },
        next: `split ${r.p} into smaller meshes or reduce overlapping light ranges`,
        score: Math.max(omni, spot) - limit,
        ...(instFrame(r) ? { frame: instFrame(r)! } : {}),
      });
    }
  }
  for (const raw of arr(lights.hard_rim)) {
    if (!Array.isArray(raw)) continue;
    const pos = vec(raw[2]);
    out.push({
      check: "lights",
      severity: "look",
      path: String(raw[0] ?? ""),
      pos: v2(pos),
      why: `spot_angle_attenuation ${raw[1]} < 3: a hard rim at the cone edge`,
      ev: { spot_angle_attenuation: num(raw[1]) },
      next: `summer_set_prop ${String(raw[0] ?? "")} spot_angle_attenuation (3 or more for a soft edge)`,
      score: 3 - num(raw[1]),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// transform
// ---------------------------------------------------------------------------

const PLACED_ROLES = new Set(["prop", "mount", "insert", "wall", "struct"]);

/**
 * Pieces left at the scene origin, never placed: the global origin within
 * 1 cm AND an identity LOCAL transform AND an identity parent, and not part
 * of a structured layout (touching another piece, or one of a row of
 * siblings along a line through the origin). A module placed so its corner is
 * the world origin, or one placed by its parent, is not flagged.
 */
export function unplacedAtOrigin(inst: readonly InstRow[]): Set<InstRow> {
  const out = new Set<InstRow>();
  const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");
  const siblings = new Map<string, InstRow[]>();
  for (const r of inst) {
    const k = parentOf(r.p);
    const list = siblings.get(k);
    if (list) list.push(r);
    else siblings.set(k, [r]);
  }
  for (const r of inst) {
    if (!r.in || !PLACED_ROLES.has(r.r) || length(r.o) >= 0.01 || r.li !== true || r.pi === false) continue;
    const touching = inst.some((o) => o !== r && o.r !== "underlay" && o.r !== "floor" && boundsTouch(r, o, 0.02) && length(sub(o.o, r.o)) >= 0.01);
    if (touching) continue;
    const sibs = (siblings.get(parentOf(r.p)) ?? []).filter((o) => o !== r && o.lo && length(o.lo) >= 0.01);
    // A row through the origin: two or more siblings whose local positions
    // are zero on two of three axes (a facade laid out from 0 along X).
    const row = sibs.filter((o) => o.lo!.filter((x) => Math.abs(x) < 0.01).length >= 2).length >= 2;
    if (row) continue;
    out.add(r);
  }
  return out;
}

export function judgeTransforms(inst: InstRow[]): AuditIssue[] {
  const out: AuditIssue[] = [];
  const bounded = inst.filter((r) => r.r !== "underlay" && !r.nan);
  const bounds = robustBounds(bounded.map((r) => r.c));
  const medianDist = median(bounded.map((r) => length(r.o)));
  const atOrigin = unplacedAtOrigin(inst);
  for (const r of inst) {
    if (!r.in) continue;
    const frame = instFrame(r);
    const push = (severity: Severity, why: string, ev: Record<string, unknown>, next: string, score: number) =>
      out.push({ check: "transform", severity, path: r.p, pos: v2(r.c), why, ev, next, score, ...(frame ? { frame } : {}) });
    if (r.nan) {
      push("error", "its transform contains NaN or infinity", {}, `summer_inspect_node ${r.p}`, 3);
      continue;
    }
    if (r.det < 0) push("warn", "negative scale: the piece is mirrored (normals and back-face culling flip)", { scale: v2(r.sc), det: r2(r.det) }, `summer_set_prop ${r.p} scale`, 1);
    const smin = Math.min(...r.sc);
    const smax = Math.max(...r.sc);
    if (smin > 0 && smax / smin > 1.01) push("look", `non-uniform scale ${v2(r.sc).join(" x ")}: textures and fitted openings stretch`, { scale: v2(r.sc) }, `summer_set_prop ${r.p} scale`, smax / smin - 1);
    if (atOrigin.has(r)) {
      const shared = atOrigin.size;
      if (shared >= 2) {
        push("warn", `${shared} pieces share the identity transform at the scene origin (local and parent transforms both identity, no neighbours): likely never placed`, { origin: v2(r.o), shared, others: [...atOrigin].filter((o) => o !== r).slice(0, 2).map((o) => o.p) }, `summer_inspect_node ${r.p}`, 1 + shared / 10);
      } else if (medianDist > 8) {
        push("look", "sits at the scene origin with an identity local transform under an identity parent, away from the rest of the scene and touching nothing: check that it was placed", { origin: v2(r.o), median_distance_m: r2(medianDist) }, `summer_inspect_node ${r.p}`, 0.5);
      }
    }
    const dist = length(sub(r.c, bounds.center));
    const extreme = Math.max(Math.abs(r.c[0]), Math.abs(r.c[1]), Math.abs(r.c[2]));
    if (extreme > 5000) push("error", `far out of bounds (${Math.round(extreme)} m from the origin)`, { center: v2(r.c) }, `summer_inspect_node ${r.p}`, 2);
    else if (bounded.length >= 8 && dist > bounds.limit) push("warn", `far out of bounds: ${Math.round(dist)} m from the scene's centre (95% of pieces are within ${Math.round(bounds.radius)} m)`, { distance_m: Math.round(dist), radius95_m: Math.round(bounds.radius) }, `summer_inspect_node ${r.p}`, dist / Math.max(1, bounds.limit));
  }
  return out;
}

// ---------------------------------------------------------------------------
// resource
// ---------------------------------------------------------------------------

export function judgeResources(res: Record<string, unknown> | undefined, inst: InstRow[]): AuditIssue[] {
  if (!res) return [];
  const out: AuditIssue[] = [];
  for (const raw of arr(res.missing)) {
    if (!Array.isArray(raw)) continue;
    const r = inst[num(raw[2], -1)];
    out.push({
      check: "resource",
      severity: "error",
      path: r?.p ?? ".",
      pos: v2(r?.c ?? [0, 0, 0]),
      why: `missing file ${String(raw[0])} (needed by ${String(raw[1])})`,
      ev: { missing: String(raw[0]), needed_by: String(raw[1]) },
      next: `summer_get_diagnostics; restore or re-import ${String(raw[0])}`,
      score: 3,
      ...(r && instFrame(r) ? { frame: instFrame(r)! } : {}),
    });
  }
  for (const raw of arr(res.empty)) {
    if (!Array.isArray(raw)) continue;
    out.push({
      check: "resource",
      severity: "warn",
      path: String(raw[0] ?? ""),
      pos: v2(inst[num(raw[1], -1)]?.c ?? [0, 0, 0]),
      why: "MeshInstance3D with no mesh (renders nothing)",
      ev: {},
      next: `summer_inspect_node ${String(raw[0] ?? "")}`,
      score: 1,
    });
  }
  for (const raw of arr(res.no_material)) {
    if (!Array.isArray(raw)) continue;
    const r = inst[num(raw[0], -1)];
    if (!r) continue;
    out.push({
      check: "resource",
      severity: "warn",
      path: r.p,
      pos: v2(r.c),
      why: `${num(raw[1])} surface(s) have no material (default grey)`,
      ev: { surfaces: num(raw[1]) },
      next: `summer_inspect_resource on ${r.p}'s mesh`,
      score: 1,
      ...(instFrame(r) ? { frame: instFrame(r)! } : {}),
    });
  }
  for (const raw of arr(res.shader_missing)) {
    if (!Array.isArray(raw)) continue;
    const r = inst[num(raw[0], -1)];
    out.push({
      check: "resource",
      severity: "warn",
      path: String(raw[1] ?? r?.p ?? ""),
      pos: v2(r?.c ?? [0, 0, 0]),
      why: `ShaderMaterial on surface ${num(raw[2])} has no shader`,
      ev: { surface: num(raw[2]) },
      next: `summer_inspect_node ${String(raw[1] ?? "")}`,
      score: 1,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Grouping: many identical findings in one group become one issue
// ---------------------------------------------------------------------------

/** Same check + severity + piece under the same parent: one issue that names
 *  the count and the range (16 gutter sections 5.4-5.9 cm off the wall). */
export function groupRepeats(issues: AuditIssue[], inst: InstRow[], min = 3): AuditIssue[] {
  const pieceOf = new Map(inst.map((r) => [r.p, r.k] as const));
  const keyOf = (i: AuditIssue) => `${i.check}|${i.severity}|${pieceOf.get(i.path) ?? i.path}`;
  const groups = new Map<string, AuditIssue[]>();
  for (const i of issues) {
    if (i.check !== "mount_gap" && i.check !== "orientation" && i.check !== "floating" && i.check !== "sunken" && i.check !== "exposed_edge" && i.check !== "depth_step") {
      groups.set(`${groups.size}#solo`, [i]);
      continue;
    }
    const k = keyOf(i);
    const g = groups.get(k);
    if (g) g.push(i);
    else groups.set(k, [i]);
  }
  const out: AuditIssue[] = [];
  for (const g of groups.values()) {
    if (g.length < min) {
      out.push(...g);
      continue;
    }
    const first = g.reduce((a, b) => (b.score > a.score ? b : a));
    const piece = pieceOf.get(first.path) ?? "pieces";
    const groupsOf = [...new Set(g.map((i) => (i.path.includes("/") ? i.path.slice(0, i.path.lastIndexOf("/")) : ".")))];
    const nums = g.map((i) => i.ev.gap_m ?? i.ev.angle ?? i.ev.embed_m ?? i.ev.reveal_m ?? i.ev.depth_m).filter((x): x is number => typeof x === "number");
    const range = nums.length && Math.min(...nums) !== Math.max(...nums) ? ` (${r3(Math.min(...nums))}..${r3(Math.max(...nums))})` : "";
    out.push({
      ...first,
      why: `${g.length} x ${piece}${range} in ${groupsOf.slice(0, 2).join(", ")}${groupsOf.length > 2 ? ` +${groupsOf.length - 2}` : ""}: ${first.why}`,
      ev: { ...first.ev, count: g.length, others: g.filter((i) => i !== first).slice(0, 2).map((i) => i.path) },
      score: first.score * Math.sqrt(g.length),
    });
  }
  return out;
}
