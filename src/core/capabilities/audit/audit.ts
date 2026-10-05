/**
 * summer_scene_audit — ONE implementation for both faces (MCP:
 * src/mcp/tools/audit-tools.ts; CLI: `summer tool scene-audit`).
 *
 * One fast, read-only pass over every node of a 3D scene that reports likely
 * visual and placement problems, so a build agent knows exactly where to look.
 *
 * How (no new engine op): the seeing tools' private-copy path. A throwaway
 * wrapper scene in a private OS temp directory instances the SAVED scene and
 * carries the audit kernel (assets/audit/scene_audit.gd) as a built-in @tool
 * script; the existing ScenePreview op instantiates it in an offscreen
 * SubViewport with its own World3D. The kernel works on that copy: the open
 * tab, its unsaved state, its undo history and every project file stay
 * untouched (RunSceneScript would mark the tab unsaved after every run).
 *
 * The kernel measures (capped ray grids and probes against a physics space
 * built from the visible meshes, shapes cached per mesh resource); judge.ts
 * decides; summary.ts pages the result under 5 KB. render:"sheet" renders the
 * first 6 issues of the page through the seeing kernel in one more call.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT } from "../../package-root.js";
import { missingEngineOpResult, type CapabilityAdvertisingClient } from "../../capability-skew.js";
import { ToolInputError } from "../../tool-errors.js";
import { resolveCurrentScene } from "../project-context.js";
import { layoutGrid, validateNodePath, validateScenePath, type SeeingImage } from "../seeing/seeing.js";
import { runProbe, type ProbeClient } from "../seeing/probe.js";
import {
  AUDIT_CHECKS,
  AUDIT_DEFAULT_BUDGET_MS,
  AUDIT_DEFAULT_LIMIT,
  AUDIT_MAX_ACCEPT,
  AUDIT_MAX_BUDGET_MS,
  AUDIT_MAX_LIMIT,
  AUDIT_MAX_MANIFESTS,
  AUDIT_MIN_BUDGET_MS,
  type AuditCheck,
  type SceneAuditArgs,
  type Severity,
} from "./args.js";
import { AcceptStoreError, applyAccepts, mergeAccepts, parseAcceptFile, validIssueKey, writeAcceptFile } from "./accept.js";
import { judgeGaps } from "./gaps.js";
import {
  groupRepeats,
  judgeDuplicates,
  judgeFloorGaps,
  judgeInserts,
  judgeLights,
  judgeLongProps,
  judgeMounts,
  judgeOverlaps,
  judgeResources,
  judgeSupport,
  judgeThroughHoles,
  judgeTransforms,
  judgeUv,
  judgeZFight,
  judgeZFightGeometry,
  parsePackGrounds,
  type AuditIssue,
  type InstRow,
  type KernelResult,
} from "./judge.js";
import { buildPage, countIssues, filterIssues, partialChecks, sortIssues, timingPerCheck } from "./summary.js";
import { choosePose, SHEET_TILES } from "./frame.js";

export const AUDIT_KERNEL_PATH = join(PACKAGE_ROOT, "assets", "audit", "scene_audit.gd");
let kernelCache: string | null = null;

export function loadAuditKernel(): string {
  if (kernelCache === null) kernelCache = readFileSync(AUDIT_KERNEL_PATH, "utf-8");
  return kernelCache;
}

export const AUDIT_FALLBACK =
  "read the scene with summer_world_snapshot and look with summer_frame_nodes / summer_shot_sheet; cast single rays with summer_raycast";

export interface AuditClient extends ProbeClient, CapabilityAdvertisingClient {
  getSceneState(scenePath?: string, options?: { depth?: number; limit?: number }): Promise<unknown>;
  getProjectRoot?(): string | undefined;
}

export interface AuditSuccess {
  ok: true;
  /** The page: at most 5 KB of JSON. */
  summary: Record<string, unknown>;
  image: SeeingImage | null;
}

export interface AuditFailure {
  ok: false;
  failure_reason: string;
  error: string;
  hint?: string;
  detail?: Record<string, unknown>;
}

export type AuditResult = AuditSuccess | AuditFailure;

const MANIFEST_PATTERN = /^res:\/\/[A-Za-z0-9_\-./ ]{1,480}\.json$/;

function fail(failure_reason: string, error: string, hint?: string, detail?: Record<string, unknown>): AuditFailure {
  return { ok: false, failure_reason, error, ...(hint ? { hint } : {}), ...(detail ? { detail } : {}) };
}

export function validateManifestPath(path: string): string {
  const p = path;
  if (!MANIFEST_PATTERN.test(p) || p !== p.trim() || p.includes("..") || p.slice(5).includes("//")) {
    throw new ToolInputError(`manifests: ${JSON.stringify(path).slice(0, 80)} is not a res:// .json path (letters, digits, _ - . / and spaces only, no ".."). Nothing was sent.`);
  }
  return p;
}

export interface ValidatedAuditArgs {
  scenePath?: string;
  checks: AuditCheck[];
  root?: string;
  minSeverity: Severity;
  offset: number;
  limit: number;
  manifests: string[];
  render: "sheet" | "none";
  budgetMs: number;
  accept: Array<{ key: string; reason: string }>;
  showAccepted: boolean;
}

/** Strict validation; throws ToolInputError (nothing is sent). */
export function validateAuditArgs(args: SceneAuditArgs): ValidatedAuditArgs {
  const checks = args.checks?.length ? [...new Set(args.checks)] : [...AUDIT_CHECKS];
  for (const c of checks) {
    if (!(AUDIT_CHECKS as readonly string[]).includes(c)) throw new ToolInputError(`checks: unknown check ${JSON.stringify(c)}. Nothing was sent.`);
  }
  const offset = args.offset ?? 0;
  const limit = args.limit ?? AUDIT_DEFAULT_LIMIT;
  if (!Number.isInteger(offset) || offset < 0) throw new ToolInputError("offset must be a non-negative integer. Nothing was sent.");
  if (!Number.isInteger(limit) || limit < 1 || limit > AUDIT_MAX_LIMIT) throw new ToolInputError(`limit must be 1-${AUDIT_MAX_LIMIT}. Nothing was sent.`);
  const manifests = (args.manifests ?? []).map(validateManifestPath);
  if (manifests.length > AUDIT_MAX_MANIFESTS) throw new ToolInputError(`manifests: at most ${AUDIT_MAX_MANIFESTS}. Nothing was sent.`);
  const budgetMs = args.budget_ms ?? AUDIT_DEFAULT_BUDGET_MS;
  if (!Number.isInteger(budgetMs) || budgetMs < AUDIT_MIN_BUDGET_MS || budgetMs > AUDIT_MAX_BUDGET_MS) {
    throw new ToolInputError(`budget_ms must be an integer ${AUDIT_MIN_BUDGET_MS}-${AUDIT_MAX_BUDGET_MS}. Nothing was sent.`);
  }
  const root = args.root !== undefined && args.root.trim() !== "" && args.root.trim() !== "." ? validateNodePath(args.root.trim(), "root") : undefined;
  const accept = (args.accept ?? []).map((a) => {
    if (!a || typeof a.key !== "string" || !validIssueKey(a.key)) {
      throw new ToolInputError(`accept: ${JSON.stringify(a?.key ?? a).slice(0, 80)} is not an issue key (check:path@x,y,z, from issues[].key). Nothing was sent.`);
    }
    const reason = typeof a.reason === "string" ? a.reason.trim() : "";
    if (reason.length < 3 || reason.length > 200 || /[\r\n]/.test(reason)) throw new ToolInputError("accept: each reason must be one line of 3-200 characters. Nothing was sent.");
    return { key: a.key, reason };
  });
  if (accept.length > AUDIT_MAX_ACCEPT) throw new ToolInputError(`accept: at most ${AUDIT_MAX_ACCEPT} per call. Nothing was sent.`);
  return {
    ...(args.scenePath !== undefined ? { scenePath: validateScenePath(args.scenePath) } : {}),
    checks: AUDIT_CHECKS.filter((c) => checks.includes(c)),
    ...(root ? { root } : {}),
    minSeverity: args.min_severity ?? "look",
    offset,
    limit,
    manifests,
    render: args.render ?? "none",
    budgetMs,
    accept,
    showAccepted: args.show_accepted === true,
  };
}

/** Raw kernel measurements -> sorted issues (all checks that ran). */
export function judgeAll(result: KernelResult, checks: readonly AuditCheck[]): AuditIssue[] {
  return judgeAllDetailed(result, checks).issues;
}

export interface JudgedAudit {
  issues: AuditIssue[];
  notes: string[];
  /** Checks that ran but could measure nothing (never listed clean). */
  unmeasured: AuditCheck[];
}

export function judgeAllDetailed(result: KernelResult, checks: readonly AuditCheck[]): JudgedAudit {
  const inst = (Array.isArray(result.instances) ? result.instances : []) as InstRow[];
  const want = new Set(checks);
  const lines = Array.isArray(result.lines) ? result.lines : [];
  const issues: AuditIssue[] = [];
  const holes = want.has("through_hole") ? judgeThroughHoles(lines, inst) : [];
  issues.push(...holes);
  const gaps = judgeGaps(result, inst, want, holes);
  issues.push(...gaps.issues);
  if (want.has("floor_gap")) issues.push(...judgeFloorGaps(result.floors, inst, parsePackGrounds(result.packs)));
  const mounts = judgeMounts(Array.isArray(result.mounts) ? result.mounts : [], inst, want);
  issues.push(...mounts.issues);
  if (want.has("floating") || want.has("sunken")) {
    issues.push(...judgeSupport(Array.isArray(result.support) ? result.support : [], inst, mounts.wallMounted).filter((i) => want.has(i.check)));
  }
  if (want.has("interpenetration")) issues.push(...judgeOverlaps(Array.isArray(result.overlaps) ? result.overlaps : [], inst));
  if (want.has("insert_host")) issues.push(...judgeInserts(Array.isArray(result.inserts) ? result.inserts : [], inst));
  if (want.has("orientation")) issues.push(...judgeLongProps(Array.isArray(result.long_props) ? result.long_props : [], inst));
  if (want.has("uv_stretch")) issues.push(...judgeUv(Array.isArray(result.uv) ? result.uv : [], inst));
  const dup = judgeDuplicates(inst);
  if (want.has("duplicate")) issues.push(...dup.issues);
  if (want.has("z_fight")) {
    const geo = judgeZFightGeometry(result.zfight_geo, inst, dup.pairs);
    issues.push(...geo.issues, ...judgeZFight(lines, result.floors, inst, dup.pairs, geo.pairs));
  }
  if (want.has("lights")) issues.push(...judgeLights(result.lights, inst));
  if (want.has("transform")) issues.push(...judgeTransforms(inst));
  if (want.has("resource")) issues.push(...judgeResources(result.resources, inst));
  return { issues: sortIssues(groupRepeats(issues, inst)), notes: gaps.notes, unmeasured: gaps.unmeasured };
}

function sceneStats(result: KernelResult): Record<string, unknown> {
  const s = (result.stats ?? {}) as Record<string, unknown>;
  const pick = (k: string) => (typeof s[k] === "number" ? s[k] : undefined);
  return {
    nodes: pick("nodes"),
    instances: pick("instances"),
    meshes: pick("mesh_instances"),
    unique_meshes: pick("unique_meshes"),
    tris_unique: pick("tris_unique"),
    rays: pick("rays"),
  };
}

function lightStats(result: KernelResult): Record<string, unknown> | undefined {
  const l = result.lights;
  if (!l) return undefined;
  const c = (l.counts ?? {}) as Record<string, unknown>;
  const sh = (l.shadowed ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  return { renderer: l.renderer, omni: n(c.omni), spot: n(c.spot), directional: n(c.directional), shadowed: n(sh.omni) + n(sh.spot) + n(sh.directional), per_object_limit: l.limit };
}

export async function sceneAudit(client: AuditClient, rawArgs: SceneAuditArgs): Promise<AuditResult> {
  const args = validateAuditArgs(rawArgs);
  let scenePath = args.scenePath;
  if (!scenePath) {
    const current = resolveCurrentScene(undefined, await client.getSceneState(), undefined);
    if (!current) throw new ToolInputError('No scenePath given and no scene is open in the editor. Pass scenePath ("res://...tscn"). Nothing was sent.');
    scenePath = validateScenePath(current);
  }
  const missing = missingEngineOpResult(client, "ScenePreview", AUDIT_FALLBACK);
  if (missing) return fail(missing.failure_reason, missing.error, missing.hint, { op: "ScenePreview", engine_version: missing.engine_version });

  const config = {
    mode: "audit",
    checks: args.checks,
    ...(args.root ? { root: args.root } : {}),
    manifests: args.manifests,
    poses: args.render === "sheet",
    budget_ms: args.budgetMs,
  };
  const started = Date.now();
  const run = await runProbe(client, { scenePath, config, size: [16, 16], kernel: loadAuditKernel(), timeoutMs: 120_000 });
  const roundtrip = Date.now() - started;
  try {
    if (!run.ok || !run.result) {
      if (run.failureReason === "probe_did_not_run") {
        return fail("audit_did_not_run", "The audit kernel never wrote its result: the wrapper scene loaded but the built-in @tool script did not run (a script error, or the scene failed to load). Read summer_get_console for the engine's error.", undefined, { stage: run.result?.stage ?? null });
      }
      return fail(run.failureReason ?? "audit_failed", run.error ?? "The audit failed.", undefined, run.result ? { stage: run.result.stage ?? null, errors: run.result.errors ?? [] } : undefined);
    }
    const result = run.result as KernelResult;
    const judgeStarted = Date.now();
    const judged = judgeAllDetailed(result, args.checks);
    const judgeMs = Date.now() - judgeStarted;
    const partial = partialChecks(result.partial, args.checks);
    for (const c of judged.unmeasured) partial.checks[c] = 0;
    // Accepted items: merge this call's accept list into the file, then hide
    // what is accepted (stale entries show again).
    let acceptEntries = parseAcceptFile(result.accept);
    let acceptResult: Record<string, unknown> | undefined;
    if (args.accept.length) {
      const merged = mergeAccepts(acceptEntries, args.accept, judged.issues, scenePath);
      acceptResult = { added: merged.added.length, ...(merged.refused.length ? { refused: merged.refused.slice(0, 5) } : {}) };
      if (merged.entries) {
        try {
          await writeAcceptFile(client.getProjectRoot?.(), merged.entries);
          acceptEntries = merged.entries;
        } catch (err) {
          const reason = err instanceof AcceptStoreError ? err.reason : "write_failed";
          return fail(`accept_${reason}`, `Accepted items were not saved: ${err instanceof Error ? err.message : String(err)}`, "Run the audit without accept, or connect to the project's editor so its folder is known.");
        }
      }
    }
    const split = applyAccepts(judged.issues, acceptEntries, scenePath);
    for (const st of split.stale) st.issue.acceptStale = st.why;
    for (const a of split.accepted) a.issue.accepted = a.entry.reason;
    const all = args.showAccepted ? judged.issues : split.shown;
    const accepted = split.accepted.map((a) => a.issue);
    const { counts, clean } = countIssues(split.shown, args.checks, partial.checks, accepted);
    const matching = filterIssues(all, args.minSeverity);
    const notes: string[] = ["Read-only: audited the SAVED file in a private copy (open tab, undo and file untouched); save first."];
    if (accepted.length) notes.push(`${accepted.length} accepted item(s) ${args.showAccepted ? "listed (show_accepted)" : "hidden (counts.<check>.accepted; show_accepted:true lists them)"}${split.stale.length ? `; ${split.stale.length} shown again because their evidence changed (accept_stale)` : ""}.`);
    else if (split.stale.length) notes.push(`${split.stale.length} accepted item(s) shown again because their evidence changed (accept_stale).`);
    notes.push(...judged.notes);
    if (args.minSeverity !== "look") notes.push(`min_severity ${args.minSeverity}: ${all.length - matching.length} lower-severity issue(s) hidden.`);
    const lights = lightStats(result);
    if (lights && args.checks.includes("lights") && lights.renderer === "forward_plus") notes.push("lights: forward_plus has no per-object light limit; only spot rims were checked.");
    const stopped = Object.entries(partial.checks).map(([c, share]) => `${c} ${Math.round(share * 100)}%`);
    if (stopped.length) notes.push(`budget_ms ${args.budgetMs}: stopped early (editor time): ${stopped.join(", ")} covered; rerun those with checks:[...] or a larger budget_ms.`);
    if (partial.other.poses !== undefined) notes.push(`framing: views measured for ${Math.round(partial.other.poses * 100)}% of the pieces (budget); the rest have no sheet tile.`);
    for (const w of Array.isArray(result.warnings) ? (result.warnings as unknown[]).slice(0, 3) : []) notes.push(String(w).slice(0, 160));

    const base: Record<string, unknown> = {
      ok: true,
      tool: "summer_scene_audit",
      scenePath,
      ...(args.root ? { root: args.root } : {}),
      budget_ms: args.budgetMs,
      scene: sceneStats(result),
      counts,
      clean,
      ms: timingPerCheck(result.ms as Record<string, unknown> | undefined, { judge: judgeMs, roundtrip }),
      ...(lights ? { lights } : {}),
      total: all.length,
      ...(accepted.length || split.stale.length ? { accepted: { hidden: args.showAccepted ? 0 : accepted.length, stale: split.stale.length } } : {}),
      ...(acceptResult ? { accept_result: acceptResult } : {}),
      notes,
    };
    let page = buildPage({ base, issues: matching, offset: args.offset, limit: args.limit });

    // The sheet (one more engine call): the first issues of THIS page.
    let image: SeeingImage | null = null;
    if (args.render === "sheet") {
      const first = page.shown.slice(0, SHEET_TILES).map((c) => ({ n: c.n, issue: matching[c.n - 1]! }));
      const posed = first.map((f) => ({ ...f, pose: choosePose(f.issue.frame) })).filter((p) => p.pose !== null);
      const unposed = first.filter((f) => !posed.some((p) => p.n === f.n)).map((f) => f.n);
      let sheet: Record<string, unknown>;
      if (!posed.length) {
        sheet = { tiles: [], ...(unposed.length ? { no_clear_view: unposed } : {}) };
      } else {
        const layout = layoutGrid(posed.length, 16 / 9, 1536);
        const tiles = posed.map((p, k) => ({
          kind: "shot",
          rect: layout.rects[k]!,
          label: `#${p.n} ${p.issue.check}`,
          view: "beauty",
          pose: { position: [...p.pose!.position], look_at: [...p.pose!.look_at], fov: p.pose!.fov },
        }));
        const renderStarted = Date.now();
        const render = await runProbe(client, { scenePath, size: layout.canvas, config: { mode: "render", canvas: layout.canvas, tiles }, timeoutMs: 120_000 });
        try {
          if (render.ok && render.image) {
            image = { ...render.image };
            sheet = { tiles: posed.map((p) => p.n), ...(unposed.length ? { no_clear_view: unposed } : {}), render_ms: Date.now() - renderStarted };
          } else {
            sheet = { error: render.failureReason ?? "render_failed", detail: (render.error ?? "").slice(0, 160) };
          }
        } finally {
          await render.dispose();
        }
      }
      page = buildPage({ base: { ...base, sheet }, issues: matching, offset: args.offset, limit: args.limit });
    }
    return { ok: true, summary: page.body, image };
  } finally {
    await run.dispose();
  }
}
