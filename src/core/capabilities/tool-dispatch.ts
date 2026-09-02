/**
 * tool-dispatch — the shared per-tool dispatch registry (CONTRACT.md §2, §5).
 *
 * One entry per library `tool` resource (library/tools/<slug>/resource.yaml),
 * dispatching through the SAME underlying implementations the MCP server uses:
 * core capabilities (creator, debug-report, game-task-plan,
 * library feedback), the core EngineApiClient for engine ops, and the same
 * gateway endpoints for Studio generation / asset APIs.
 *
 * Consumed today by `summer tool <name>` (src/cli/commands/tool.ts).
 *
 * The helpers both faces need (scene-mutation chunking, guarded file writes,
 * Kenney import pairing, engine receipt failure semantics) live in ONE copy
 * each — ./engine-ops.ts, ./asset-import.ts, ./engine-receipt.ts — imported
 * here and by src/mcp/tools/*. v3-followup: src/mcp should adopt this registry
 * as the single per-tool dispatch table so the handler bodies stop being two
 * mirrors as well.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { EngineApiClient, EngineRebindError, type EngineSnapshot } from "../api-client.js";
import { missingEngineOpResult, resolveSingleOnlyOps, type MissingOpResult } from "../capability-skew.js";
import { buildAgentPlaybook } from "./agent-playbook.js";
import { importResolvedAsset, type GatewayAsset } from "./asset-import.js";
import {
  executeOpsChunked,
  executeSceneMutation,
  occurrenceCount,
  readTextPayload,
  safeProjectPath,
  validSha256,
} from "./engine-ops.js";
import { extractOpError, withOldEngineHint } from "./engine-receipt.js";
import { lookupApiDocs } from "./api-docs.js";
import { z, type ZodTypeAny } from "zod";
import { ImportHdriError, importHdriArgsSchema, importPolyHavenHdri } from "./hdri-import.js";
import {
  RUN_EDITOR_SCRIPT_FALLBACK,
  RUN_SCRIPT_FALLBACK,
  buildRunEditorScriptOp,
  buildRunSceneScriptOp,
} from "./scene-script.js";
import { getAuthToken } from "../auth.js";
import { shapeEngineLogResponse } from "../log-filters.js";
import {
  listCreatorReleases,
  publishCreator,
} from "./creator.js";
import {
  CONFIG_KEYS,
  getConfigValue,
  isConfigKey,
  readSummerConfig,
  resolveGatewayUrl,
  setConfigValue,
  unsetConfigValue,
} from "../config.js";
import { createDebugReportArtifact } from "./debug-report.js";
import { buildGameTaskPlan, gameTaskPlanInputSchema } from "./game-task-plan.js";
import {
  sendLibraryFeedback,
  type LibraryFeedbackReport,
} from "../feedback/client.js";

import { TOOLKIT_VERSION as CLI_VERSION } from "../version.js";

export type DispatchArgs = Record<string, unknown>;

export interface ToolDispatchContext {
  /** Lazily connect to the local engine. Throws EngineUnavailableError with a
   *  clean, actionable message when the engine is not running. */
  engine(): Promise<EngineApiClient>;
}

export interface ToolDispatchEntry {
  /** Canonical MCP tool name, e.g. "summer_add_node". */
  name: string;
  /** Library slug (tool/<slug>), e.g. "add-node". */
  slug: string;
  /** One-line summary for --list. */
  summary: string;
  /** True when the tool needs the local Summer Engine running. */
  engineRequired: boolean;
  handler(args: DispatchArgs, ctx: ToolDispatchContext): Promise<unknown>;
}

/** Dispatch-level failure with a user-facing message (no stack needed). */
export class ToolDispatchError extends Error {}

/** The local engine is not reachable — a clean state, not a crash. */
export class EngineUnavailableError extends ToolDispatchError {}

/** A tool failed with a structured receipt that `summer tool` prints whole
 *  (JSON on stdout, exit 1) instead of flattening to `message`. Today: the
 *  engine_lacks_op result, from the capability pre-flight (nothing sent) and
 *  from the post-hoc unknown-op rewrite (requireSupportedOp). */
export class ToolResultError extends ToolDispatchError {
  constructor(
    readonly result: Record<string, unknown>,
    message: string
  ) {
    super(message);
  }
}

export function createDefaultDispatchContext(): ToolDispatchContext {
  let cached: EngineApiClient | null = null;
  return {
    async engine() {
      if (cached) return cached;
      try {
        cached = await EngineApiClient.connect();
        return cached;
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : String(error);
        throw new EngineUnavailableError(
          "Summer Engine is not running (or no project is open).\n" +
            `${reason}\n` +
            "Start it with 'summer run' or open the project in the Summer desktop app, then retry.\n" +
            "Engine-free tools (generate-*, asset search/list/get, creator, plan) work without it."
        );
      }
    },
  };
}

function requireEngineSuccess<T>(result: T): T {
  const failure = extractOpError(result);
  if (failure) throw new ToolDispatchError(failure);
  return result;
}

/** Post-hoc twin of the missingEngineOpResult pre-flight, for engines that
 *  advertise no opKinds (0.5.65 ships `singleOnlyOps` only, so the pre-flight
 *  cannot refuse): such an engine answers with a per-op "unknown op: <Kind>".
 *  withOldEngineHint — the same helper the MCP face applies — rewrites that
 *  into the upgrade path + fallback and stamps failure_reason engine_lacks_op;
 *  it is thrown as a ToolResultError so `summer tool` prints the structured
 *  result rather than the bare engine string. */
function requireSupportedOp<T>(result: T, op: string, fallback: string): T {
  const hinted = withOldEngineHint(result, op, fallback) as
    | { failure_reason?: unknown; error?: unknown }
    | null
    | undefined;
  if (hinted?.failure_reason === "engine_lacks_op") {
    throw new ToolResultError(hinted as Record<string, unknown>, String(hinted.error));
  }
  return requireEngineSuccess(result);
}

/** Pre-flight refusal as a structured result (nothing was sent). */
function refuseMissingOp(missing: MissingOpResult): never {
  throw new ToolResultError({ ...missing }, missing.error);
}

// ---------------------------------------------------------------------------
// Gateway helpers (Studio generation + asset APIs). Same endpoints, bodies,
// and auth the MCP tools use (src/mcp/tools/generate-tools.ts,
// asset-tools.ts) with surface header "cli".
// ---------------------------------------------------------------------------
async function requireToken(): Promise<string> {
  const token = await getAuthToken();
  if (!token) {
    throw new ToolDispatchError(
      "Not signed in. Run 'summer login' first — these tools require a Summer Engine account."
    );
  }
  return token;
}

function gatewayHeaders(token: string, endpoint: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "X-Summer-Client": "summer-cli",
    "X-Summer-Client-Version": CLI_VERSION,
    "X-Summer-Client-Surface": "cli",
    "X-Summer-MCP-Endpoint": endpoint,
  };
}

async function readJsonBody(res: Response): Promise<DispatchArgs> {
  const text = await res.text().catch(() => "");
  if (!text) return {};
  try {
    return JSON.parse(text) as DispatchArgs;
  } catch {
    return { message: text.slice(0, 1000) };
  }
}

async function gatewayGet(
  endpoint: string,
  params?: URLSearchParams,
  timeoutMs = 30_000
): Promise<DispatchArgs> {
  const token = await requireToken();
  const gatewayUrl = await resolveGatewayUrl();
  // URLSearchParams.size is undefined on Node < 18.16 (falsy -> the whole
  // query used to be dropped silently); stringify instead.
  const query = params?.toString() ?? "";
  const suffix = query ? `?${query}` : "";
  let res: Response;
  try {
    res = await fetch(`${gatewayUrl}${endpoint}${suffix}`, {
      headers: gatewayHeaders(token, endpoint),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ToolDispatchError(
      `Request failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const data = await readJsonBody(res);
  if (!res.ok) {
    throw new ToolDispatchError(
      String(data.message || data.error || `Request failed (${res.status})`)
    );
  }
  return data;
}

async function gatewayPost(
  endpoint: string,
  body: DispatchArgs,
  timeoutMs = 120_000
): Promise<DispatchArgs> {
  const token = await requireToken();
  const gatewayUrl = await resolveGatewayUrl();
  let res: Response;
  try {
    res = await fetch(`${gatewayUrl}${endpoint}`, {
      method: "POST",
      headers: {
        ...gatewayHeaders(token, endpoint),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ToolDispatchError(
      `Generation request failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const data = await readJsonBody(res);
  if (!res.ok) {
    let message = String(data.message || data.error || `Request failed (${res.status})`);
    if (res.status === 402) {
      message = `${message} — insufficient credits; top up or upgrade on the Summer dashboard.`;
    }
    if (res.status === 401) {
      message = `${message} — auth token expired; run 'summer login' again.`;
    }
    throw new ToolDispatchError(message);
  }
  return data;
}

async function pollGenerationJob(
  jobId: string,
  maxWaitMs = 600_000,
  intervalMs = 5_000
): Promise<DispatchArgs> {
  const token = await requireToken();
  const gatewayUrl = await resolveGatewayUrl();
  const deadline = Date.now() + maxWaitMs;
  let interval = intervalMs;
  while (Date.now() < deadline) {
    const res = await fetch(
      `${gatewayUrl}/api/mcp/jobs/${encodeURIComponent(jobId)}`,
      {
        headers: gatewayHeaders(token, "/api/mcp/jobs"),
        signal: AbortSignal.timeout(15_000),
      }
    );
    const data = await readJsonBody(res);
    if (!res.ok) {
      throw new ToolDispatchError(String(data.message || "Job poll failed"));
    }
    if (data.status === "completed") return data;
    if (data.status === "failed") {
      throw new ToolDispatchError(String(data.error || "Job failed"));
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
    interval = Math.min(interval * 1.2, 15_000);
  }
  throw new ToolDispatchError(
    `Timed out after ${maxWaitMs / 1000}s. Re-check later with: summer tool check-job --json '{"jobId":"${jobId}"}'`
  );
}

async function searchAssetsGateway(params: {
  query: string;
  assetType?: string;
  limit?: number;
  source?: string;
}): Promise<DispatchArgs> {
  const search = new URLSearchParams();
  search.set("query", params.query);
  if (params.assetType && params.assetType !== "all") search.set("assetType", params.assetType);
  if (params.limit) search.set("limit", String(Math.min(params.limit, 20)));
  if (params.source) search.set("source", params.source);
  return gatewayGet("/api/mcp/assets", search, 15_000);
}

// ---------------------------------------------------------------------------
// Small engine helpers
// ---------------------------------------------------------------------------
function projectSettingValue(projectState: unknown, keys: string[]): string | null {
  const data = ((projectState ?? {}) as DispatchArgs).data as DispatchArgs | undefined;
  const entries = data?.entries;
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    const item = (entry ?? {}) as DispatchArgs;
    if (typeof item.key === "string" && keys.includes(item.key)) {
      return typeof item.value === "string" && item.value.length > 0 ? item.value : null;
    }
  }
  return null;
}

function str(args: DispatchArgs, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolDispatchError(`Missing required string argument: ${key}`);
  }
  return value;
}

function optStr(args: DispatchArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Validate CLI args against the SAME zod schema the MCP face uses, so the
 *  two surfaces reject the same inputs with a readable message. */
function parseToolArgs<T extends ZodTypeAny>(schema: T, args: DispatchArgs, tool: string): z.output<T> {
  const parsed = schema.safeParse(args);
  if (parsed.success) return parsed.data as z.output<T>;
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "args"}: ${issue.message}`)
    .join("; ");
  throw new ToolDispatchError(`Invalid arguments for ${tool}: ${issues}`);
}

async function snapshotResult(snap: EngineSnapshot, target: string): Promise<DispatchArgs> {
  const failure = extractOpError(snap);
  if (failure) throw new ToolDispatchError(failure);
  if (target === "game" && snap.failureReason === "bridge_required") {
    throw new ToolDispatchError(
      "Game capture is not available over this connection (requires the Summer desktop app bridge). " +
        "Use target 'viewport' or 'scene' instead."
    );
  }
  let localPath = snap.localPath;
  if (!localPath && snap.base64) {
    const dir = join(tmpdir(), "summer-cli");
    await mkdir(dir, { recursive: true });
    const ext = snap.mime?.includes("png") ? "png" : "jpg";
    localPath = join(dir, `screenshot-${Date.now()}.${ext}`);
    await writeFile(localPath, Buffer.from(snap.base64, "base64"));
  }
  const { base64: _dropped, ...rest } = snap;
  return { ...rest, localPath };
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------
function entry(
  name: string,
  summary: string,
  engineRequired: boolean,
  handler: ToolDispatchEntry["handler"]
): ToolDispatchEntry {
  return {
    name,
    slug: name.replace(/^summer_/, "").replace(/_/g, "-"),
    summary,
    engineRequired,
    handler,
  };
}

const SCENE_MUTATION_OPS = new Set([
  "AddNode", "RemoveNode", "MoveNode", "ReparentNode", "ReplaceNode",
  "SetProp", "SetResourceProperty", "ConnectSignal", "DisconnectSignal",
  "InstantiateScene", "SaveScene", "SnapToSurface", "AlignDistribute3D",
  "FrameCamera3D", "Undo",
]);

/** Read-only spatial queries: identity-bound to an exact scene, never saved. */
const SCENE_QUERY_OPS = new Set(["TestPlacement3D", "CameraVisibility3D", "NavigationProbe3D", "Starcast3D"]);

// ---------------------------------------------------------------------------
// Spatial tool argument helpers. Mirror of the bounds in
// src/mcp/tools/spatial-tools.ts (exact paths, UTF-8 byte limits, subject
// counts). v3-followup: fold into one copy when mcp adopts this registry.
// ---------------------------------------------------------------------------
const SPATIAL_SCENE_PATH_LIMIT_BYTES = 512;
const SPATIAL_NODE_PATH_LIMIT_BYTES = 256;

function exactPath(args: DispatchArgs, key: string, limitBytes: number): string {
  const value = str(args, key).trim();
  if (!value) throw new ToolDispatchError(`${key} must name one exact path.`);
  if (Buffer.byteLength(value, "utf8") > limitBytes) {
    throw new ToolDispatchError(`${key} must be at most ${limitBytes} UTF-8 bytes after trimming.`);
  }
  return value;
}

function exactSubjectPaths(args: DispatchArgs, min: number, max: number): string[] {
  const raw = args.subjectPaths;
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
    throw new ToolDispatchError("subjectPaths must be an array of exact node path strings");
  }
  const subjects = (raw as string[]).map((entry, index) => {
    const value = entry.trim();
    if (!value) throw new ToolDispatchError(`subjectPaths[${index}] must name one exact path.`);
    if (Buffer.byteLength(value, "utf8") > SPATIAL_NODE_PATH_LIMIT_BYTES) {
      throw new ToolDispatchError(
        `subjectPaths[${index}] must be at most ${SPATIAL_NODE_PATH_LIMIT_BYTES} UTF-8 bytes after trimming.`
      );
    }
    return value;
  });
  if (subjects.length < min || subjects.length > max) {
    throw new ToolDispatchError(`subjectPaths must contain ${min}..${max} exact paths.`);
  }
  if (new Set(subjects).size !== subjects.length) {
    throw new ToolDispatchError("subjectPaths must not contain duplicates.");
  }
  return subjects;
}

function finiteVector3(
  args: DispatchArgs,
  key: string,
  fallback?: [number, number, number]
): [number, number, number] {
  const value = args[key];
  if (value === undefined && fallback) return fallback;
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every((n) => typeof n === "number" && Number.isFinite(n))
  ) {
    throw new ToolDispatchError(`${key} must be an array of exactly three finite numbers`);
  }
  return value as [number, number, number];
}

function optNumber(args: DispatchArgs, key: string, fallback: number): number {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolDispatchError(`${key} must be a finite number`);
  }
  return value;
}

function optBoolean(args: DispatchArgs, key: string, fallback: boolean): boolean {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new ToolDispatchError(`${key} must be a boolean`);
  return value;
}

/** Capability pre-flight shared by the six spatial tools: refuse before
 *  sending when the engine advert PROVES the op is missing. */
async function requireSpatialOp(
  ctx: ToolDispatchContext,
  op: string,
  fallback: string
): Promise<EngineApiClient> {
  const client = await ctx.engine();
  const missing = missingEngineOpResult(client, op, fallback);
  if (missing) refuseMissingOp(missing);
  return client;
}

// Fallbacks named by the engine_lacks_op result — the same string whether the
// pre-flight refused (nothing sent) or the engine answered "unknown op".
// Scripting fallbacks come from ./scene-script.ts; the MCP face words its own
// in perception-tools.ts / spatial-tools.ts.
const WORLD_SNAPSHOT_FALLBACK =
  "read structure with summer_get_scene_tree and verify visually with summer_screenshot";
const SNAPSHOT_DIFF_FALLBACK = "compare two summer_world_snapshot results yourself";
const RUNTIME_TREE_FALLBACK = "probe runtime state with a RunVerification probe";
const RUNTIME_NODE_FALLBACK = "probe the node from a RunVerification probe";
const TEST_PLACEMENT_FALLBACK =
  "judge clearance from summer_world_snapshot AABBs and verify with summer_screenshot";
const SNAP_TO_SURFACE_FALLBACK =
  "set the subject's position with summer_set_prop from summer_world_snapshot AABBs";
const ALIGN_DISTRIBUTE_FALLBACK =
  "compute anchors from summer_world_snapshot AABBs and set positions with summer_set_prop";
const FRAME_CAMERA_FALLBACK =
  "position the camera with summer_set_prop and check with summer_screenshot target 'scene'";
const CAMERA_VISIBILITY_FALLBACK = "check framing visually with summer_screenshot target 'scene'";
const NAVIGATION_PROBE_FALLBACK =
  "probe reachability from a RunVerification probe (NavigationServer3D.map_get_path)";
const STARCAST_FALLBACK =
  "judge support, contact, and clearance from summer_inspect_node / summer_world_snapshot AABBs and verify with summer_screenshot";

export const TOOL_DISPATCH: readonly ToolDispatchEntry[] = [
  // --- asset ---
  entry(
    "summer_search_assets",
    "Search the Summer asset library and your own assets; returns import-ready URLs",
    false,
    (args) =>
      searchAssetsGateway({
        query: String(args.query ?? ""),
        assetType: optStr(args, "assetType"),
        limit: typeof args.limit === "number" ? args.limit : 10,
        source: optStr(args, "source") ?? "library",
      })
  ),
  entry(
    "summer_list_my_assets",
    "List or search the signed-in user's generated and uploaded assets",
    false,
    (args) =>
      searchAssetsGateway({
        query: String(args.query ?? ""),
        assetType: optStr(args, "assetType"),
        limit: typeof args.limit === "number" ? args.limit : 10,
        source: "my_assets",
      })
  ),
  entry(
    "summer_get_asset",
    "Fetch one asset by exact Summer asset id (file URL, metadata, license)",
    false,
    (args) => gatewayGet(`/api/mcp/assets/${encodeURIComponent(str(args, "assetId"))}`)
  ),
  entry(
    "summer_get_asset_download_url",
    "Get a downloadable URL for an asset file (primary or thumbnail)",
    false,
    (args) =>
      gatewayGet(
        `/api/mcp/assets/${encodeURIComponent(str(args, "assetId"))}/download-url`,
        new URLSearchParams({ role: optStr(args, "role") ?? "primary" })
      )
  ),
  entry(
    "summer_import_asset_by_id",
    "Import an exact Summer asset id into the open project (optionally into a scene)",
    true,
    async (args, ctx) => {
      const fetched = await gatewayGet(
        `/api/mcp/assets/${encodeURIComponent(str(args, "assetId"))}`
      );
      const asset = fetched.asset as GatewayAsset | undefined;
      if (!asset) throw new ToolDispatchError("Asset not found.");
      return importResolvedAsset(await ctx.engine(), {
        asset,
        parent: optStr(args, "parent"),
        scenePath: optStr(args, "scenePath"),
        path: optStr(args, "path"),
        name: optStr(args, "name"),
      });
    }
  ),
  entry(
    "summer_import_asset",
    "Search the asset library and import the best match in one step",
    true,
    async (args, ctx) => {
      const result = await searchAssetsGateway({
        query: str(args, "query"),
        assetType: optStr(args, "assetType") ?? "3d_model",
        limit: 5,
        source: optStr(args, "source") ?? "all",
      });
      const assets = (result.assets ?? []) as GatewayAsset[];
      if (assets.length === 0) {
        throw new ToolDispatchError(
          `No assets found for "${String(args.query)}". Try different keywords.`
        );
      }
      return importResolvedAsset(await ctx.engine(), {
        asset: assets[0]!,
        parent: optStr(args, "parent"),
        scenePath: optStr(args, "scenePath"),
      });
    }
  ),

  // --- creator (shared core capability, face: cli) ---
  entry("summer_import_hdri", "Search Poly Haven's CC0 HDRIs and import one as environment lighting", true, async (args, ctx) => {
    const parsed = parseToolArgs(importHdriArgsSchema, args, "import-hdri");
    try {
      return await importPolyHavenHdri(parsed, () => ctx.engine());
    } catch (err) {
      if (err instanceof ImportHdriError) {
        throw new ToolDispatchError(`${err.message}${err.hint ? ` ${err.hint}` : ""}`);
      }
      throw err;
    }
  }),

  entry("summer_creator_publish", "Publish an exported .pck through the creator API (confirm-gated)", false, (args) =>
    publishCreator({
      project: optStr(args, "project"),
      artifact: optStr(args, "artifact"),
      version: optStr(args, "version"),
      manifest: optStr(args, "manifest"),
      projectId: optStr(args, "projectId"),
      channel: optStr(args, "channel"),
      notes: optStr(args, "notes"),
      confirm: args.confirm === true,
      face: "cli",
    })
  ),
  entry("summer_creator_releases", "List creator-owned releases", false, (args) =>
    listCreatorReleases({
      projectId: optStr(args, "projectId"),
      limit: typeof args.limit === "number" ? args.limit : 20,
      cursor: optStr(args, "cursor"),
      face: "cli",
    })
  ),
  entry("summer_creator_config", "Read or update the shared non-secret Summer configuration", false, async (args) => {
    const action = str(args, "action");
    if (action === "list") {
      const config = await readSummerConfig();
      return {
        ok: true,
        values: Object.fromEntries(
          CONFIG_KEYS.map((name) => [name, getConfigValue(config, name) ?? null])
        ),
      };
    }
    const key = optStr(args, "key");
    if (!key || !isConfigKey(key)) {
      throw new ToolDispatchError(`A valid key is required. Use one of ${CONFIG_KEYS.join(", ")}.`);
    }
    if (action === "get") {
      return { ok: true, key, value: getConfigValue(await readSummerConfig(), key) ?? null };
    }
    if (args.confirm !== true) {
      throw new ToolDispatchError(
        `Changing ${key} requires confirmation. Retry with "confirm": true after the user approves the exact change.`
      );
    }
    if (action === "set") {
      const value = optStr(args, "value");
      if (value === undefined) {
        throw new ToolDispatchError(`A value is required for ${key}.`);
      }
      const config = await setConfigValue(key, value);
      return { ok: true, key, value: getConfigValue(config, key) };
    }
    if (action === "unset") {
      const config = await unsetConfigValue(key);
      return { ok: true, key, value: getConfigValue(config, key) ?? null };
    }
    throw new ToolDispatchError(`Unknown action "${action}". Use list, get, set, or unset.`);
  }),

  // --- debug ---
  entry("summer_get_diagnostics", "Overview of editor console and runtime debugger errors/warnings", true, async (args, ctx) =>
    requireEngineSuccess(await (await ctx.engine()).getDiagnostics())
  ),
  entry("summer_get_console", "Read recent editor Output panel messages (deduplicated)", true, async (args, ctx) => {
    const op: DispatchArgs = {
      op: "GetConsoleOutput",
      max_lines: typeof args.max_lines === "number" ? args.max_lines : 100,
    };
    if (optStr(args, "filter")) op.filter = args.filter;
    if (optStr(args, "type")) op.type = args.type;
    const engineResult = requireEngineSuccess(await (await ctx.engine()).executeOps([op]));
    if (args.raw === true) return engineResult;
    const { result } = shapeEngineLogResponse(engineResult, {
      errorsOnly: args.errors_only !== false,
      errorsOnlyStrict: args.strict_errors === true,
      maxEntries: typeof args.max_lines === "number" ? args.max_lines : 100,
    });
    return result;
  }),
  entry("summer_clear_console", "Clear the editor's Output panel", true, async (args, ctx) =>
    requireEngineSuccess(await (await ctx.engine()).executeOps([{ op: "ClearConsoleOutput" }]))
  ),
  entry("summer_get_debugger_errors", "Read deduplicated runtime errors from the debugger", true, async (args, ctx) => {
    const maxErrors = typeof args.max_errors === "number" ? args.max_errors : 50;
    const op: DispatchArgs = { op: "GetDebuggerErrors", max_errors: maxErrors };
    if (args.include_stack !== undefined) op.include_stack = args.include_stack === true;
    if (args.include_warnings === true) op.include_warnings = true;
    const engineResult = requireEngineSuccess(await (await ctx.engine()).executeOps([op]));
    if (args.raw === true) return engineResult;
    return shapeEngineLogResponse(engineResult, { maxEntries: maxErrors }).result;
  }),
  entry("summer_get_debugger_warnings", "Read runtime warnings from the debugger panel", true, async (args, ctx) => {
    const maxWarnings = typeof args.max_warnings === "number" ? args.max_warnings : 50;
    const op: DispatchArgs = {
      op: "GetDebuggerErrors",
      max_errors: maxWarnings,
      type: "warning",
      include_stack: args.include_stack !== false,
    };
    const engineResult = requireEngineSuccess(await (await ctx.engine()).executeOps([op]));
    if (args.raw === true) return engineResult;
    return shapeEngineLogResponse(engineResult, { maxEntries: maxWarnings }).result;
  }),
  entry("summer_play", "Start the game (main scene or a specific scene)", true, async (args, ctx) =>
    requireEngineSuccess(await (await ctx.engine()).play(optStr(args, "scene")))
  ),
  entry("summer_stop", "Stop the running game", true, async (_args, ctx) =>
    requireEngineSuccess(await (await ctx.engine()).stop())
  ),
  entry("summer_is_running", "Check whether the game is running", true, async (_args, ctx) =>
    requireEngineSuccess(await (await ctx.engine()).executeOps([{ op: "IsGameRunning" }]))
  ),
  entry("summer_get_script_errors", "Check a GDScript file for parse/compile errors", true, async (args, ctx) =>
    requireEngineSuccess(await (await ctx.engine()).getScriptErrors(str(args, "path")))
  ),
  entry("summer_create_debug_report", "Create a support-ready Markdown debug report", false, async (args) => {
    const artifact = await createDebugReportArtifact({
      issue: optStr(args, "issue"),
      outputPath: optStr(args, "output_path"),
      includePlaySession: args.include_play_session === true,
      playWaitMs: typeof args.play_wait_ms === "number" ? args.play_wait_ms : 2500,
      maxConsoleLines: typeof args.max_console_lines === "number" ? args.max_console_lines : 200,
      maxDebuggerEntries:
        typeof args.max_debugger_entries === "number" ? args.max_debugger_entries : 100,
      includeDoctor: args.include_doctor !== false,
    });
    return {
      ok: true,
      path: artifact.path,
      engineConnected: artifact.report.engine.connected,
      generatedAt: artifact.report.generatedAt,
      issue: artifact.report.issue,
      reviewNote:
        "Report omits auth tokens, but review local paths and stack traces before sending.",
    };
  }),

  // --- file ---
  entry("summer_read_file", "Read a project text file and its sha256 receipt", true, async (args, ctx) =>
    requireEngineSuccess(
      await (await ctx.engine()).readProjectFile(
        safeProjectPath(str(args, "path")),
        typeof args.max_bytes === "number" ? args.max_bytes : 200_000
      )
    )
  ),
  entry("summer_write_file", "Create or safely overwrite one complete project text file", true, async (args, ctx) => {
    const safePath = safeProjectPath(str(args, "path"));
    const content = args.content;
    if (typeof content !== "string") {
      throw new ToolDispatchError("Missing required string argument: content");
    }
    const guardedCreate = args.create_only === true;
    const guardedOverwrite = validSha256(args.expected_sha256);
    if (args.expected_sha256 !== undefined && !guardedOverwrite) {
      throw new ToolDispatchError(
        "Safe write refused: expected_sha256 must be a 64-character hexadecimal sha256 from read-file. Nothing was written."
      );
    }
    if (guardedCreate === guardedOverwrite) {
      throw new ToolDispatchError(
        "Safe write requires exactly one guard: create_only:true for a new file, or expected_sha256 from read-file for an existing file. Nothing was written."
      );
    }
    const op: DispatchArgs = { op: "WriteFile", path: safePath, content };
    if (guardedCreate) op.mustNotExist = true;
    if (guardedOverwrite) op.expectedSha256 = (args.expected_sha256 as string).toLowerCase();
    return requireEngineSuccess(await (await ctx.engine()).executeIdentityBoundOps([op]));
  }),
  entry("summer_replace_text", "Safely replace text in an existing project file", true, async (args, ctx) => {
    const safePath = safeProjectPath(str(args, "path"));
    const oldText = str(args, "old_text");
    const newText = typeof args.new_text === "string" ? args.new_text : "";
    const replaceAll = args.replace_all === true;
    const client = await ctx.engine();
    const current = readTextPayload(await client.readProjectFile(safePath, 1_000_000));
    const matches = occurrenceCount(current.content, oldText);
    if (matches === 0) {
      throw new ToolDispatchError("Safe replace refused: old_text was not found. Nothing was written.");
    }
    if (!replaceAll && matches !== 1) {
      throw new ToolDispatchError(
        `Safe replace refused: old_text matched ${matches} times. Provide a unique span or set replace_all:true. Nothing was written.`
      );
    }
    const content = replaceAll
      ? current.content.split(oldText).join(newText)
      : current.content.replace(oldText, newText);
    if (content === current.content) {
      return { ok: true, noOp: true, path: safePath, sha256: current.sha256, matches };
    }
    return requireEngineSuccess(
      await client.executeIdentityBoundOps([
        { op: "WriteFile", path: safePath, content, expectedSha256: current.sha256 },
      ])
    );
  }),

  // --- generate ---
  entry("summer_get_studio_workflow", "Discover Summer Studio guided workflow recipes", false, (args) => {
    const params = new URLSearchParams();
    const workflowId = optStr(args, "workflowId");
    if (workflowId) params.set("id", workflowId);
    return gatewayGet("/api/mcp/workflows", params);
  }),
  entry("summer_generate_image", "Generate or edit an image via Summer Studio", false, (args) =>
    gatewayPost("/api/mcp/generate/image", {
      prompt: str(args, "prompt"),
      model: optStr(args, "model") ?? "nano-banana-2",
      style: optStr(args, "style") ?? "realistic",
      referenceImageUrl: optStr(args, "referenceImageUrl"),
      options: args.options,
    })
  ),
  entry("summer_slice_asset_sheet", "Detect and crop every asset from a generated sheet image", false, (args) =>
    gatewayPost("/api/mcp/generate/slice-asset-sheet", { assetId: str(args, "assetId") }, 300_000)
  ),
  entry("summer_generate_audio", "Generate speech, sound effects, music, or dialogue", false, (args) => {
    const body: DispatchArgs = { capability: str(args, "capability") };
    for (const key of ["text", "prompt", "voiceId", "modelId"]) {
      if (optStr(args, key)) body[key] = args[key];
    }
    if (typeof args.durationSeconds === "number") body.durationSeconds = args.durationSeconds;
    if (Array.isArray(args.inputs)) body.inputs = args.inputs;
    if (args.options) body.options = args.options;
    return gatewayPost("/api/mcp/generate/audio", body);
  }),
  entry("summer_generate_3d", "Generate a 3D model (optional auto-rig + animations)", false, async (args) => {
    const options = {
      ...((args.options as DispatchArgs) ?? {}),
      ...(Array.isArray(args.imageUrls) ? { imageUrls: args.imageUrls } : {}),
      ...(optStr(args, "assetIntent") ? { assetIntent: args.assetIntent } : {}),
      referencePreparation: optStr(args, "referencePreparation") ?? "auto",
      ...(args.rig === true ? { rig: true } : {}),
      ...(Array.isArray(args.animationNames) ? { animationNames: args.animationNames } : {}),
      ...(Array.isArray(args.actionIds) ? { actionIds: args.actionIds } : {}),
      ...(typeof args.riggingHeightMeters === "number"
        ? { riggingHeightMeters: args.riggingHeightMeters }
        : {}),
    };
    const result = await gatewayPost("/api/mcp/generate/3d", {
      prompt: optStr(args, "prompt"),
      kind: optStr(args, "kind") ?? "text-to-3d",
      model: optStr(args, "model") ?? "hunyuan",
      imageUrl: optStr(args, "imageUrl"),
      title: optStr(args, "title"),
      idempotencyKey: optStr(args, "idempotencyKey"),
      options,
    });
    const jobId = typeof result.jobId === "string" ? result.jobId : undefined;
    if (args.wait === false || !jobId) return result;
    const final = await pollGenerationJob(jobId);
    return { ...final, jobId };
  }),
  entry("summer_generate_video", "Generate a video from text or an image", false, (args) =>
    gatewayPost("/api/mcp/generate/video", {
      prompt: str(args, "prompt"),
      model: optStr(args, "model") ?? "ltx",
      imageUrl: optStr(args, "imageUrl"),
      duration: typeof args.duration === "number" ? args.duration : 5,
      aspectRatio: optStr(args, "aspectRatio") ?? "16:9",
      options: args.options,
    })
  ),
  entry("summer_check_job", "Check the status of an async generation job", false, (args) =>
    gatewayGet(`/api/mcp/jobs/${encodeURIComponent(str(args, "jobId"))}`, undefined, 15_000)
  ),
  entry("summer_generate_motion", "Generate a curated mocap clip for a rigged humanoid", false, async (args) => {
    const result = await gatewayPost("/api/mcp/generate/motion", {
      rigAssetId: str(args, "rigAssetId"),
      backend: optStr(args, "backend") ?? "meshy-library",
      motionName: str(args, "motionName"),
      options: args.options,
    });
    const jobId = typeof result.jobId === "string" ? result.jobId : undefined;
    if (args.wait === false || !jobId) return result;
    const final = await pollGenerationJob(jobId, 300_000);
    return { ...final, jobId };
  }),

  // --- project ---
  entry("summer_start_game_task", "Plan the right Summer workflow for a game-building task", false, async (args) =>
    buildGameTaskPlan(parseToolArgs(gameTaskPlanInputSchema, args, "start-game-task"))
  ),
  entry("summer_get_agent_playbook", "AI-first operating guide for Summer MCP", false, async () =>
    // Same content the MCP tool/prompt serve (core/capabilities/agent-playbook.ts);
    // the boot drift notice is an MCP-surface extra and is null here.
    buildAgentPlaybook()
  ),
  entry("summer_get_project_context", "Engine health, project/scene state, and session rebind", true, async (args, ctx) => {
    const client = await ctx.engine();
    const settingsPrefix = optStr(args, "settingsPrefix");
    const [health, project, scene] = await Promise.all([
      client.health(),
      client.getProjectState(settingsPrefix),
      client.getSceneState().catch((err) => ({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })),
    ]);
    // A failed rebind keeps the previous identity; report that honestly
    // instead of echoing the stale hash as if the switch had been followed.
    let boundProjectIdHash: string | undefined;
    let rebindError: string | undefined;
    try {
      boundProjectIdHash = await client.rebind();
    } catch (error) {
      if (!(error instanceof EngineRebindError)) throw error;
      rebindError = error.message;
    }
    return {
      health,
      project,
      scene,
      mainScene: projectSettingValue(project, ["application/run/main_scene", "run/main_scene"]),
      boundProjectIdHash,
      ...(rebindError ? { rebindError } : {}),
    };
  }),
  entry("summer_open_main_scene", "Open the project's configured main scene", true, async (_args, ctx) => {
    const client = await ctx.engine();
    const projectState = await client.getProjectState();
    const mainScene = projectSettingValue(projectState, [
      "application/run/main_scene",
      "run/main_scene",
    ]);
    if (!mainScene) {
      throw new ToolDispatchError(
        "Could not resolve application/run/main_scene from project state. Open a scene explicitly with open-scene."
      );
    }
    return requireEngineSuccess(
      await client.executeOps([{ op: "OpenScene", path: mainScene }])
    );
  }),
  entry("summer_project_setting", "Set one project.godot setting", true, async (args, ctx) => {
    const value = args.value;
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new ToolDispatchError("value must be a string, number, or boolean");
    }
    return requireEngineSuccess(
      await (await ctx.engine()).executeOps([
        { op: "ProjectSetting", key: str(args, "key"), value },
      ])
    );
  }),
  entry("summer_input_map_bind", "Create an input action and bind events to it", true, async (args, ctx) => {
    if (!Array.isArray(args.events)) {
      throw new ToolDispatchError("events must be an array of input event objects");
    }
    return requireEngineSuccess(
      await (await ctx.engine()).executeOps([
        { op: "InputMapAddAction", name: str(args, "name") },
        { op: "InputMapBind", name: str(args, "name"), events: args.events },
      ])
    );
  }),
  entry("summer_get_scene_tree", "Read a scene's node tree (explicit depth/limit honored)", true, async (args, ctx) => {
    const client = await ctx.engine();
    const scenePath = optStr(args, "scenePath");
    const depth = typeof args.depth === "number" ? args.depth : undefined;
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    if (depth === undefined && limit === undefined) {
      return requireEngineSuccess(await client.getSceneState(scenePath));
    }
    let target = scenePath;
    if (!target) {
      const snapshot = (await client.getSceneState()) as DispatchArgs;
      const provenance = (snapshot?.provenance ?? {}) as DispatchArgs;
      const data = (snapshot?.data ?? {}) as DispatchArgs;
      target =
        (typeof provenance.scenePath === "string" && provenance.scenePath) ||
        (typeof data.scenePath === "string" && data.scenePath) ||
        undefined;
      if (!target) {
        return {
          ...snapshot,
          depthLimitApplied: false,
          note: "depth/limit were IGNORED: the current scene path could not be resolved. Pass scenePath explicitly to apply them.",
        };
      }
    }
    return requireEngineSuccess(await client.getSceneState(target, { depth, limit }));
  }),
  entry("summer_import_from_url", "Download one file by URL through Godot's import pipeline", true, async (args, ctx) => {
    const op: DispatchArgs = { op: "ImportFromUrl", url: str(args, "url") };
    if (optStr(args, "path")) op.path = args.path;
    return requireEngineSuccess(await (await ctx.engine()).executeOps([op]));
  }),
  entry("summer_import_from_url_batch", "Download multiple files by URL in one operation", true, async (args, ctx) => {
    if (!Array.isArray(args.imports)) {
      throw new ToolDispatchError("imports must be an array of {url, path} objects");
    }
    return requireEngineSuccess(
      await (await ctx.engine()).executeOps([{ op: "ImportFromUrlBatch", imports: args.imports }])
    );
  }),

  // --- scene ---
  entry("summer_create_scene", "Create a new minimal .tscn with a create-only guard", true, async (args, ctx) => {
    const safePath = str(args, "path").trim().replace(/\\/g, "/");
    const rootName = optStr(args, "rootName") ?? "Main";
    const rootType = optStr(args, "rootType") ?? "Node3D";
    if (!safePath.startsWith("res://") || safePath.includes("..")) {
      throw new ToolDispatchError("Scene path must be a traversal-free res:// project path.");
    }
    if (!safePath.endsWith(".tscn")) {
      throw new ToolDispatchError("New scenes must use the text format: the path must end in .tscn.");
    }
    if (!/^[A-Za-z_][A-Za-z0-9_\- ]*$/.test(rootName)) {
      throw new ToolDispatchError(`Invalid rootName "${rootName}".`);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(rootType)) {
      throw new ToolDispatchError(`Invalid rootType "${rootType}".`);
    }
    const client = await ctx.engine();
    const receipt = requireEngineSuccess(
      await client.executeIdentityBoundOps([
        {
          op: "WriteFile",
          path: safePath,
          content: `[gd_scene format=3]\n\n[node name="${rootName}" type="${rootType}"]\n`,
          mustNotExist: true,
        },
      ])
    );
    return {
      ok: true,
      created: safePath,
      rootName,
      rootType,
      receipt,
      hint: "The new scene is on disk but not open. Use open-scene to start editing it.",
    };
  }),
  entry("summer_add_node", "Add a node to an exact scene", true, async (args, ctx) =>
    executeSceneMutation(await ctx.engine(), str(args, "scenePath"), [
      { op: "AddNode", parent: str(args, "parent"), type: str(args, "type"), name: str(args, "name") },
    ])
  ),
  entry("summer_set_prop", "Set a node property (Godot string syntax for complex types)", true, async (args, ctx) =>
    executeSceneMutation(await ctx.engine(), str(args, "scenePath"), [
      { op: "SetProp", path: str(args, "path"), key: str(args, "key"), value: args.value },
    ])
  ),
  entry("summer_set_resource_property", "Set a nested property on a node's resource", true, async (args, ctx) =>
    executeSceneMutation(await ctx.engine(), str(args, "scenePath"), [
      {
        op: "SetResourceProperty",
        nodePath: str(args, "nodePath"),
        resourceProperty: str(args, "resourceProperty"),
        subProperty: str(args, "subProperty"),
        value: args.value,
      },
    ])
  ),
  entry("summer_remove_node", "Remove a node (and children) from a scene", true, async (args, ctx) =>
    executeSceneMutation(await ctx.engine(), str(args, "scenePath"), [
      { op: "RemoveNode", path: str(args, "path") },
    ])
  ),
  entry("summer_save_scene", "Save an explicit scene to disk (or save-as)", true, async (args, ctx) => {
    const op: DispatchArgs = { op: "SaveScene" };
    if (optStr(args, "path")) op.path = args.path;
    return executeSceneMutation(await ctx.engine(), str(args, "scenePath"), [op]);
  }),
  entry("summer_open_scene", "Open a scene file in the editor", true, async (args, ctx) =>
    requireEngineSuccess(
      await (await ctx.engine()).executeOps([{ op: "OpenScene", path: str(args, "path") }])
    )
  ),
  entry("summer_instantiate_scene", "Add an existing scene or 3D model as a child node", true, async (args, ctx) => {
    const op: DispatchArgs = {
      op: "InstantiateScene",
      parent: str(args, "parent"),
      scene: str(args, "scene"),
    };
    if (optStr(args, "name")) op.name = args.name;
    return executeSceneMutation(await ctx.engine(), str(args, "scenePath"), [op]);
  }),
  entry("summer_connect_signal", "Connect a signal between two nodes", true, async (args, ctx) =>
    executeSceneMutation(await ctx.engine(), str(args, "scenePath"), [
      {
        op: "ConnectSignal",
        emitter: str(args, "emitter"),
        signal: str(args, "signal"),
        receiver: str(args, "receiver"),
        method: str(args, "method"),
      },
    ])
  ),
  entry("summer_select_node", "Select a node in the editor scene tree", true, async (args, ctx) => {
    const op: DispatchArgs = { op: "SelectNode", nodePath: str(args, "nodePath") };
    if (optStr(args, "scenePath")) op.scenePath = args.scenePath;
    return requireEngineSuccess(await (await ctx.engine()).executeOps([op]));
  }),
  entry("summer_replace_node", "Replace a node with a different type or scene", true, async (args, ctx) => {
    const op: DispatchArgs = { op: "ReplaceNode", path: str(args, "path") };
    if (optStr(args, "type")) op.type = args.type;
    if (optStr(args, "scene")) op.scene = args.scene;
    return executeSceneMutation(await ctx.engine(), str(args, "scenePath"), [op]);
  }),
  entry("summer_inspect_node", "Get all editable properties of a node", true, async (args, ctx) =>
    requireEngineSuccess(await (await ctx.engine()).inspectNode(str(args, "path")))
  ),
  entry("summer_inspect_resource", "Get all properties of a resource", true, async (args, ctx) =>
    requireEngineSuccess(await (await ctx.engine()).inspectResource(str(args, "path")))
  ),
  entry("summer_batch", "Run multiple engine ops as one undo group (verbatim passthrough)", true, async (args, ctx) => {
    if (!Array.isArray(args.ops)) {
      throw new ToolDispatchError("ops must be an array of operation objects");
    }
    const ops = args.ops as DispatchArgs[];
    const rawFileMutation = ops.find((op) => {
      const kind = String(op.op ?? "");
      return kind === "WriteFile" || kind === "ReplaceText";
    });
    if (rawFileMutation) {
      throw new ToolDispatchError(
        `batch does not accept raw ${String(rawFileMutation.op)} operations. ` +
          "Use write-file or replace-text so content guards are enforced."
      );
    }
    const scenePath = optStr(args, "scenePath");
    const containsMutation = ops.some((op) => SCENE_MUTATION_OPS.has(String(op.op ?? "")));
    const needsScenePath =
      containsMutation || ops.some((op) => SCENE_QUERY_OPS.has(String(op.op ?? "")));
    if (needsScenePath && !scenePath) {
      throw new ToolDispatchError("batch requires scenePath when ops targets a scene");
    }
    const client = await ctx.engine();
    const options: DispatchArgs = { groupUndo: true, ...(scenePath ? { scenePath } : {}) };
    if (containsMutation) return executeSceneMutation(client, scenePath!, ops, options);
    return executeOpsChunked(
      (chunk) =>
        needsScenePath
          ? client.executeIdentityBoundOps(chunk, options)
          : client.executeOps(chunk, options),
      ops,
      resolveSingleOnlyOps(client)
    );
  }),

  // --- scene scripting ---
  entry("summer_run_script", "Run a GDScript func run(ctx) inside the live editor against the open scene", true, async (args, ctx) => {
    const client = await ctx.engine();
    const missing = missingEngineOpResult(client, "RunSceneScript", RUN_SCRIPT_FALLBACK);
    if (missing) refuseMissingOp(missing);
    const undo = optStr(args, "undo");
    const { op, timeoutMs } = buildRunSceneScriptOp({
      source: str(args, "source"),
      max_seconds: typeof args.max_seconds === "number" ? args.max_seconds : undefined,
      checkpoint: typeof args.checkpoint === "boolean" ? args.checkpoint : undefined,
      undo: undo === "action" || undo === "none" ? undo : undefined,
    });
    return requireSupportedOp(
      await client.executeIdentityBoundOps([op], undefined, timeoutMs),
      "RunSceneScript",
      RUN_SCRIPT_FALLBACK
    );
  }),
  entry("summer_run_editor_script", "Run an EditorScript in a fresh headless child editor against the on-disk project", true, async (args, ctx) => {
    const client = await ctx.engine();
    const missing = missingEngineOpResult(client, "RunEditorScript", RUN_EDITOR_SCRIPT_FALLBACK);
    if (missing) refuseMissingOp(missing);
    const { op, timeoutMs } = buildRunEditorScriptOp({
      source: str(args, "source"),
      max_seconds: typeof args.max_seconds === "number" ? args.max_seconds : undefined,
      checkpoint: typeof args.checkpoint === "boolean" ? args.checkpoint : undefined,
    });
    return requireSupportedOp(
      await client.executeIdentityBoundOps([op], undefined, timeoutMs),
      "RunEditorScript",
      RUN_EDITOR_SCRIPT_FALLBACK
    );
  }),
  entry("summer_api_docs", "Offline engine class-reference lookup (properties, methods, signals, constants)", false, async (args) =>
    lookupApiDocs(str(args, "class_name"), optStr(args, "member"))
  ),

  // --- perception ---
  entry("summer_world_snapshot", "Structured snapshot of the edited scene (transforms, AABBs, fingerprints, counts)", true, async (args, ctx) => {
    const client = await ctx.engine();
    const missing = missingEngineOpResult(client, "GetWorldSnapshot", WORLD_SNAPSHOT_FALLBACK);
    if (missing) refuseMissingOp(missing);
    const op: DispatchArgs = { op: "GetWorldSnapshot" };
    if (optStr(args, "scene_path")) op.scene_path = args.scene_path;
    if (typeof args.max_nodes === "number") op.max_nodes = args.max_nodes;
    return requireSupportedOp(await client.executeOps([op]), "GetWorldSnapshot", WORLD_SNAPSHOT_FALLBACK);
  }),
  entry("summer_snapshot_diff", "Diff two world snapshots into added/removed/changed nodes and count deltas", true, async (args, ctx) => {
    const client = await ctx.engine();
    const missing = missingEngineOpResult(client, "DiffWorldSnapshot", SNAPSHOT_DIFF_FALLBACK);
    if (missing) refuseMissingOp(missing);
    const op: DispatchArgs = { op: "DiffWorldSnapshot", from_id: str(args, "from_id") };
    if (optStr(args, "to_id")) op.to_id = args.to_id;
    return requireSupportedOp(await client.executeOps([op]), "DiffWorldSnapshot", SNAPSHOT_DIFF_FALLBACK);
  }),
  entry("summer_get_runtime_tree", "Scene tree of the RUNNING game (live runtime state)", true, async (args, ctx) => {
    const client = await ctx.engine();
    const missing = missingEngineOpResult(client, "GetRuntimeSceneTree", RUNTIME_TREE_FALLBACK);
    if (missing) refuseMissingOp(missing);
    const op: DispatchArgs = { op: "GetRuntimeSceneTree" };
    if (optStr(args, "path")) op.path = args.path;
    if (typeof args.depth === "number") op.depth = args.depth;
    if (typeof args.limit === "number") op.limit = args.limit;
    return requireSupportedOp(await client.executeOps([op]), "GetRuntimeSceneTree", RUNTIME_TREE_FALLBACK);
  }),
  entry("summer_inspect_runtime_node", "Live properties of one node in the RUNNING game", true, async (args, ctx) => {
    const client = await ctx.engine();
    const missing = missingEngineOpResult(client, "GetRuntimeNode", RUNTIME_NODE_FALLBACK);
    if (missing) refuseMissingOp(missing);
    return requireSupportedOp(
      await client.executeOps([{ op: "GetRuntimeNode", path: str(args, "path") }]),
      "GetRuntimeNode",
      RUNTIME_NODE_FALLBACK
    );
  }),

  // --- spatial / world building ---
  entry("summer_test_placement", "Ghost-test one node at a candidate global pose (read-only, never saves)", true, async (args, ctx) => {
    const client = await requireSpatialOp(ctx, "TestPlacement3D", TEST_PLACEMENT_FALLBACK);
    const scenePath = exactPath(args, "scenePath", SPATIAL_SCENE_PATH_LIMIT_BYTES);
    const maxFloorDistance = optNumber(args, "maxFloorDistance", 5);
    if (maxFloorDistance < 0.001) throw new ToolDispatchError("maxFloorDistance must be at least 0.001.");
    return requireSupportedOp(
      await client.executeIdentityBoundOps(
        [
          {
            op: "TestPlacement3D",
            subject_path: exactPath(args, "subjectPath", SPATIAL_NODE_PATH_LIMIT_BYTES),
            candidate_global_position: finiteVector3(args, "candidateGlobalPosition"),
            candidate_global_rotation_degrees: finiteVector3(args, "candidateGlobalRotationDegrees"),
            collision_mask: optNumber(args, "collisionMask", 0xffffffff),
            collide_with_areas: optBoolean(args, "collideWithAreas", true),
            max_floor_distance: maxFloorDistance,
            ground_tolerance: optNumber(args, "groundTolerance", 0.05),
            margin: optNumber(args, "margin", 0.001),
          },
        ],
        { scenePath }
      ),
      "TestPlacement3D",
      TEST_PLACEMENT_FALLBACK
    );
  }),
  entry("summer_snap_to_surface", "Seat one subject on the first surface along a world ray (mutation + save)", true, async (args, ctx) => {
    const client = await requireSpatialOp(ctx, "SnapToSurface", SNAP_TO_SURFACE_FALLBACK);
    const scenePath = exactPath(args, "scenePath", SPATIAL_SCENE_PATH_LIMIT_BYTES);
    const direction = finiteVector3(args, "direction", [0, -1, 0]);
    if (direction.reduce((sum, n) => sum + n * n, 0) <= 0.00001) {
      throw new ToolDispatchError("direction squared length must exceed 0.00001.");
    }
    const maxDistance = optNumber(args, "maxDistance", 20);
    const gap = optNumber(args, "gap", 0);
    if (maxDistance <= 0) throw new ToolDispatchError("maxDistance must be positive.");
    if (gap < 0 || gap > maxDistance) throw new ToolDispatchError("gap must be >= 0 and must not exceed maxDistance.");
    return requireSupportedOp(
      await executeSceneMutation(client, scenePath, [
        {
          op: "SnapToSurface",
          subject_path: exactPath(args, "subjectPath", SPATIAL_NODE_PATH_LIMIT_BYTES),
          direction,
          max_distance: maxDistance,
          gap,
          align_up: optBoolean(args, "alignUp", false),
        },
      ]),
      "SnapToSurface",
      SNAP_TO_SURFACE_FALLBACK
    );
  }),
  entry("summer_align_distribute_3d", "Align or equal-space 2-16 ordered subjects along one world axis (mutation + save)", true, async (args, ctx) => {
    const client = await requireSpatialOp(ctx, "AlignDistribute3D", ALIGN_DISTRIBUTE_FALLBACK);
    const scenePath = exactPath(args, "scenePath", SPATIAL_SCENE_PATH_LIMIT_BYTES);
    const axis = finiteVector3(args, "axis");
    if (Math.hypot(...axis) <= 1e-6) throw new ToolDispatchError("axis must be non-zero.");
    const mode = str(args, "mode");
    if (!["align_min", "align_center", "align_max", "distribute_centers", "distribute_gaps"].includes(mode)) {
      throw new ToolDispatchError("mode must be one of align_min, align_center, align_max, distribute_centers, distribute_gaps.");
    }
    return requireSupportedOp(
      await executeSceneMutation(client, scenePath, [
        { op: "AlignDistribute3D", subject_paths: exactSubjectPaths(args, 2, 16), axis, mode },
      ]),
      "AlignDistribute3D",
      ALIGN_DISTRIBUTE_FALLBACK
    );
  }),
  entry("summer_frame_camera", "Move one perspective Camera3D to frame 1-8 subjects at an explicit aspect (mutation + save)", true, async (args, ctx) => {
    const client = await requireSpatialOp(ctx, "FrameCamera3D", FRAME_CAMERA_FALLBACK);
    const scenePath = exactPath(args, "scenePath", SPATIAL_SCENE_PATH_LIMIT_BYTES);
    const aspect = optNumber(args, "aspect", Number.NaN);
    if (!(aspect > 0)) throw new ToolDispatchError("aspect is required and must be a positive finite number.");
    const padding = optNumber(args, "padding", Number.NaN);
    if (!(padding >= 0 && padding <= 0.45)) throw new ToolDispatchError("padding is required and must be from 0 through 0.45.");
    const op: DispatchArgs = {
      op: "FrameCamera3D",
      camera_path: exactPath(args, "cameraPath", SPATIAL_NODE_PATH_LIMIT_BYTES),
      subject_paths: exactSubjectPaths(args, 1, 8),
      aspect,
      padding,
    };
    if (args.viewDirection !== undefined) {
      const viewDirection = finiteVector3(args, "viewDirection");
      if (viewDirection.reduce((sum, n) => sum + n * n, 0) <= 1e-12) {
        throw new ToolDispatchError("viewDirection must be finite and nonzero.");
      }
      op.view_direction = viewDirection;
    }
    return requireSupportedOp(
      await executeSceneMutation(client, scenePath, [op]),
      "FrameCamera3D",
      FRAME_CAMERA_FALLBACK
    );
  }),
  entry("summer_camera_visibility", "Read-only framing + sampled occlusion check for up to 5 subjects from one camera", true, async (args, ctx) => {
    const client = await requireSpatialOp(ctx, "CameraVisibility3D", CAMERA_VISIBILITY_FALLBACK);
    const scenePath = exactPath(args, "scenePath", SPATIAL_SCENE_PATH_LIMIT_BYTES);
    const aspect = optNumber(args, "aspect", Number.NaN);
    if (!(aspect > 0)) throw new ToolDispatchError("aspect is required and must be a positive finite number.");
    const occlusionSamples = optNumber(args, "occlusionSamples", 5);
    if (!Number.isInteger(occlusionSamples) || occlusionSamples < 1 || occlusionSamples > 5) {
      throw new ToolDispatchError("occlusionSamples must be an integer from 1 through 5.");
    }
    return requireSupportedOp(
      await client.executeIdentityBoundOps(
        [
          {
            op: "CameraVisibility3D",
            camera_path: exactPath(args, "cameraPath", SPATIAL_NODE_PATH_LIMIT_BYTES),
            subject_paths: exactSubjectPaths(args, 1, 5),
            aspect,
            occlusion_samples: occlusionSamples,
            collision_mask: optNumber(args, "collisionMask", 0xffffffff),
            collide_with_areas: optBoolean(args, "collideWithAreas", false),
          },
        ],
        { scenePath }
      ),
      "CameraVisibility3D",
      CAMERA_VISIBILITY_FALLBACK
    );
  }),
  entry("summer_navigation_probe", "Read-only navigation reachability between two world points on the scene's nav map", true, async (args, ctx) => {
    const client = await requireSpatialOp(ctx, "NavigationProbe3D", NAVIGATION_PROBE_FALLBACK);
    const scenePath = exactPath(args, "scenePath", SPATIAL_SCENE_PATH_LIMIT_BYTES);
    const navigationLayers = optNumber(args, "navigationLayers", 1);
    if (!Number.isInteger(navigationLayers) || navigationLayers < 1 || navigationLayers > 0xffffffff) {
      throw new ToolDispatchError("navigationLayers must be an integer from 1 through 4294967295.");
    }
    return requireSupportedOp(
      await client.executeIdentityBoundOps(
        [
          {
            op: "NavigationProbe3D",
            start: finiteVector3(args, "start"),
            end: finiteVector3(args, "end"),
            navigation_layers: navigationLayers,
            optimize: optBoolean(args, "optimize", true),
          },
        ],
        { scenePath }
      ),
      "NavigationProbe3D",
      NAVIGATION_PROBE_FALLBACK
    );
  }),
  entry("summer_starcast", "Read-only 26-direction spatial rundown around one exact node: clearance, contacts, grounding (never saves)", true, async (args, ctx) => {
    const client = await requireSpatialOp(ctx, "Starcast3D", STARCAST_FALLBACK);
    const scenePath = exactPath(args, "scenePath", SPATIAL_SCENE_PATH_LIMIT_BYTES);
    const detail = optStr(args, "detail") ?? "summary";
    if (detail !== "summary" && detail !== "full") {
      throw new ToolDispatchError("detail must be one of summary, full.");
    }
    const directionSpace = optStr(args, "directionSpace") ?? "world";
    if (directionSpace !== "world" && directionSpace !== "local") {
      throw new ToolDispatchError("directionSpace must be one of world, local.");
    }
    const maxDistance = optNumber(args, "maxDistance", 20);
    if (maxDistance <= 0 || maxDistance > 10000) throw new ToolDispatchError("maxDistance must be positive and at most 10000.");
    const nearbyRadius = optNumber(args, "nearbyRadius", 10);
    if (nearbyRadius < 0 || nearbyRadius > 10000) throw new ToolDispatchError("nearbyRadius must be from 0 through 10000.");
    const collisionMask = optNumber(args, "collisionMask", 0xffffffff);
    if (!Number.isInteger(collisionMask) || collisionMask < 0 || collisionMask > 0xffffffff) {
      throw new ToolDispatchError("collisionMask must be an integer from 0 through 4294967295.");
    }
    const maxHitsPerDirection = optNumber(args, "maxHitsPerDirection", 3);
    if (!Number.isInteger(maxHitsPerDirection) || maxHitsPerDirection < 1 || maxHitsPerDirection > 8) {
      throw new ToolDispatchError("maxHitsPerDirection must be an integer from 1 through 8.");
    }
    const maxResults = optNumber(args, "maxResults", 64);
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 128) {
      throw new ToolDispatchError("maxResults must be an integer from 1 through 128.");
    }
    const margin = optNumber(args, "margin", 0.001);
    if (margin < 0 || margin > 1) throw new ToolDispatchError("margin must be from 0 through 1.");
    return requireSupportedOp(
      await client.executeIdentityBoundOps(
        [
          {
            op: "Starcast3D",
            path: exactPath(args, "path", SPATIAL_NODE_PATH_LIMIT_BYTES),
            detail,
            max_distance: maxDistance,
            nearby_radius: nearbyRadius,
            direction_space: directionSpace,
            collision_mask: collisionMask,
            collide_with_areas: optBoolean(args, "collideWithAreas", true),
            max_hits_per_direction: maxHitsPerDirection,
            max_results: maxResults,
            margin,
          },
        ],
        { scenePath }
      ),
      "Starcast3D",
      STARCAST_FALLBACK
    );
  }),

  // --- visual ---
  entry("summer_screenshot", "Capture an editor viewport, scene render, or game frame to a file", true, async (args, ctx) => {
    const client = await ctx.engine();
    const target = optStr(args, "target") ?? "viewport";
    let snap: EngineSnapshot;
    if (target === "game") {
      snap = await client.gameSnapshot();
    } else if (target === "scene") {
      snap = await client.scenePreview({
        scenePath: optStr(args, "scenePath"),
        framing: optStr(args, "framing") as never,
        size: Array.isArray(args.size) ? (args.size as [number, number]) : undefined,
        nodePath: optStr(args, "nodePath"),
      });
    } else {
      snap = await client.viewportSnapshot();
    }
    return snapshotResult(snap, target);
  }),

  // --- feedback ---
  entry("summer_library_feedback", "Report library entry outcomes so Summer can fix and re-rank them", false, async (args) => {
    if (!Array.isArray(args.reports) || args.reports.length === 0) {
      throw new ToolDispatchError("reports must be a non-empty array of outcome reports");
    }
    const engineVersion = str(args, "engine_version");
    return sendLibraryFeedback({
      reports: args.reports as LibraryFeedbackReport[],
      engine_version: engineVersion,
      // Self-reported model id; "unknown" is the documented CLI default when
      // the calling agent does not identify itself.
      agent_model: optStr(args, "agent_model") ?? "unknown",
    });
  }),
];

// ---------------------------------------------------------------------------
// Lookup API
// ---------------------------------------------------------------------------
const BY_KEY = new Map<string, ToolDispatchEntry>();
for (const dispatchEntry of TOOL_DISPATCH) {
  for (const key of [dispatchEntry.slug, dispatchEntry.name]) {
    if (BY_KEY.has(key)) {
      throw new Error(`Duplicate tool dispatch key: ${key}`);
    }
    BY_KEY.set(key, dispatchEntry);
  }
}

export function listToolDispatches(): readonly ToolDispatchEntry[] {
  return TOOL_DISPATCH;
}

/** Resolve by library slug ("add-node"), MCP name ("summer_add_node"), or the
 *  underscore-less mixed forms users type ("add_node", "summer-add-node"). */
export function resolveToolDispatch(nameOrSlug: string): ToolDispatchEntry | null {
  const raw = nameOrSlug.trim();
  const candidates = [
    raw,
    raw.replace(/_/g, "-"),
    raw.replace(/-/g, "_"),
    raw.replace(/^summer[-_]/, "").replace(/_/g, "-"),
    raw.replace(/^tool\//, ""),
  ];
  for (const candidate of candidates) {
    const hit = BY_KEY.get(candidate);
    if (hit) return hit;
  }
  return null;
}

export async function dispatchTool(
  nameOrSlug: string,
  args: DispatchArgs,
  ctx: ToolDispatchContext = createDefaultDispatchContext()
): Promise<unknown> {
  const dispatchEntry = resolveToolDispatch(nameOrSlug);
  if (!dispatchEntry) {
    throw new ToolDispatchError(
      `Unknown tool "${nameOrSlug}". Run 'summer tool --list' to see all ${TOOL_DISPATCH.length} tools.`
    );
  }
  return dispatchEntry.handler(args, ctx);
}
