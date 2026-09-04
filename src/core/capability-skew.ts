/**
 * Engine/CLI capability handshake.
 *
 * The MCP server and the engine build ship separately, so the tool surface can
 * outrun the engine in the field. Newer engines advertise their dispatchable
 * op kinds (and a protocol version) in /api/health `capabilities`. Two uses:
 *
 *   1. summer_get_project_context compares the advertised `opKinds` against
 *      the ops this CLI's tools send and surfaces a ONE-LINE, NON-FATAL
 *      warning (plus one mcp.log line per process).
 *   2. Tools whose op the engine does not advertise return a STRUCTURED
 *      "engine lacks op X (engine version Y); update the engine" result
 *      BEFORE sending anything, instead of a raw "unknown op" error.
 *
 * Engines that predate `capabilities.opKinds` stay silent on both paths — an
 * absent list proves nothing, and the per-tool "unknown op" hints still cover
 * the failure at call time.
 */

/** Protocol generation this CLI speaks. Bump only alongside a real wire
 *  change; used purely for the skew warning, never to refuse a connection. */
export const CLI_PROTOCOL_VERSION = 1;

/**
 * Every engine op kind this package's tools CONSTRUCT themselves (every
 * `op: "<Kind>"` literal under src/, MCP tools and the CLI dispatcher alike).
 * capability-skew.test.ts scans the sources and fails when a literal is
 * missing here; src/core/op-registry-drift.test.ts guards the other direction
 * inside the engine monorepo (never send an op the engine has no branch for).
 *
 * Deliberately NOT listed: ops an agent may compose by hand through
 * summer_batch / `summer tool batch` (MoveNode, ReparentNode, DisconnectSignal,
 * Undo, Git*, RunCommand, ExtractZipFromUrl, CustomBake, ...). The CLI only
 * classifies those for dispatch (single-only / scene-mutation sets) and never
 * sends them on its own, so listing them would warn about skew the CLI cannot
 * cause; the engine's per-op "unknown op" error still covers them at call time.
 */
export const CLI_KNOWN_OP_NEEDS: readonly string[] = [
  // Scene graph + properties
  "AddNode", "RemoveNode", "ReplaceNode", "SetProp", "SetResourceProperty",
  "ConnectSignal", "SelectNode", "OpenScene", "SaveScene", "InstantiateScene",
  // Navigation (summer_open: core/capabilities/navigation/) — Navigate is the
  // one-table op (engine navigate_ops.cpp); the other three are the legacy
  // fallbacks on engines that predate it.
  "Navigate", "OpenResource", "FocusDock", "RevealInFileSystem",
  // Project + input
  "ProjectSetting", "InputMapAddAction", "InputMapBind",
  // Files (summer_write_file / summer_replace_text / summer_create_scene)
  "WriteFile",
  // Import
  "ImportFromUrl", "ImportFromUrlBatch",
  // Diagnostics + runtime control
  "GetConsoleOutput", "ClearConsoleOutput", "GetDebuggerErrors", "IsGameRunning",
  // summer_play / summer_stop send these as ops for the instance-aware and
  // determinism variants (seed / fixed_fps / time_scale, instance / mode) —
  // the legacy /api/play route forwards only `scene`, so the plain launch
  // stays there.
  "PlayGame", "StopGame",
  // Wave I runtime control & playtest ops (summer_runtime_* / summer_game_*)
  "SetRuntimeProp", "CallRuntimeMethod", "SpawnRuntimeScene", "FreeRuntimeNode",
  "RuntimeAnimation", "RuntimeAnimationTree", "GetRuntimeBones",
  "GamePause", "GameStep", "GameSpeed",
  "SimulateInputScript", "InputRecordStart", "InputRecordStop", "InputReplay",
  "GameProbe", "ListGameInstances",
  // Capture (+ camera bookmarks: summer_camera_bookmark, wave I perception)
  "ViewportSnapshot", "GameSnapshot", "ScenePreview",
  "SaveCameraBookmark", "ListCameraBookmarks", "DeleteCameraBookmark",
  // Scripting + verification
  "RunSceneScript", "RunEditorScript", "RunVerification", "SimulateInput",
  // Perception
  "GetWorldSnapshot", "DiffWorldSnapshot", "GetRuntimeSceneTree", "GetRuntimeNode",
  // Spatial / world building
  "TestPlacement3D", "SnapToSurface", "AlignDistribute3D", "NavigationProbe3D",
  "Starcast3D",
  // Mesh fabrication (summer_fabricate_3d — the user's own Blender, engine-supervised)
  "FabricateMesh",
  // Editor UI control (wave L: summer_ui_actions / summer_ui_tree /
  // summer_ui_activate / summer_ui_screenshot). All synchronous and
  // batchable — none joins the single-only set.
  "UiListActions", "UiInvoke", "UiTree", "UiActivate", "UiScreenshot",
  "UiDialogs", "UiDismissDialog",
];

/** The `capabilities` block of /api/health, shape-checked. Every field is
 *  optional: an older engine advertises none of them. */
/**
 * Escape hatch for the capability pre-flight. The op advert and the ops
 * themselves ship on different engine branches, so an engine can IMPLEMENT an
 * op it does not yet ADVERTISE; with the pre-flight on, such a tool would be
 * refused before sending. `SUMMER_CAPABILITY_PREFLIGHT=off` sends every call
 * and lets the engine's own "unknown op" error decide. The skew warning still
 * prints (it is informational) but notes that the pre-flight is off.
 */
export const CAPABILITY_PREFLIGHT_ENV = "SUMMER_CAPABILITY_PREFLIGHT";

export function isCapabilityPreflightDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[CAPABILITY_PREFLIGHT_ENV]?.trim().toLowerCase();
  return raw === "off" || raw === "0" || raw === "false";
}

const PREFLIGHT_OFF_HINT =
  `If your engine build implements this op but does not advertise it yet, set ${CAPABILITY_PREFLIGHT_ENV}=off in the MCP server's environment to skip this pre-flight and let the engine answer.`;

/**
 * The `events` block of /api/health `capabilities` — the engine's events
 * channel advert (GET /api/events SSE + GET /api/events/poll long-poll).
 * Present only on builds that ship the channel; every field is optional so a
 * partial advert still counts as "the channel exists".
 */
export interface EngineEventsCapability {
  /** Event kinds this build emits (op.applied, play.started, ...). */
  kinds?: string[];
  ring?: number;
  retainMs?: number;
  maxPayloadBytes?: number;
  sse?: boolean;
  poll?: boolean;
  maxStreams?: number;
  heartbeatMs?: number;
}

export interface EngineCapabilities {
  protocolVersion?: number;
  /** Full dispatch-ladder op set. Absent = engine predates the advert. */
  opKinds?: string[];
  /** Ops that must travel as their own single-op request. Absent = use the
   *  CLI's hardcoded list. */
  singleOnlyOps?: string[];
  /** Events channel advert. Absent = the build has no events channel (the
   *  channel and its advert ship together, so absence IS proof here). */
  events?: EngineEventsCapability;
  /** Wave I runtime control advert: the runtime op kinds, whether the game-side
   *  `summer` capture ships, and the offscreen instance cap. Absent = engine
   *  predates runtime control (or advertises the kinds only in opKinds). */
  runtimeControl?: EngineRuntimeControlCapabilities;
  /** Editor navigation advert (engine `Navigate` op, navigate_ops.cpp): the
   *  destination ids this build can open. Absent = engine predates the op;
   *  summer_open then falls back to the legacy per-surface ops it can map. */
  navigation?: EngineNavigationCapabilities;
  /** Launch postures this build ENFORCES: "focus" (always), "background"
   *  (`--summer-background`), "offscreen" (`--summer-offscreen` /
   *  `--summer-verify`). Non-macOS builds advertise ["focus"] only. Absent =
   *  engine predates the advert, read as ["focus"]; `summer run` then relies on
   *  the --help probe / version gate (core/launch-posture.ts). Accepts the
   *  snake_case spelling too. */
  launchPostures?: string[];
}

export interface EngineNavigationCapabilities {
  version?: number;
  targets: EngineNavigationTarget[];
}

export interface EngineNavigationTarget {
  id: string;
  title?: string;
  args?: string[];
}

export interface EngineRuntimeControlCapabilities {
  ops?: string[];
  summerCapture?: boolean;
  maxOffscreenInstances?: number;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Parse a raw `capabilities.events` value. Any plain object counts as an
 *  advert (an engine may advertise `events: {}`); anything else is "absent". */
function parseEventsCapability(raw: unknown): EngineEventsCapability | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const out: EngineEventsCapability = {};
  const kinds = stringList(record.kinds);
  if (kinds) out.kinds = kinds;
  for (const key of ["ring", "retainMs", "maxPayloadBytes", "maxStreams", "heartbeatMs"] as const) {
    const value = finiteNumber(record[key]);
    if (value !== undefined) out[key] = value;
  }
  for (const key of ["sse", "poll"] as const) {
    if (typeof record[key] === "boolean") out[key] = record[key] as boolean;
  }
  return out;
}

function parseRuntimeControl(raw: unknown): EngineRuntimeControlCapabilities | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const out: EngineRuntimeControlCapabilities = {};
  const ops = stringList(record.ops);
  if (ops) out.ops = ops;
  if (typeof record.summerCapture === "boolean") out.summerCapture = record.summerCapture;
  if (typeof record.maxOffscreenInstances === "number" && Number.isFinite(record.maxOffscreenInstances)) {
    out.maxOffscreenInstances = record.maxOffscreenInstances;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Every op kind the engine advertises: `opKinds` plus the Wave I
 *  `runtimeControl.ops` block (an engine may list the runtime kinds only
 *  there). Undefined when the engine advertises no op list at all. */
export function advertisedOpKinds(capabilities: EngineCapabilities | undefined | null): Set<string> | undefined {
  if (!capabilities?.opKinds) return undefined;
  return new Set([...capabilities.opKinds, ...(capabilities.runtimeControl?.ops ?? [])]);
}

/** Parse a raw /api/health `capabilities` value. Tolerates any shape; returns
 *  undefined when nothing usable is advertised. Never throws. */
export function parseEngineCapabilities(raw: unknown): EngineCapabilities | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const out: EngineCapabilities = {};

  const rawProtocol = record.protocolVersion;
  const protocolVersion =
    typeof rawProtocol === "number"
      ? rawProtocol
      : typeof rawProtocol === "string" && /^\d+$/.test(rawProtocol)
        ? Number.parseInt(rawProtocol, 10)
        : undefined;
  if (protocolVersion !== undefined) out.protocolVersion = protocolVersion;

  const opKinds = stringList(record.opKinds);
  if (opKinds) out.opKinds = opKinds;
  const singleOnlyOps = stringList(record.singleOnlyOps);
  if (singleOnlyOps) out.singleOnlyOps = singleOnlyOps;
  const events = parseEventsCapability(record.events);
  if (events) out.events = events;
  const runtimeControl = parseRuntimeControl(record.runtimeControl);
  if (runtimeControl) out.runtimeControl = runtimeControl;
  const navigation = parseNavigation(record.navigation);
  if (navigation) out.navigation = navigation;
  const launchPostures = stringList(record.launchPostures) ?? stringList(record.launch_postures);
  if (launchPostures) out.launchPostures = launchPostures;

  return Object.keys(out).length > 0 ? out : undefined;
}

function parseNavigation(raw: unknown): EngineNavigationCapabilities | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.targets)) return undefined;
  const targets: EngineNavigationTarget[] = [];
  for (const entry of record.targets) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || item.id.length === 0) continue;
    const args = stringList(item.args);
    targets.push({
      id: item.id,
      ...(typeof item.title === "string" ? { title: item.title } : {}),
      ...(args ? { args } : {}),
    });
  }
  const version = typeof record.version === "number" ? record.version : undefined;
  return { ...(version !== undefined ? { version } : {}), targets };
}

/**
 * True ONLY when the engine advertises an op list and `op` is not on it. An
 * engine without an advert returns false — we cannot prove absence, so the
 * call goes through and the per-tool "unknown op" hint handles the failure.
 */
export function engineLacksOp(
  capabilities: EngineCapabilities | undefined | null,
  op: string
): boolean {
  const advertised = advertisedOpKinds(capabilities);
  if (!advertised) return false;
  return !advertised.has(op);
}

export interface MissingOpResult {
  ok: false;
  op: string;
  failure_reason: "engine_lacks_op";
  engine_version: string | null;
  error: string;
  hint: string;
}

/**
 * The structured result a tool returns when the engine provably lacks its op.
 * Shaped like an engine op failure ({ok:false, op, error, failure_reason}) so
 * withEngine/extractOpError classify it the same way, and the model reads the
 * upgrade path instead of retrying.
 */
export function buildMissingOpResult(
  op: string,
  engineVersion: string | null | undefined,
  fallback: string
): MissingOpResult {
  const version = engineVersion ?? null;
  return {
    ok: false,
    op,
    failure_reason: "engine_lacks_op",
    engine_version: version,
    error:
      `This Summer Engine build${version ? ` (engine version ${version})` : ""} does not support the ${op} op — ` +
      "nothing was sent. Update Summer Engine (restart it after updating). " +
      `Until then: ${fallback}. ${PREFLIGHT_OFF_HINT}`,
    hint: `${fallback}. ${PREFLIGHT_OFF_HINT}`,
  };
}

// ---------------------------------------------------------------------------
// Events channel pre-flight (a capability, not an op — deliberately NOT folded
// into CLI_KNOWN_OP_NEEDS / engineLacksOp)
// ---------------------------------------------------------------------------

/**
 * True when the engine does NOT advertise the events channel. Unlike ops,
 * where an absent `opKinds` list proves nothing (ops predate the advert), the
 * events channel and its `capabilities.events` advert ship together: a build
 * with the channel always advertises it, so absence — including an engine that
 * advertises no capabilities at all — is proof.
 */
export function engineLacksEvents(
  capabilities: EngineCapabilities | undefined | null
): boolean {
  return !capabilities?.events;
}

export interface MissingEventsResult {
  ok: false;
  failure_reason: "engine_lacks_events";
  engine_version: string | null;
  error: string;
  hint: string;
}

/** What the events tools tell the model to do when the channel is missing. */
export const EVENTS_FALLBACK =
  "poll the state you are waiting for instead (summer_is_running after summer_play; summer_get_debugger_errors / summer_get_console for script errors; summer_get_scene_tree after a long op)";

const EVENTS_PREFLIGHT_OFF_HINT =
  `If your engine build serves GET /api/events/poll but does not advertise capabilities.events yet, set ${CAPABILITY_PREFLIGHT_ENV}=off in the MCP server's environment to skip this pre-flight and let the engine answer.`;

/**
 * The structured result an events tool returns when the engine provably lacks
 * the channel. Shaped like buildMissingOpResult ({ok:false, failure_reason,
 * engine_version, error, hint}) so withEngine/extractOpError classify it the
 * same way and `summer tool` prints it whole — but under its own
 * failure_reason, because no op was ever involved.
 */
export function buildMissingEventsResult(
  engineVersion: string | null | undefined,
  fallback: string = EVENTS_FALLBACK
): MissingEventsResult {
  const version = engineVersion ?? null;
  return {
    ok: false,
    failure_reason: "engine_lacks_events",
    engine_version: version,
    error:
      `This Summer Engine build${version ? ` (engine version ${version})` : ""} does not expose the events channel ` +
      "(no capabilities.events in /api/health) — nothing was sent. Update Summer Engine to a build with the events channel " +
      `(restart it after updating). Until then: ${fallback}. ${EVENTS_PREFLIGHT_OFF_HINT}`,
    hint: `${fallback}. ${EVENTS_PREFLIGHT_OFF_HINT}`,
  };
}

/**
 * Capability pre-flight for the events tools (summer_wait_for_event,
 * summer_recent_events, `summer events`). Returns a structured
 * engine_lacks_events result (nothing is sent) when the engine's /api/health
 * advert lacks `capabilities.events`; null when the channel is advertised or
 * the SUMMER_CAPABILITY_PREFLIGHT=off escape hatch is set. Sibling of
 * missingEngineOpResult — kept separate because events are a capability, not
 * an op kind.
 */
export function missingEngineEventsResult(
  client: CapabilityAdvertisingClient,
  fallback: string = EVENTS_FALLBACK
): MissingEventsResult | null {
  if (isCapabilityPreflightDisabled()) return null;
  const capabilities =
    typeof client.getEngineCapabilities === "function"
      ? client.getEngineCapabilities()
      : undefined;
  if (!engineLacksEvents(capabilities)) return null;
  const version =
    typeof client.getEngineVersion === "function" ? client.getEngineVersion() : undefined;
  return buildMissingEventsResult(version ?? null, fallback);
}

/**
 * Build the one-line skew warning from a raw /api/health payload, or null when
 * there is nothing trustworthy to say (no capabilities advertised, or no skew).
 * Shape-tolerant: never throws on odd payloads.
 */
export function buildCapabilitySkewWarning(health: unknown): string | null {
  if (!health || typeof health !== "object") return null;
  const capabilities = parseEngineCapabilities(
    (health as { capabilities?: unknown }).capabilities
  );
  if (!capabilities) return null;

  const parts: string[] = [];

  if (
    capabilities.protocolVersion !== undefined &&
    capabilities.protocolVersion !== CLI_PROTOCOL_VERSION
  ) {
    parts.push(
      `engine protocolVersion ${capabilities.protocolVersion} != CLI protocolVersion ${CLI_PROTOCOL_VERSION}`
    );
  }

  const advertised = advertisedOpKinds(capabilities);
  if (advertised) {
    const missing = CLI_KNOWN_OP_NEEDS.filter((op) => !advertised.has(op));
    if (missing.length > 0) {
      parts.push(
        `engine does not advertise ${missing.length} op(s) this CLI can send (${missing.join(", ")})`
      );
    }
  }

  if (parts.length === 0) return null;
  const preflight = isCapabilityPreflightDisabled()
    ? `Non-fatal — ${CAPABILITY_PREFLIGHT_ENV}=off is set, so affected tools are sent anyway and the engine's own unknown-op error decides.`
    : `Non-fatal — affected tools return a structured engine_lacks_op result instead of running (set ${CAPABILITY_PREFLIGHT_ENV}=off to send them anyway if your engine implements an op it does not advertise).`;
  return (
    `Engine/CLI version skew detected: ${parts.join("; ")}. ` +
    `${preflight} Update Summer Engine (or the summer-engine CLI) so both sides match.`
  );
}

// ---------------------------------------------------------------------------
// Single-only dispatch classification
// ---------------------------------------------------------------------------

/**
 * Engine ops that MUST be dispatched as their own single-op request. Mirrors
 * _summer_requires_single_async_dispatch (local_api_server.cpp, engine
 * 0.5.60+): the engine rejects any multi-op batch containing one of these
 * WHOLESALE — nothing in the batch executes, and the batch fails with per-op
 * failure_reason "unsupported_transport"/"skipped". Git ops are covered by a
 * prefix check in the dispatchers.
 *
 * This hardcoded list is the FALLBACK for engines that predate the
 * /api/health `capabilities.singleOnlyOps` advert; when the engine advertises
 * its own list, that list is authoritative (resolveSingleOnlyOps).
 */
export const FALLBACK_SINGLE_ONLY_OPS: ReadonlySet<string> = new Set([
  "SaveScene", "InstantiateScene", "ReplaceNode",
  "SimulateInput", "ViewportSnapshot", "GameSnapshot",
  // Runtime debugger reads share GameSnapshot's async single-only dispatch
  // classification.
  "GetRuntimeSceneTree", "GetRuntimeNode",
  "RunCommand", "RunVerification", "RunEditorScript", "RunSceneScript",
  "ImportFromUrl", "ImportFromUrlBatch", "ExtractZipFromUrl",
  // Wave K: a headless Blender child on the same async single-op lane as
  // RunEditorScript (local_api_server.cpp SUMMER_SINGLE_ASYNC_OPS).
  "FabricateMesh",
  // Wave I runtime control (RuntimeOps::async_op_kinds): every op below rides
  // the `summer` debugger capture, so like GameSnapshot each needs the async
  // single-op reply channel. ListGameInstances is deliberately NOT here — it
  // is a cheap synchronous editor read that batches fine (runtime_ops.h).
  "SetRuntimeProp", "CallRuntimeMethod", "SpawnRuntimeScene", "FreeRuntimeNode",
  "RuntimeAnimation", "RuntimeAnimationTree", "GetRuntimeBones",
  "GamePause", "GameSpeed", "GameStep",
  "SimulateInputScript", "InputRecordStart", "InputRecordStop", "InputReplay",
  "GameProbe",
]);

/** The subset of EngineApiClient the capability readers use. Structural so
 *  unit tests can pass bare mock clients (no getter = no advert). */
export interface CapabilityAdvertisingClient {
  getEngineCapabilities?: () => EngineCapabilities | undefined;
  getEngineVersion?: () => string | undefined;
}

/** The single-only op set for THIS engine: its advertised
 *  `capabilities.singleOnlyOps` when present, else the hardcoded fallback. An
 *  empty advertised list counts as no advert — never as "everything batches". */
export function resolveSingleOnlyOps(client: CapabilityAdvertisingClient): ReadonlySet<string> {
  const advertised =
    typeof client.getEngineCapabilities === "function"
      ? client.getEngineCapabilities()?.singleOnlyOps
      : undefined;
  return advertised && advertised.length > 0 ? new Set(advertised) : FALLBACK_SINGLE_ONLY_OPS;
}

/**
 * Capability pre-flight for tools that depend on an op an older engine may
 * lack. Returns a structured engine_lacks_op result (nothing is sent) when
 * the engine's /api/health advert PROVES the op is missing; null otherwise —
 * including for engines that advertise nothing, where the per-tool
 * "unknown op" hint still covers the failure at call time.
 */
export function missingEngineOpResult(
  client: CapabilityAdvertisingClient,
  op: string,
  fallback: string
): MissingOpResult | null {
  if (isCapabilityPreflightDisabled()) return null;
  const capabilities =
    typeof client.getEngineCapabilities === "function"
      ? client.getEngineCapabilities()
      : undefined;
  if (!engineLacksOp(capabilities, op)) return null;
  const version =
    typeof client.getEngineVersion === "function" ? client.getEngineVersion() : undefined;
  return buildMissingOpResult(op, version ?? null, fallback);
}
