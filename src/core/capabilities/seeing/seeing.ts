/**
 * The seeing tools — ONE implementation for both faces (MCP: src/mcp/tools/
 * seeing-tools.ts; CLI: tool-dispatch.ts). Each operation validates its
 * arguments (ToolInputError: nothing sent), talks to the engine only through
 * read-only ops (ScenePreview, ListCameraBookmarks; SaveCameraBookmark when
 * the caller asked to save a pose), and returns either an inline image plus a
 * compact caption, or a structured failure. No silent fallbacks.
 *
 *   frameNodes  fit a pose to node bounds, render it with the REAL environment
 *   shotSheet   N bookmarks/poses in one labelled grid (compare_previous too)
 *   debugViews  one pose as beauty/lighting/unshaded/normals/overdraw/wireframe
 *   zoom        an exact sub-frustum of a region or of mark N, at full resolution
 *   frameShot   smart framing: candidates -> thick-sweep visibility -> score
 */
import { analyzeFrameBase64 } from "../frame-quality.js";
import { missingEngineOpResult, type CapabilityAdvertisingClient } from "../../capability-skew.js";
import { ToolInputError } from "../../tool-errors.js";
import { BOOKMARK_NAME_PATTERN, formatSceneMarks, readSceneMarks } from "../camera-view.js";
import { resolveCurrentScene } from "../project-context.js";
import {
  aabbCenter,
  add,
  DIRECTION_PRESETS,
  cropForAspect,
  fitDistance,
  formatVector3,
  mergeAabbs,
  normalize,
  parseVector3,
  roundVec,
  scale,
  type Aabb,
  type CameraPose,
  type DirectionPreset,
  type Vec3,
} from "./math.js";
import {
  chooseCorridorAxis,
  corridorBox,
  generateCandidates,
  SHOT_DEFAULTS,
  type Candidate,
  type CorridorRun,
  type ShotType,
  type SpawnInfo,
} from "./candidates.js";
import { pickTop, rejectionCounts, scoreMeasurement, type Measurement, type ScoredCandidate } from "./scoring.js";
import { makeProbeDir, runProbe, type ProbeClient, type ProbeRun } from "./probe.js";
import { SHOT_MAX_EDGE, ShotStore, ShotStoreError, type ShotWrite } from "./shot-store.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export const VIEW_MODES = ["beauty", "lighting", "unshaded", "normals", "overdraw", "wireframe"] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

export const SEEING_FALLBACK =
  'render explicit poses with summer_screenshot target:"scene" framing:"free" (camera_position + camera_look_at), one image per call';

export interface SeeingClient extends ProbeClient, CapabilityAdvertisingClient {
  getSceneState(scenePath?: string, options?: { depth?: number; limit?: number }): Promise<unknown>;
  getProjectRoot?(): string | undefined;
}

export interface SeeingImage {
  base64: string;
  mime: string;
  width?: number;
  height?: number;
}

export interface SeeingSuccess {
  ok: true;
  image: SeeingImage | null;
  /** Compact, model-facing text (labels, poses, scores, mark->path map). */
  caption: string;
  /** Structured receipt for the CLI face and tests. */
  receipt: Record<string, unknown>;
}

export interface SeeingFailure {
  ok: false;
  failure_reason: string;
  error: string;
  hint?: string;
  detail?: Record<string, unknown>;
}

export type SeeingResult = SeeingSuccess | SeeingFailure;

export interface PoseArgs {
  bookmark_name?: string;
  camera_position?: string;
  camera_look_at?: string;
  fov?: number;
}

export interface OccluderArgs {
  hard?: string[];
  soft?: string[];
  ignore?: string[];
  hard_layers?: number;
  soft_layers?: number;
}

const DEFAULT_ASPECT = 16 / 9;
const DEFAULT_SINGLE_EDGE = 1024;
const DEFAULT_SHEET_EDGE = 1536;
export const MAX_IMAGE_EDGE = 4096;
const TILE_GAP = 4;

// ---------------------------------------------------------------------------
// Argument validation (strict: these strings reach a scene file and the engine)
// ---------------------------------------------------------------------------

const SCENE_PATH_PATTERN = /^res:\/\/[A-Za-z0-9_\-./ ()+,@]{1,480}\.(tscn|scn)$/;
const NODE_PATH_PATTERN = /^(\.|[A-Za-z0-9_\- ]{1,128}(\/[A-Za-z0-9_\- ]{1,128}){0,31})$/;
const LABEL_PATTERN = /^[^\u0000-\u001f\u007f"'`\\$]{1,64}$/;

export function validateScenePath(path: string): string {
  const p = path.trim();
  if (!SCENE_PATH_PATTERN.test(p) || p.split("/").includes("..")) {
    throw new ToolInputError(
      `scenePath must be a res:// .tscn/.scn path of letters, digits and _ - . / ( ) + , @ or spaces, without ".." (got ${JSON.stringify(path).slice(0, 120)}). Nothing was sent.`
    );
  }
  return p;
}

export function validateNodePath(path: string, label: string): string {
  const p = path.trim();
  if (!NODE_PATH_PATTERN.test(p) || Buffer.byteLength(p, "utf8") > 256) {
    throw new ToolInputError(
      `${label} must be a node path relative to the scene root ("House1/Front") of letters, digits, _ - and spaces, at most 256 bytes (got ${JSON.stringify(path).slice(0, 120)}). Nothing was sent.`
    );
  }
  return p;
}

export function validateLabel(label: string): string {
  if (!LABEL_PATTERN.test(label)) {
    throw new ToolInputError(`label must be 1-64 printable characters without quotes, backslashes, backticks or "$" (got ${JSON.stringify(label).slice(0, 80)}). Nothing was sent.`);
  }
  return label;
}

export function validateBookmarkName(name: string, label = "bookmark_name"): string {
  const n = name.trim();
  if (!BOOKMARK_NAME_PATTERN.test(n)) {
    throw new ToolInputError(`${label} must be 1-64 characters from A-Z a-z 0-9 _ - (got ${JSON.stringify(name).slice(0, 80)}). Nothing was sent.`);
  }
  return n;
}

function validateFov(fov: number | undefined, label = "fov"): number | undefined {
  if (fov === undefined) return undefined;
  if (!Number.isFinite(fov) || fov < 1 || fov > 179) throw new ToolInputError(`${label} must be 1..179 degrees. Nothing was sent.`);
  return fov;
}

function validateEdge(edge: number | undefined, fallback: number): number {
  if (edge === undefined) return fallback;
  if (!Number.isInteger(edge) || edge < 64 || edge > MAX_IMAGE_EDGE) {
    throw new ToolInputError(`max_size must be an integer from 64 through ${MAX_IMAGE_EDGE} (longest edge in pixels). Nothing was sent.`);
  }
  return edge;
}

function validateAspect(aspect: number | undefined): number {
  if (aspect === undefined) return DEFAULT_ASPECT;
  if (!Number.isFinite(aspect) || aspect < 0.25 || aspect > 4) throw new ToolInputError("aspect must be a width/height ratio from 0.25 through 4 (16:9 = 1.7778). Nothing was sent.");
  return aspect;
}

function validateOccluders(occ: OccluderArgs | undefined): Record<string, unknown> {
  if (!occ) return {};
  const out: Record<string, unknown> = {};
  for (const key of ["hard", "soft", "ignore"] as const) {
    const list = occ[key];
    if (!list) continue;
    if (list.length > 32) throw new ToolInputError(`occluders.${key} takes at most 32 node paths. Nothing was sent.`);
    out[key] = list.map((p, i) => validateNodePath(p, `occluders.${key}[${i}]`));
  }
  for (const key of ["hard_layers", "soft_layers"] as const) {
    const v = occ[key];
    if (v === undefined) continue;
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new ToolInputError(`occluders.${key} must be a 32-bit physics layer mask. Nothing was sent.`);
    out[key] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(failure_reason: string, error: string, hint?: string, detail?: Record<string, unknown>): SeeingFailure {
  return { ok: false, failure_reason, error, ...(hint ? { hint } : {}), ...(detail ? { detail } : {}) };
}

function preflight(client: SeeingClient, ops: string[]): SeeingFailure | null {
  for (const op of ops) {
    const missing = missingEngineOpResult(client, op, SEEING_FALLBACK);
    if (missing) return fail(missing.failure_reason, missing.error, missing.hint, { op, engine_version: missing.engine_version });
  }
  return null;
}

async function resolveScene(client: SeeingClient, scenePath: string | undefined): Promise<string> {
  if (scenePath) return validateScenePath(scenePath);
  const current = resolveCurrentScene(undefined, await client.getSceneState(), undefined);
  if (!current) throw new ToolInputError("No scenePath given and no scene is open in the editor. Pass scenePath (\"res://...tscn\"). Nothing was sent.");
  return validateScenePath(current);
}

function firstResult(response: unknown): Record<string, unknown> {
  if (!response || typeof response !== "object") return {};
  const envelope = response as Record<string, unknown> & { results?: unknown[] };
  const first = Array.isArray(envelope.results) ? envelope.results[0] : undefined;
  return first && typeof first === "object" ? (first as Record<string, unknown>) : envelope;
}

export interface BookmarkInfo {
  pose: CameraPose;
  created?: string;
}

async function listBookmarks(client: SeeingClient): Promise<Record<string, BookmarkInfo> | SeeingFailure> {
  const response = firstResult(await client.executeOps([{ op: "ListCameraBookmarks" }]));
  if (response.ok === false) return fail(String(response.failure_reason ?? "bookmark_list_failed"), String(response.error ?? "ListCameraBookmarks failed"));
  const out: Record<string, BookmarkInfo> = {};
  const raw = (response.bookmarks ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, entry] of Object.entries(raw)) {
    try {
      out[name] = {
        pose: {
          position: parseVector3(String(entry.position), `bookmark ${name} position`),
          look_at: parseVector3(String(entry.look_at), `bookmark ${name} look_at`),
          fov: typeof entry.fov === "number" ? entry.fov : 60,
        },
        ...(typeof entry.created === "string" ? { created: entry.created } : {}),
      };
    } catch {
      // A malformed entry is reported when it is asked for by name.
    }
  }
  return out;
}

interface ResolvedPose {
  pose: CameraPose;
  bookmark?: string;
  created?: string;
}

function poseFromArgs(args: PoseArgs, label: string): ResolvedPose | { needsBookmark: string; fov?: number } {
  const fov = validateFov(args.fov, `${label} fov`);
  const bookmark = args.bookmark_name?.trim();
  if (bookmark) {
    if (args.camera_position || args.camera_look_at) {
      throw new ToolInputError(`${label}: bookmark_name takes its pose from the bookmark; drop camera_position/camera_look_at. Nothing was sent.`);
    }
    return { needsBookmark: validateBookmarkName(bookmark), ...(fov !== undefined ? { fov } : {}) };
  }
  if (!args.camera_position || !args.camera_look_at) {
    throw new ToolInputError(`${label} needs bookmark_name, or BOTH camera_position and camera_look_at as "Vector3(x, y, z)" literals. Nothing was sent.`);
  }
  const position = parseVector3(args.camera_position, `${label} camera_position`);
  const look_at = parseVector3(args.camera_look_at, `${label} camera_look_at`);
  if (position.every((v, i) => Math.abs(v - look_at[i]!) < 1e-6)) throw new ToolInputError(`${label}: camera_position and camera_look_at must differ. Nothing was sent.`);
  return { pose: { position, look_at, fov: fov ?? 60 } };
}

async function resolvePoses(client: SeeingClient, items: Array<{ args: PoseArgs; label: string }>): Promise<ResolvedPose[] | SeeingFailure> {
  const pending = items.map((item) => poseFromArgs(item.args, item.label));
  let bookmarks: Record<string, BookmarkInfo> | null = null;
  const out: ResolvedPose[] = [];
  for (const p of pending) {
    if ("pose" in p) {
      out.push(p);
      continue;
    }
    if (!bookmarks) {
      const listed = await listBookmarks(client);
      if ("ok" in listed && listed.ok === false) return listed as SeeingFailure;
      bookmarks = listed as Record<string, BookmarkInfo>;
    }
    const hit = bookmarks[p.needsBookmark];
    if (!hit) {
      const names = Object.keys(bookmarks).sort();
      return fail("unknown_bookmark", `No camera bookmark named "${p.needsBookmark}".`, names.length ? `Saved bookmarks: ${names.join(", ")}.` : 'No bookmarks are saved yet — summer_camera_bookmark action:"save", or summer_frame_nodes / summer_frame_shot with bookmark_name.');
    }
    out.push({ pose: { ...hit.pose, ...(p.fov !== undefined ? { fov: p.fov } : {}) }, bookmark: p.needsBookmark, ...(hit.created ? { created: hit.created } : {}) });
  }
  return out;
}

function poseLiteral(pose: CameraPose): string {
  return `position ${formatVector3(pose.position)}, look_at ${formatVector3(pose.look_at)}, fov ${Math.round(pose.fov * 10) / 10}`;
}

function poseRecord(pose: CameraPose): Record<string, unknown> {
  return { position: formatVector3(pose.position), look_at: formatVector3(pose.look_at), fov: Math.round(pose.fov * 100) / 100 };
}

function sizeFor(edge: number, aspect: number): [number, number] {
  const even = (n: number) => Math.max(16, Math.round(n / 2) * 2);
  return aspect >= 1 ? [even(edge), even(edge / aspect)] : [even(edge * aspect), even(edge)];
}

export interface GridLayout {
  cols: number;
  rows: number;
  tile: [number, number];
  canvas: [number, number];
  rects: Array<[number, number, number, number]>;
}

/** Same-size tiles in a grid whose longest edge is `maxEdge`. */
export function layoutGrid(count: number, aspect: number, maxEdge: number, forcedCols?: number): GridLayout {
  const cols = forcedCols ?? (count <= 3 ? count : count === 4 ? 2 : count <= 9 ? 3 : 4);
  const rows = Math.ceil(count / cols);
  // Width-limited first, then shrink if the grid is taller than wide.
  let tileW = Math.floor((maxEdge - TILE_GAP * (cols - 1)) / cols);
  let tileH = Math.round(tileW / aspect);
  const height = rows * tileH + TILE_GAP * (rows - 1);
  if (height > maxEdge) {
    tileH = Math.floor((maxEdge - TILE_GAP * (rows - 1)) / rows);
    tileW = Math.round(tileH * aspect);
  }
  tileW = Math.max(16, tileW - (tileW % 2));
  tileH = Math.max(16, tileH - (tileH % 2));
  const rects: Array<[number, number, number, number]> = [];
  for (let i = 0; i < count; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    rects.push([c * (tileW + TILE_GAP), r * (tileH + TILE_GAP), tileW, tileH]);
  }
  return {
    cols,
    rows,
    tile: [tileW, tileH],
    canvas: [cols * tileW + TILE_GAP * (cols - 1), rows * tileH + TILE_GAP * (rows - 1)],
    rects,
  };
}

function shotStore(client: SeeingClient): ShotStore | ShotStoreError {
  try {
    return ShotStore.forProject(typeof client.getProjectRoot === "function" ? client.getProjectRoot() : undefined);
  } catch (err) {
    return err instanceof ShotStoreError ? err : new ShotStoreError("no_project", String(err));
  }
}

function imageFrom(run: ProbeRun | { image?: SeeingImage }): SeeingImage | null {
  return run.image ? { ...run.image } : null;
}

function flatWarning(image: SeeingImage | null): string | null {
  if (!image) return null;
  const q = analyzeFrameBase64(image.base64, image.mime);
  return q.analyzable && q.flat ? "WARNING: the returned image is uniformly flat — nothing visible was rendered. Do not judge the scene from it; check the poses and summer_get_console." : null;
}

function capCaption(lines: string[], limit = 4800): string {
  let text = lines.filter(Boolean).join("\n");
  if (Buffer.byteLength(text, "utf8") > limit) text = `${text.slice(0, limit - 40)}\n... (caption truncated)`;
  return text;
}

interface SlotPlan {
  tile: number;
  bookmark: string;
  capturePath: string;
}

async function storeSlots(store: ShotStore | ShotStoreError, plans: SlotPlan[], run: ProbeRun): Promise<{ written: ShotWrite[]; notes: string[] }> {
  const written: ShotWrite[] = [];
  const notes: string[] = [];
  if (!plans.length) return { written, notes };
  if (store instanceof ShotStoreError) {
    notes.push(`before/after slots not kept: ${store.message}`);
    return { written, notes };
  }
  const captures = Array.isArray(run.result?.captures) ? (run.result!.captures as Array<{ i: number; path: string }>) : [];
  for (const plan of plans) {
    if (!captures.some((c) => c.i === plan.tile)) {
      notes.push(`slot for "${plan.bookmark}" not updated: the engine produced no capture for it`);
      continue;
    }
    try {
      written.push(await store.writeSlot(plan.bookmark, await readFile(plan.capturePath)));
    } catch (err) {
      notes.push(`slot for "${plan.bookmark}" not updated: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { written, notes };
}

async function saveCopy(store: ShotStore | ShotStoreError, name: string | undefined, image: SeeingImage | null): Promise<{ saved?: ShotWrite; note?: string }> {
  if (!name) return {};
  if (store instanceof ShotStoreError) return { note: `save_to skipped: ${store.message}` };
  if (!image) return { note: "save_to skipped: no image" };
  try {
    return { saved: await store.saveCopy(name, Buffer.from(image.base64, "base64")) };
  } catch (err) {
    return { note: `save_to failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function slotLines(written: ShotWrite[], notes: string[], saved?: ShotWrite, saveNote?: string): string[] {
  const lines: string[] = [];
  for (const w of written) lines.push(`kept as previous for the next compare: ${w.resPath} (${w.width}x${w.height}${w.evicted.length ? `; evicted ${w.evicted.join(", ")}` : ""})`);
  if (saved) lines.push(`saved copy: ${saved.resPath} (${saved.width}x${saved.height})`);
  for (const n of notes) lines.push(`NOTE: ${n}`);
  if (saveNote) lines.push(`NOTE: ${saveNote}`);
  return lines;
}

function checkSaveTo(saveTo: string | undefined, edge: number): string | undefined {
  if (saveTo === undefined) return undefined;
  const name = saveTo.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new ToolInputError("save_to must be 1-64 characters from A-Z a-z 0-9 _ - (a file name under res://.summer/shots/saved/). Nothing was sent.");
  if (edge > SHOT_MAX_EDGE) throw new ToolInputError(`save_to stores images up to ${SHOT_MAX_EDGE} px on the longest edge; pass max_size <= ${SHOT_MAX_EDGE} with save_to. Nothing was sent.`);
  return name;
}

function probeFailure(run: ProbeRun): SeeingFailure {
  const result = run.result ?? {};
  const missing = Array.isArray(result.missing) ? (result.missing as string[]) : undefined;
  return fail(
    run.failureReason ?? "probe_failed",
    run.error ?? "The engine could not run the seeing pass.",
    run.failureReason === "node_not_found"
      ? "Pass node paths relative to the scene root (summer_get_scene_tree shows them), e.g. \"House1\" or \"House1/Front\"."
      : run.failureReason === "game_running"
        ? "Offscreen renders are disabled while a game is running; stop it first (summer_stop) or capture the game with summer_screenshot target:\"game\"."
        : undefined,
    missing ? { missing } : undefined
  );
}

// ---------------------------------------------------------------------------
// Bounds (analyze pass shared by frameNodes and frameShot)
// ---------------------------------------------------------------------------

interface SubjectBounds {
  path: string;
  resolved: string;
  has_geometry: boolean;
  visuals: number;
  aabb: Aabb;
}

function readSubjects(result: Record<string, unknown>): SubjectBounds[] {
  const raw = Array.isArray(result.subjects) ? (result.subjects as Array<Record<string, unknown>>) : [];
  return raw.map((s) => {
    const box = s.aabb as { position: number[]; size: number[] };
    return {
      path: String(s.path),
      resolved: String(s.resolved),
      has_geometry: s.has_geometry === true,
      visuals: Number(s.visuals ?? 0),
      aabb: { position: box.position as unknown as Vec3, size: box.size as unknown as Vec3 },
    };
  });
}

function aabbLine(box: Aabb): string {
  const c = aabbCenter(box);
  return `center ${formatVector3(c)}, size ${formatVector3(box.size)}`;
}

// ---------------------------------------------------------------------------
// Native ScenePreview (fixed pose, real environment, marks)
// ---------------------------------------------------------------------------

interface NativeRender {
  ok: boolean;
  image?: SeeingImage;
  meta: Record<string, unknown>;
  failureReason?: string;
  error?: string;
}

async function nativeRender(
  client: SeeingClient,
  input: { scenePath: string; framing: string; pose?: CameraPose; fov?: number; size: [number, number]; marks?: boolean; maxMarks?: number }
): Promise<NativeRender> {
  const op: Record<string, unknown> = { op: "ScenePreview", scene_path: input.scenePath, framing: input.framing, size: input.size };
  if (input.pose) {
    op.camera_position = formatVector3(input.pose.position);
    op.camera_look_at = formatVector3(input.pose.look_at);
    op.fov = input.pose.fov;
  } else if (input.fov !== undefined) {
    op.fov = input.fov;
  }
  if (input.marks) op.marks = true;
  if (input.maxMarks !== undefined) op.max_marks = input.maxMarks;
  const r = firstResult(await client.executeOps([op]));
  const base64 = typeof r.image_base64 === "string" ? r.image_base64 : undefined;
  const meta = { ...r };
  delete meta.image_base64;
  if (r.ok === false || !base64) {
    return { ok: false, meta, failureReason: typeof r.failure_reason === "string" ? r.failure_reason : "preview_failed", error: typeof r.error === "string" ? r.error : "ScenePreview returned no image." };
  }
  const expected = input.framing.startsWith("bookmark:") ? input.framing : input.framing;
  if (typeof r.framing === "string" && r.framing !== expected) {
    return { ok: false, meta, failureReason: "framing_unsupported", error: `This engine resolved framing "${input.framing}" to "${r.framing}" (it predates fixed-pose framings), so the frame would not show the requested pose with the real environment.` };
  }
  return {
    ok: true,
    meta,
    image: { base64, mime: typeof r.mime === "string" ? r.mime : "image/jpeg", ...(typeof r.width === "number" ? { width: r.width } : {}), ...(typeof r.height === "number" ? { height: r.height } : {}) },
  };
}

/** Keep the native render of a bookmark as its before/after slot when it is
 *  clean (no marks) and within the stored-shot edge. Returns caption notes. */
export async function rememberBookmarkRender(
  projectRoot: string | undefined,
  bookmark: string,
  image: { base64: string; width?: number; height?: number },
  marks: boolean
): Promise<string[]> {
  if (marks) return [`NOTE: this render carries numbered marks, so it was not kept as "${bookmark}"'s previous image.`];
  const edge = Math.max(image.width ?? 0, image.height ?? 0);
  if (edge > SHOT_MAX_EDGE) return [`NOTE: renders larger than ${SHOT_MAX_EDGE} px are not kept as "${bookmark}"'s previous image (size it at most ${SHOT_MAX_EDGE} px to keep one).`];
  try {
    const store = ShotStore.forProject(projectRoot);
    const w = await store.writeSlot(bookmark, Buffer.from(image.base64, "base64"));
    return slotLines([w], []);
  } catch (err) {
    return [`NOTE: previous image for "${bookmark}" not kept: ${err instanceof Error ? err.message : String(err)}`];
  }
}

// ---------------------------------------------------------------------------
// frameNodes
// ---------------------------------------------------------------------------

export interface FrameNodesArgs {
  scenePath?: string;
  nodes: string[];
  direction?: DirectionPreset;
  from?: string;
  fill?: number;
  fov?: number;
  max_size?: number;
  aspect?: number;
  marks?: boolean;
  max_marks?: number;
  bookmark_name?: string;
}

export async function frameNodes(client: SeeingClient, args: FrameNodesArgs): Promise<SeeingResult> {
  if (!args.nodes?.length || args.nodes.length > 16) throw new ToolInputError("nodes must list 1-16 node paths. Nothing was sent.");
  const nodes = args.nodes.map((n, i) => validateNodePath(n, `nodes[${i}]`));
  if (args.direction && args.from) throw new ToolInputError('Pass either direction (a preset) or from ("Vector3(x, y, z)": direction from the subject toward the camera), not both. Nothing was sent.');
  const fromDir: Vec3 = args.from ? parseVector3(args.from, "from") : DIRECTION_PRESETS[args.direction ?? "iso"];
  if (Math.hypot(...fromDir) < 1e-6) throw new ToolInputError("from must be a non-zero direction. Nothing was sent.");
  const fill = args.fill ?? 0.8;
  if (!(fill >= 0.1 && fill <= 1.5)) throw new ToolInputError("fill must be 0.1..1.5 (share of the frame the nodes span). Nothing was sent.");
  const fov = validateFov(args.fov) ?? 50;
  const aspect = validateAspect(args.aspect);
  const edge = validateEdge(args.max_size, DEFAULT_SINGLE_EDGE);
  const bookmark = args.bookmark_name !== undefined ? validateBookmarkName(args.bookmark_name) : undefined;
  if (args.max_marks !== undefined && (!Number.isInteger(args.max_marks) || args.max_marks < 1 || args.max_marks > 128)) throw new ToolInputError("max_marks must be 1..128. Nothing was sent.");
  const scenePath = await resolveScene(client, args.scenePath);
  const blocked = preflight(client, bookmark ? ["ScenePreview", "SaveCameraBookmark"] : ["ScenePreview"]);
  if (blocked) return blocked;

  const run = await runProbe(client, { scenePath, size: [16, 16], config: { mode: "analyze", subjects: nodes, tasks: [] } });
  await run.dispose();
  if (!run.ok) return probeFailure(run);
  const subjects = readSubjects(run.result!);
  const empty = subjects.filter((s) => !s.has_geometry).map((s) => s.path);
  const box = mergeAabbs(subjects.map((s) => s.aabb));
  const center = aabbCenter(box);
  const toCamera = normalize(fromDir);
  const dist = fitDistance(box, center, toCamera, fov, aspect, fill);
  const pose: CameraPose = { position: roundVec(add(center, scale(toCamera, dist))), look_at: roundVec(center), fov };
  const size = sizeFor(edge, aspect);

  const lines: string[] = [];
  let framing = "free";
  if (bookmark) {
    const saved = firstResult(
      await client.executeOps([{ op: "SaveCameraBookmark", name: bookmark, position: formatVector3(pose.position), look_at: formatVector3(pose.look_at), fov }])
    );
    if (saved.ok === false) return fail(String(saved.failure_reason ?? "bookmark_save_failed"), String(saved.error ?? "SaveCameraBookmark failed"));
    framing = `bookmark:${bookmark}`;
    lines.push(`saved bookmark "${bookmark}"${saved.overwritten === true ? " (replaced the previous pose)" : ""} — reuse: summer_screenshot target:"scene" framing:"bookmark" bookmark_name:"${bookmark}", summer_shot_sheet, summer_debug_views.`);
  }
  const render = await nativeRender(client, { scenePath, framing, pose: bookmark ? undefined : pose, size, marks: args.marks, maxMarks: args.max_marks });
  if (!render.ok) return fail(render.failureReason ?? "preview_failed", render.error ?? "render failed");
  if (bookmark) lines.push(...(await rememberBookmarkRender(client.getProjectRoot?.(), bookmark, render.image!, args.marks === true)));
  const marks = readSceneMarks(render.meta);
  const env = String(render.meta.environment_used ?? "unknown");
  const header =
    `Framed ${nodes.join(", ")} in ${scenePath} with the REAL environment (${env}); ${render.image!.width ?? size[0]}x${render.image!.height ?? size[1]}. ` +
    `Pose: ${poseLiteral(pose)} (from ${args.from ? formatVector3(fromDir) : (args.direction ?? "iso")}, fill ${fill}).`;
  const caption = capCaption([
    header,
    `bounds: ${aabbLine(box)}`,
    empty.length ? `WARNING: no visible geometry under ${empty.join(", ")} — framed a 1 m box at its origin.` : "",
    ...lines,
    ...(marks ? formatSceneMarks(marks) : []),
    flatWarning(render.image!) ?? "",
    "Describe only what is visibly in the image.",
  ]);
  return {
    ok: true,
    image: render.image!,
    caption,
    receipt: { scenePath, nodes, pose: poseRecord(pose), bounds: { center: formatVector3(center), size: formatVector3(box.size) }, environment_used: env, ...(bookmark ? { bookmark } : {}), ...(marks ? { marks: marks.marks } : {}) },
  };
}

// ---------------------------------------------------------------------------
// Render tiles through the kernel
// ---------------------------------------------------------------------------

interface TileSpec {
  kind: "shot" | "prev" | "diff" | "note";
  rect: [number, number, number, number];
  label?: string;
  view?: ViewMode;
  pose?: Record<string, unknown>;
  render_size?: [number, number];
  capture_path?: string;
  capture_max_edge?: number;
  image_path?: string;
  now_tile?: number;
  text?: string;
}

function kernelPose(pose: CameraPose, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { position: [...pose.position], look_at: [...pose.look_at], fov: pose.fov, ...extra };
}

function slotRenderSize(aspect: number, tile: [number, number]): [number, number] {
  const slot = sizeFor(SHOT_MAX_EDGE, aspect);
  return tile[0] >= slot[0] ? tile : slot;
}

async function renderTiles(client: SeeingClient, scenePath: string, canvas: [number, number], tiles: TileSpec[], dir?: string): Promise<ProbeRun> {
  return runProbe(client, { scenePath, size: canvas, config: { mode: "render", canvas, tiles } }, dir);
}

function tileMethods(run: ProbeRun): string[] {
  const tiles = Array.isArray(run.result?.tiles) ? (run.result!.tiles as Array<Record<string, unknown>>) : [];
  return tiles.filter((t) => t.kind === "shot").map((t) => `${String(t.view)}=${String(t.method)}`);
}

// ---------------------------------------------------------------------------
// shotSheet
// ---------------------------------------------------------------------------

export interface ShotSheetShot extends PoseArgs {
  label?: string;
}

export interface ShotSheetArgs {
  scenePath?: string;
  shots: ShotSheetShot[];
  view?: ViewMode;
  compare_previous?: boolean;
  max_size?: number;
  aspect?: number;
  save_to?: string;
}

export async function shotSheet(client: SeeingClient, args: ShotSheetArgs): Promise<SeeingResult> {
  if (!args.shots?.length || args.shots.length > 12) throw new ToolInputError("shots must list 1-12 entries (bookmark_name, or camera_position + camera_look_at). Nothing was sent.");
  const labels = args.shots.map((s, i) => (s.label !== undefined ? validateLabel(s.label) : undefined) ?? s.bookmark_name?.trim() ?? `shot ${i + 1}`);
  const view = args.view ?? "beauty";
  const aspect = validateAspect(args.aspect);
  const edge = validateEdge(args.max_size, DEFAULT_SHEET_EDGE);
  const saveTo = checkSaveTo(args.save_to, edge);
  if (args.compare_previous && !args.shots.some((s) => s.bookmark_name)) {
    throw new ToolInputError("compare_previous compares a bookmark with its previous render; at least one shot needs bookmark_name. Nothing was sent.");
  }
  const scenePath = await resolveScene(client, args.scenePath);
  const blocked = preflight(client, ["ScenePreview", "ListCameraBookmarks"]);
  if (blocked) return blocked;
  const poses = await resolvePoses(client, args.shots.map((s, i) => ({ args: s, label: `shots[${i}]` })));
  if (!Array.isArray(poses)) return poses;
  const store = shotStore(client);

  // Rows: one tile per shot, or [previous | now | difference] per bookmark when comparing.
  type Cell = { kind: TileSpec["kind"]; shot: number; label: string; prevPath?: string; text?: string };
  const cells: Cell[] = [];
  const compareNotes: string[] = [];
  for (let i = 0; i < poses.length; i++) {
    const p = poses[i]!;
    const label = `${i + 1} ${labels[i]}${view !== "beauty" ? ` · ${view}` : ""}`;
    if (args.compare_previous && p.bookmark) {
      const prev = store instanceof ShotStoreError ? null : await store.readSlot(p.bookmark);
      if (prev) {
        // Bookmark timestamps have one-second resolution: a pose saved in the
        // same second as the previous render counts as possibly newer.
        if (p.created && Date.parse(p.created) >= Math.floor(prev.mtimeMs / 1000) * 1000) compareNotes.push(`"${p.bookmark}": the previous image may predate the bookmark's current pose (saved ${p.created}); the difference map may compare two different viewpoints.`);
        cells.push({ kind: "prev", shot: i, label: `${i + 1} ${labels[i]} · previous`, prevPath: prev.path });
        cells.push({ kind: "shot", shot: i, label: `${i + 1} ${labels[i]} · now` });
        cells.push({ kind: "diff", shot: i, label: `${i + 1} difference`, prevPath: prev.path });
      } else {
        cells.push({ kind: "note", shot: i, label: `${i + 1} ${labels[i]} · previous`, text: "no previous image yet — this render becomes the baseline" });
        cells.push({ kind: "shot", shot: i, label: `${i + 1} ${labels[i]} · now` });
        cells.push({ kind: "note", shot: i, label: `${i + 1} difference`, text: "nothing to compare" });
      }
    } else {
      cells.push({ kind: "shot", shot: i, label });
    }
  }
  const comparing = args.compare_previous === true;
  const layout = layoutGrid(cells.length, aspect, edge, comparing ? 3 : undefined);
  const run0Dir = await makeProbeDir();
  const tiles: TileSpec[] = [];
  const slots: SlotPlan[] = [];
  const nowTileOf = new Map<number, number>();
  cells.forEach((cell, index) => {
    const rect = layout.rects[index]!;
    const pose = poses[cell.shot]!;
    if (cell.kind === "shot") {
      const spec: TileSpec = { kind: "shot", rect, label: cell.label, view, pose: kernelPose(pose.pose) };
      if (pose.bookmark && view === "beauty" && !(store instanceof ShotStoreError)) {
        spec.render_size = slotRenderSize(aspect, layout.tile);
        spec.capture_path = join(run0Dir, `slot-${index}.jpg`).replace(/\\/g, "/");
        spec.capture_max_edge = SHOT_MAX_EDGE;
        slots.push({ tile: index, bookmark: pose.bookmark, capturePath: spec.capture_path });
      }
      nowTileOf.set(cell.shot, index);
      tiles.push(spec);
    } else if (cell.kind === "prev") {
      tiles.push({ kind: "prev", rect, label: cell.label, image_path: cell.prevPath!.replace(/\\/g, "/") });
    } else if (cell.kind === "diff") {
      tiles.push({ kind: "diff", rect, label: cell.label, image_path: cell.prevPath!.replace(/\\/g, "/"), now_tile: -1 });
    } else {
      tiles.push({ kind: "note", rect, label: cell.label, text: cell.text });
    }
  });
  cells.forEach((cell, index) => {
    if (cell.kind === "diff") tiles[index]!.now_tile = nowTileOf.get(cell.shot) ?? -1;
  });
  const run = await renderTiles(client, scenePath, layout.canvas, tiles, run0Dir);
  try {
    if (!run.ok) return probeFailure(run);
    const image = imageFrom(run);
    const { written, notes } = await storeSlots(store, slots, run);
    const { saved, note } = await saveCopy(store, saveTo, image);
    const diffs = Array.isArray(run.result?.diffs) ? (run.result!.diffs as Array<Record<string, unknown>>) : [];
    const lines = [
      `Shot sheet: ${poses.length} shot(s) of ${scenePath}, ${view} view${view === "beauty" ? " with the REAL environment and lights" : ""}, ${layout.cols}x${layout.rows} grid of ${layout.tile[0]}x${layout.tile[1]} tiles (${layout.canvas[0]}x${layout.canvas[1]}).`,
      ...poses.map((p, i) => `  ${i + 1} ${labels[i]}: ${poseLiteral(p.pose)}${p.bookmark ? ` [bookmark ${p.bookmark}]` : ""}`),
      ...diffs.map((d) => {
        const cell = cells[Number(d.i)];
        const box = Array.isArray(d.changed_box) ? ` in box u ${(d.changed_box as number[])[0]}-${(d.changed_box as number[])[2]}, v ${(d.changed_box as number[])[1]}-${(d.changed_box as number[])[3]}` : "";
        return `  difference ${cell ? cell.shot + 1 : "?"}: ${Math.round(Number(d.changed_fraction) * 1000) / 10}% of pixels changed visibly (mean abs ${d.mean_abs})${box}.`;
      }),
      ...compareNotes.map((n) => `NOTE: ${n}`),
      ...slotLines(written, notes, saved, note),
      flatWarning(image) ?? "",
      "Describe only what is visibly in the image.",
    ];
    return {
      ok: true,
      image,
      caption: capCaption(lines),
      receipt: {
        scenePath,
        view,
        layout: { cols: layout.cols, rows: layout.rows, tile: layout.tile, canvas: layout.canvas },
        shots: poses.map((p, i) => ({ label: labels[i], ...poseRecord(p.pose), ...(p.bookmark ? { bookmark: p.bookmark } : {}) })),
        ...(diffs.length ? { diffs } : {}),
        slots: written.map((w) => w.resPath),
        ...(saved ? { saved: saved.resPath } : {}),
        methods: tileMethods(run),
      },
    };
  } finally {
    await run.dispose();
  }
}

// ---------------------------------------------------------------------------
// debugViews
// ---------------------------------------------------------------------------

export interface DebugViewsArgs extends PoseArgs {
  scenePath?: string;
  views?: ViewMode[];
  max_size?: number;
  aspect?: number;
  save_to?: string;
}

export const VIEW_NOTES: Record<ViewMode, string> = {
  beauty: "final image: real environment, lights, fog, tonemap",
  lighting: "light only (albedo white): light direction, pools, shadow shape, dead-dark areas",
  unshaded: "albedo/texture only, no light: texture quality, colour balance, value grouping",
  normals: "world-space normals (x red, y green, z blue) from an unshaded override material: seams, flipped or faceted normals; normal maps and alpha cut-outs are NOT applied",
  overdraw: "additive overdraw: bright = many layers drawn on top of each other (foliage cards, decals, glass)",
  wireframe: "triangle density: over/under-tessellation, LOD, floating or duplicated geometry",
};

export async function debugViews(client: SeeingClient, args: DebugViewsArgs): Promise<SeeingResult> {
  const views = args.views?.length ? args.views : [...VIEW_MODES];
  if (views.length > 8) throw new ToolInputError("views takes at most 8 entries. Nothing was sent.");
  const aspect = validateAspect(args.aspect);
  const edge = validateEdge(args.max_size, DEFAULT_SHEET_EDGE);
  const saveTo = checkSaveTo(args.save_to, edge);
  const scenePath = await resolveScene(client, args.scenePath);
  const blocked = preflight(client, args.bookmark_name ? ["ScenePreview", "ListCameraBookmarks"] : ["ScenePreview"]);
  if (blocked) return blocked;
  const poses = await resolvePoses(client, [{ args, label: "pose" }]);
  if (!Array.isArray(poses)) return poses;
  const pose = poses[0]!;
  const store = shotStore(client);
  const layout = layoutGrid(views.length, aspect, edge);
  const dir = await makeProbeDir();
  const slots: SlotPlan[] = [];
  const tiles: TileSpec[] = views.map((view, i) => {
    const spec: TileSpec = { kind: "shot", rect: layout.rects[i]!, label: `${i + 1} ${view}`, view, pose: kernelPose(pose.pose) };
    if (view === "beauty" && pose.bookmark && !(store instanceof ShotStoreError)) {
      spec.render_size = slotRenderSize(aspect, layout.tile);
      spec.capture_path = join(dir, `slot-${i}.jpg`).replace(/\\/g, "/");
      spec.capture_max_edge = SHOT_MAX_EDGE;
      slots.push({ tile: i, bookmark: pose.bookmark, capturePath: spec.capture_path });
    }
    return spec;
  });
  const run = await renderTiles(client, scenePath, layout.canvas, tiles, dir);
  try {
    if (!run.ok) return probeFailure(run);
    const image = imageFrom(run);
    const { written, notes } = await storeSlots(store, slots, run);
    const { saved, note } = await saveCopy(store, saveTo, image);
    const renderer = String(run.result?.renderer ?? "unknown");
    const lines = [
      `Debug views of ${scenePath} from ${pose.bookmark ? `bookmark "${pose.bookmark}"` : "an explicit pose"} (${poseLiteral(pose.pose)}); renderer ${renderer}; ${layout.cols}x${layout.rows} grid of ${layout.tile[0]}x${layout.tile[1]}.`,
      ...views.map((v, i) => `  ${i + 1} ${v}: ${VIEW_NOTES[v]}`),
      `methods: ${tileMethods(run).join(", ")}`,
      ...slotLines(written, notes, saved, note),
      flatWarning(image) ?? "",
      "Describe only what is visibly in the image.",
    ];
    return {
      ok: true,
      image,
      caption: capCaption(lines),
      receipt: { scenePath, renderer, views, pose: poseRecord(pose.pose), ...(pose.bookmark ? { bookmark: pose.bookmark } : {}), methods: tileMethods(run), slots: written.map((w) => w.resPath), ...(saved ? { saved: saved.resPath } : {}) },
    };
  } finally {
    await run.dispose();
  }
}

// ---------------------------------------------------------------------------
// zoom
// ---------------------------------------------------------------------------

export interface ZoomArgs extends PoseArgs {
  scenePath?: string;
  /** [x, y, w, h]; length is checked at call time. */
  region?: number[];
  mark?: number;
  /** [width, height]; length is checked at call time. */
  reference_size?: number[];
  pad?: number;
  view?: ViewMode;
  max_size?: number;
  save_to?: string;
}

export async function zoom(client: SeeingClient, args: ZoomArgs): Promise<SeeingResult> {
  if ((args.region === undefined) === (args.mark === undefined)) {
    throw new ToolInputError("Pass exactly one of region ([x, y, w, h] as fractions 0..1 of the frame) or mark (a label number from a marks:true screenshot of the same pose). Nothing was sent.");
  }
  const reference = (args.reference_size ?? [1024, 576]) as [number, number];
  if (reference.length !== 2 || !reference.every((n) => Number.isInteger(n) && n >= 16 && n <= MAX_IMAGE_EDGE)) throw new ToolInputError("reference_size must be [width, height] in pixels (16..4096). Nothing was sent.");
  const refAspect = reference[0] / reference[1];
  const pad = args.pad ?? 0.15;
  if (!(pad >= 0 && pad <= 1)) throw new ToolInputError("pad must be 0..1 (fraction of the region added on each side). Nothing was sent.");
  const edge = validateEdge(args.max_size, DEFAULT_SINGLE_EDGE);
  const saveTo = checkSaveTo(args.save_to, edge);
  if (args.region) {
    if (args.region.length !== 4) throw new ToolInputError("region must be [x, y, w, h]. Nothing was sent.");
    const [x, y, w, h] = args.region as [number, number, number, number];
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > 1.0001 || y + h > 1.0001) {
      throw new ToolInputError("region must be [x, y, w, h] fractions of the frame (0..1, x+w and y+h at most 1). Nothing was sent.");
    }
  }
  if (args.mark !== undefined && (!Number.isInteger(args.mark) || args.mark < 1 || args.mark > 128)) throw new ToolInputError("mark must be a label number 1..128. Nothing was sent.");
  const scenePath = await resolveScene(client, args.scenePath);
  const blocked = preflight(client, args.bookmark_name ? ["ScenePreview", "ListCameraBookmarks"] : ["ScenePreview"]);
  if (blocked) return blocked;
  const poses = await resolvePoses(client, [{ args, label: "pose" }]);
  if (!Array.isArray(poses)) return poses;
  const pose = poses[0]!;
  let rect: { u0: number; v0: number; u1: number; v1: number };
  let markInfo = "";
  if (args.mark !== undefined) {
    const marked = await nativeRender(client, { scenePath, framing: "free", pose: pose.pose, size: reference, marks: true, maxMarks: 128 });
    if (!marked.ok) return fail(marked.failureReason ?? "preview_failed", marked.error ?? "marks render failed");
    const summary = readSceneMarks(marked.meta);
    if (!summary) return fail("marks_unsupported", "This engine build ignored marks:true, so mark numbers cannot be resolved; pass region instead.");
    const hit = summary.marks.find((m) => m.id === args.mark);
    if (!hit || !hit.screen_rect) {
      return fail("mark_not_found", `No mark ${args.mark} at this pose and reference_size ${reference[0]}x${reference[1]}.`, `Marks here: ${summary.marks.slice(0, 20).map((m) => `${m.id}=${m.path}`).join(", ") || "none"}. Use the SAME pose and size as the marks screenshot.`);
    }
    const r = hit.screen_rect;
    rect = { u0: r.x / reference[0], v0: r.y / reference[1], u1: (r.x + r.w) / reference[0], v1: (r.y + r.h) / reference[1] };
    markInfo = `mark ${hit.id} -> ${hit.path} (${hit.class})`;
  } else {
    const [x, y, w, h] = args.region as [number, number, number, number];
    rect = { u0: x, v0: y, u1: x + w, v1: y + h };
  }
  const crop = cropForAspect(rect, refAspect, refAspect, pad);
  const zoomFactor = 1 / (crop[2] - crop[0]);
  const size = sizeFor(edge, refAspect);
  const view = args.view ?? "beauty";
  const tiles: TileSpec[] = [
    { kind: "shot", rect: [0, 0, size[0], size[1]], view, pose: kernelPose(pose.pose, { crop, ref_aspect: refAspect }), label: `zoom x${zoomFactor.toFixed(1)}${markInfo ? ` · mark ${args.mark}` : ""}` },
  ];
  const run = await renderTiles(client, scenePath, size, tiles);
  try {
    if (!run.ok) return probeFailure(run);
    const image = imageFrom(run);
    const store = saveTo ? shotStore(client) : null;
    const { saved, note } = store ? await saveCopy(store, saveTo, image) : {};
    const r3 = (n: number) => Math.round(n * 1000) / 1000;
    const lines = [
      `Zoom x${zoomFactor.toFixed(1)} of ${scenePath} (${view}): an exact sub-frustum rendered at ${size[0]}x${size[1]} — real detail, not upscaled pixels.`,
      `from ${pose.bookmark ? `bookmark "${pose.bookmark}"` : "pose"}: ${poseLiteral(pose.pose)}`,
      `region of the ${reference[0]}x${reference[1]} frame: u ${r3(crop[0])}-${r3(crop[2])}, v ${r3(crop[1])}-${r3(crop[3])}${markInfo ? ` (${markInfo}, padded ${pad})` : ""}`,
      ...slotLines([], [], saved, note),
      flatWarning(image) ?? "",
      "Describe only what is visibly in the image.",
    ];
    return {
      ok: true,
      image,
      caption: capCaption(lines),
      receipt: { scenePath, view, pose: poseRecord(pose.pose), crop: crop.map(r3), zoom: Math.round(zoomFactor * 100) / 100, ...(markInfo ? { mark: markInfo } : {}), ...(saved ? { saved: saved.resPath } : {}) },
    };
  } finally {
    await run.dispose();
  }
}

// ---------------------------------------------------------------------------
// frameShot (smart framing)
// ---------------------------------------------------------------------------

export interface FrameShotArgs {
  scenePath?: string;
  shot: ShotType;
  subject?: string[];
  spawn?: string;
  eye_height?: number;
  fov?: number;
  aspect?: number;
  occluders?: OccluderArgs;
  max_soft_fraction?: number;
  bookmark_name?: string;
  save_bookmark?: boolean;
  render?: "sheet" | "best" | "none";
  max_size?: number;
}

const GRID_COLS = 24;

function defaultBookmarkName(shot: ShotType, subject: string[] | undefined, spawn: string | undefined): string {
  const leaf = (subject?.[0] ?? spawn ?? "scene").split("/").pop() ?? "scene";
  return `${shot}_${leaf}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

export async function frameShot(client: SeeingClient, args: FrameShotArgs): Promise<SeeingResult> {
  const shot = args.shot;
  const subject = args.subject?.map((p, i) => validateNodePath(p, `subject[${i}]`));
  if (subject && subject.length > 8) throw new ToolInputError("subject takes at most 8 node paths. Nothing was sent.");
  const spawn = args.spawn !== undefined ? validateNodePath(args.spawn, "spawn") : undefined;
  if (shot === "eye_level" && !spawn) throw new ToolInputError('shot "eye_level" needs spawn: the node the player stands at (its Camera3D child, or origin + eye_height, is the eye). Nothing was sent.');
  if (shot !== "eye_level" && !subject?.length) throw new ToolInputError(`shot "${shot}" needs subject: 1-8 node paths to frame. Nothing was sent.`);
  if (args.eye_height !== undefined && !(args.eye_height > 0 && args.eye_height < 20)) throw new ToolInputError("eye_height must be 0..20 m. Nothing was sent.");
  const fov = validateFov(args.fov);
  const aspect = validateAspect(args.aspect);
  const occluders = validateOccluders(args.occluders);
  const maxSoft = args.max_soft_fraction ?? 0.67;
  if (!(maxSoft >= 0 && maxSoft <= 1)) throw new ToolInputError("max_soft_fraction must be 0..1. Nothing was sent.");
  const saveBookmark = args.save_bookmark ?? true;
  const bookmark = saveBookmark ? validateBookmarkName(args.bookmark_name ?? defaultBookmarkName(shot, subject, spawn)) : undefined;
  const render = args.render ?? "sheet";
  const edge = validateEdge(args.max_size, render === "sheet" ? DEFAULT_SHEET_EDGE : DEFAULT_SINGLE_EDGE);
  const scenePath = await resolveScene(client, args.scenePath);
  const blocked = preflight(client, saveBookmark ? ["ScenePreview", "SaveCameraBookmark"] : ["ScenePreview"]);
  if (blocked) return blocked;
  const gridRows = Math.max(4, Math.round(GRID_COLS / aspect));

  const timings: Record<string, number> = {};
  const timed = async <T,>(key: string, work: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try {
      return await work();
    } finally {
      timings[key] = Date.now() - t0;
    }
  };
  // Pass 1: bounds, spawn, and for corridors the free-run scan.
  const ignore = [...((occluders.ignore as string[] | undefined) ?? []), ...(spawn ? [spawn] : [])];
  const occ = { ...occluders, ignore, subject_occludes: shot === "corridor" };
  const pass1 = await timed("bounds_ms", () => runProbe(client, {
    scenePath,
    size: [16, 16],
    config: {
      mode: "analyze",
      subjects: subject ?? [],
      ...(spawn ? { spawn } : {}),
      tasks: shot === "corridor" ? ["corridor_scan"] : [],
      occluders: occ,
      corridor: { height: args.eye_height ?? 1.6 },
    },
  }));
  await pass1.dispose();
  if (!pass1.ok) return probeFailure(pass1);
  const bounds = readSubjects(pass1.result!);
  const subjectBox = bounds.length ? mergeAabbs(bounds.map((b) => b.aabb)) : undefined;
  const spawnInfo = pass1.result!.spawn as SpawnInfo | undefined;
  let corridorAxes: ReturnType<typeof chooseCorridorAxis> = [];
  if (shot === "corridor") {
    const scan = pass1.result!.corridor_scan as { runs?: CorridorRun[] } | undefined;
    corridorAxes = chooseCorridorAxis(scan?.runs ?? [], subjectBox!);
    if (!corridorAxes.length) {
      return fail("no_corridor_found", `No walkable corridor line was found inside ${subject!.join(", ")}: every free run from the scan seeds was shorter than 4 m or narrower than 1 m.`, "Check the subject is the corridor/alley node itself, or frame it with summer_frame_nodes instead.");
    }
  }
  const groundY = subjectBox ? subjectBox.position[1] : undefined;
  const candidates: Candidate[] = generateCandidates({
    shot,
    ...(subjectBox ? { subject: subjectBox } : {}),
    ...(spawnInfo ? { spawn: spawnInfo } : {}),
    ...(corridorAxes[0] ? { corridor: corridorAxes[0] } : {}),
    aspect,
    ...(fov !== undefined ? { fov } : {}),
    ...(args.eye_height !== undefined ? { eyeHeight: args.eye_height } : {}),
    ...(groundY !== undefined ? { groundY } : {}),
  });

  // Pass 2: what each candidate would see.
  const pass2 = await timed("measure_ms", () => runProbe(client, {
    scenePath,
    size: [16, 16],
    config: {
      mode: "analyze",
      subjects: subject ?? [],
      tasks: ["measure"],
      occluders: occ,
      candidates: candidates.map((c) => ({ position: [...c.position], look_at: [...c.look_at], fov: c.fov, samples: c.samples.map((s) => [...s]), min_clearance: c.min_clearance, low_angle_rule: c.low_angle_rule })),
      measure: { aspect, grid_cols: GRID_COLS, grid_rows: gridRows, subject_occludes: shot === "corridor", near_lens_radius: 0.3, sweep_radius: 0.15 },
      // A 4x4-pixel-per-cell beauty render per candidate, for the featureless
      // area and near/far value checks.
      image_check: { size: [GRID_COLS * 4, gridRows * 4] },
    },
  }));
  await pass2.dispose();
  if (!pass2.ok) return probeFailure(pass2);
  const measurements = (pass2.result!.measurements ?? []) as Measurement[];
  const scoringSubject = shot === "corridor" ? corridorBox(corridorAxes[0]!, groundY ?? 0) : subjectBox;
  const scored: ScoredCandidate[] = measurements.map((m) =>
    scoreMeasurement(m, candidates[m.i]!, {
      shot,
      aspect,
      gridCols: GRID_COLS,
      gridRows,
      ...(scoringSubject ? { subject: scoringSubject } : {}),
      maxHardFraction: 0.34,
      maxSoftFraction: maxSoft,
    })
  );
  const separation = subjectBox ? Math.max(1, Math.hypot(...subjectBox.size) * 0.12) : 1;
  const top = pickTop(scored, 3, separation);
  const rejected = rejectionCounts(scored);
  const occSummary = (pass2.result!.occluders ?? {}) as Record<string, unknown>;
  if (!top.length) {
    return fail(
      "no_usable_pose",
      `All ${scored.length} candidate poses for a ${shot} shot were rejected.`,
      "Loosen occluders (move blocking props to occluders.soft or occluders.ignore), raise max_soft_fraction, or pick a different subject/spawn.",
      { rejected, occluders: occSummary.counts }
    );
  }

  const lines: string[] = [];
  const best = top[0]!;
  if (bookmark) {
    const saved = firstResult(
      await client.executeOps([{ op: "SaveCameraBookmark", name: bookmark, position: formatVector3(best.pose.position), look_at: formatVector3(best.pose.look_at), fov: Math.round(best.pose.fov * 100) / 100 }])
    );
    if (saved.ok === false) return fail(String(saved.failure_reason ?? "bookmark_save_failed"), String(saved.error ?? "SaveCameraBookmark failed"));
    lines.push(`saved best as bookmark "${bookmark}"${saved.overwritten === true ? " (replaced its previous pose)" : ""}.`);
  }

  let image: SeeingImage | null = null;
  let slotText: string[] = [];
  if (render !== "none") {
    const shown = render === "best" ? [best] : top;
    const layout = layoutGrid(shown.length, aspect, edge);
    const store = shotStore(client);
    const dir = await makeProbeDir();
    const slots: SlotPlan[] = [];
    const tiles: TileSpec[] = shown.map((s, i) => {
      const spec: TileSpec = { kind: "shot", rect: layout.rects[i]!, view: "beauty", label: `${i + 1} ${shot} ${s.total.toFixed(2)}`, pose: kernelPose(s.pose) };
      if (i === 0 && bookmark && !(store instanceof ShotStoreError)) {
        spec.render_size = slotRenderSize(aspect, layout.tile);
        spec.capture_path = join(dir, "slot-0.jpg").replace(/\\/g, "/");
        spec.capture_max_edge = SHOT_MAX_EDGE;
        slots.push({ tile: 0, bookmark, capturePath: spec.capture_path });
      }
      return spec;
    });
    const run = await timed("render_ms", () => renderTiles(client, scenePath, layout.canvas, tiles, dir));
    try {
      if (!run.ok) return probeFailure(run);
      image = imageFrom(run);
      const { written, notes } = await storeSlots(store, slots, run);
      slotText = slotLines(written, notes);
      const flat = flatWarning(image);
      if (flat) slotText.push(flat);
    } finally {
      await run.dispose();
    }
  }

  const counts = (occSummary.counts ?? {}) as Record<string, number>;
  const byRule = (occSummary.by_rule ?? {}) as Record<string, number>;
  const header = [
    `Smart framing: ${shot} of ${subject?.join(", ") ?? `the view from ${spawn}`} in ${scenePath}. ${scored.length} candidates measured in-engine, ${scored.length - Object.values(rejected).reduce((a, b) => a + b, 0)} usable${Object.keys(rejected).length ? `; rejected ${Object.entries(rejected).map(([k, v]) => `${k} ${v}`).join(", ")}` : ""}.`,
    subjectBox ? `subject bounds: ${aabbLine(subjectBox)}` : "",
    shot === "corridor" ? `corridor axis: dir ${formatVector3(corridorAxes[0]!.dir)}, free ${(corridorAxes[0]!.usableFwd + corridorAxes[0]!.usableBack).toFixed(1)} m, width ${corridorAxes[0]!.width.toFixed(1)} m` : "",
    spawnInfo ? `eye: ${spawnInfo.camera && args.eye_height === undefined ? `${spawnInfo.camera.path} at ${formatVector3(spawnInfo.camera.position)}` : `${spawnInfo.path} origin + ${args.eye_height ?? 1.6} m`}` : "",
    `occluders: hard ${counts.hard ?? 0}, soft ${counts.soft ?? 0}, subject ${counts.subject ?? 0}, ignored ${counts.ignored ?? 0} (by rule: ${Object.entries(byRule).map(([k, v]) => `${k} ${v}`).join(", ")})`,
  ];
  const topLines = top.map((s, i) => {
    const t = s.terms;
    const termText = Object.entries(t).map(([k, v]) => `${k} ${v}`).join(" ");
    const adj = s.adjustments?.length ? ` adjusted: ${s.adjustments.map((a) => String(a.kind)).join("+")}` : "";
    const occl = s.blockers?.soft?.length ? ` framed by ${s.blockers.soft.slice(0, 2).join(", ")}` : "";
    const img = s.stats?.flat !== undefined ? ` flat ${s.stats.flat}` : "";
    return `${i + 1}. score ${s.total.toFixed(2)} [${s.id}] ${poseLiteral(s.pose)}\n   ${termText}; sky ${s.stats?.sky} fg ${s.stats?.foreground} wall-behind ${s.stats?.wallBehind}${img}${s.fill !== undefined ? ` fill ${s.fill}` : ""}${adj}${occl}`;
  });
  const ranked = scored.filter((x) => !x.rejected).sort((a, b) => b.total - a.total);
  const spawnForward = scored.find((x) => x.id === "eye_spawn_forward");
  if (spawnForward) {
    const rank = ranked.indexOf(spawnForward) + 1;
    header.push(`the spawn's own forward view: ${spawnForward.rejected ? `rejected (${spawnForward.rejected})` : `score ${spawnForward.total.toFixed(2)}, rank ${rank} of ${ranked.length}`} — ${poseLiteral(spawnForward.pose)}`);
  }
  header.push(`engine time: ${Object.entries(timings).map(([k, v]) => `${k.replace(/_ms$/, "")} ${(v / 1000).toFixed(1)} s`).join(", ")}`);
  const caption = capCaption([
    ...header,
    "top poses (tile order in the image):",
    ...topLines,
    ...lines,
    ...slotText,
    render === "none" ? "No image rendered (render:\"none\"). Render with summer_shot_sheet." : "Describe only what is visibly in the image.",
  ]);
  return {
    ok: true,
    image,
    caption,
    receipt: {
      scenePath,
      shot,
      candidates: scored.length,
      rejected,
      occluders: { counts, by_rule: byRule, examples: occSummary.examples },
      top: top.map((s) => ({ id: s.id, score: s.total, terms: s.terms, stats: s.stats, ...poseRecord(s.pose), ...(s.adjustments ? { adjustments: s.adjustments } : {}), ...(s.blockers ? { blockers: s.blockers } : {}) })),
      ...(bookmark ? { bookmark } : {}),
      ...(shot === "corridor" ? { corridor: corridorAxes[0] } : {}),
      timings,
      table: scored.map((s) => ({ id: s.id, total: s.total, ...(s.rejected ? { rejected: s.rejected } : {}), terms: s.terms })),
    },
  };
}

export const SHOT_TYPE_DEFAULTS = SHOT_DEFAULTS;
