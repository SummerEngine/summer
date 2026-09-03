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
  // Project + input
  "ProjectSetting", "InputMapAddAction", "InputMapBind",
  // Files (summer_write_file / summer_replace_text / summer_create_scene)
  "WriteFile",
  // Import
  "ImportFromUrl", "ImportFromUrlBatch",
  // Diagnostics + runtime control
  "GetConsoleOutput", "ClearConsoleOutput", "GetDebuggerErrors", "IsGameRunning",
  // Capture
  "ViewportSnapshot", "GameSnapshot", "ScenePreview",
  // Scripting + verification
  "RunSceneScript", "RunEditorScript", "RunVerification", "SimulateInput",
  // Perception
  "GetWorldSnapshot", "DiffWorldSnapshot", "GetRuntimeSceneTree", "GetRuntimeNode",
  // Spatial / world building
  "TestPlacement3D", "SnapToSurface", "AlignDistribute3D", "NavigationProbe3D",
  "Starcast3D",
  // Mesh fabrication (summer_fabricate_3d — the user's own Blender, engine-supervised)
  "FabricateMesh",
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

export interface EngineCapabilities {
  protocolVersion?: number;
  /** Full dispatch-ladder op set. Absent = engine predates the advert. */
  opKinds?: string[];
  /** Ops that must travel as their own single-op request. Absent = use the
   *  CLI's hardcoded list. */
  singleOnlyOps?: string[];
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
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

  return Object.keys(out).length > 0 ? out : undefined;
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
  const advertised = capabilities?.opKinds;
  if (!advertised) return false;
  return !advertised.includes(op);
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

  if (capabilities.opKinds) {
    const advertised = new Set(capabilities.opKinds);
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
