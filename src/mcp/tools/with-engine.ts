import { getClient, resetClient } from "../server.js";
import { recordMcpSession } from "../../lib/telemetry.js";

type ToolResultContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

type ToolResult = { content: ToolResultContent[]; isError?: boolean };

/** Options for {@link withEngine}. `toContent` maps a successful engine result
 *  to MCP content blocks — used by the screenshot tool to hand the raw frame
 *  back as an image block instead of JSON-stringified text. Only runs on genuine
 *  success (after extractOpError clears); failures still surface as text. */
export interface WithEngineOptions<T> {
  toContent?: (result: T) => ToolResultContent[];
}

type OpResult = {
  ok?: boolean;
  status?: string;
  error?: string;
  terminalState?: string;
  errorClass?: string;
  results?: Array<{ ok?: boolean; op?: string; error?: string }>;
};

// 0.5.34 Block E contract (publicsummerengine src/lib/tools/contract.ts §0.1).
// The async lifecycle (async-op-lifecycle.ts pollOpToTerminal) merges
// terminalState/errorClass onto the apply dict it returns. ONLY these two are
// "applied something / applied nothing-on-purpose" — every other terminal state
// means the op did NOT land and must be surfaced as a failure, not masked.
const SUCCESS_TERMINAL_STATES: ReadonlySet<string> = new Set(["applied", "no_op"]);

// Human-readable fallback when the engine reports a failure terminalState but no
// `error` string (queue-full / lease-reject / identity-mismatch / no-progress
// timeout frequently arrive with terminalState set and results[] absent).
const TERMINAL_STATE_MESSAGES: Record<string, string> = {
  timed_out: "Engine operation timed out (terminalState: timed_out). Nothing was applied.",
  not_connected: "Summer Engine is not connected (terminalState: not_connected). Nothing was applied.",
  identity_mismatch:
    "Operation rejected — wrong project/instance (terminalState: identity_mismatch). Nothing was mutated.",
  content_mismatch:
    "Operation rejected — content changed since last read (terminalState: content_mismatch). Nothing was applied.",
  denied: "Operation denied (terminalState: denied). Nothing was applied.",
  canceled: "Operation canceled (terminalState: canceled). Nothing was applied.",
};

/**
 * Decide whether an engine result envelope represents a FAILURE, and if so
 * return a model-visible message. Returns null only for genuine success.
 *
 * Guards the two web bug classes (publicsummerengine cf17134f + contract.ts
 * `isFailureSignal`):
 *   - a failure `terminalState` (anything other than applied/no_op) is a failure
 *     even when results[] is absent — the cf17134f "no-results envelope looked
 *     applied" masking. The poll loop surfaces timed_out/etc. here.
 *   - an explicit ok:false / status:"error" / failed op inside results[].
 *
 * Exported for unit tests.
 */
export function extractOpError(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const op = result as OpResult;

  // Failure terminalState takes precedence — it is set by the async lifecycle
  // exactly when the op did not land (timeout, backpressure, lease/identity
  // rejection, cancellation), often with NO results[] to inspect.
  const ts = op.terminalState;
  if (typeof ts === "string" && ts.length > 0 && !SUCCESS_TERMINAL_STATES.has(ts)) {
    if (typeof op.error === "string" && op.error.length > 0) return op.error;
    return TERMINAL_STATE_MESSAGES[ts] ?? `Engine operation failed (terminalState: ${ts}).`;
  }

  // An explicit ok:false / status:"error" is a failure even when the engine
  // omitted an error string — surface it rather than mask it (matches the web
  // contract `isFailureSignal`).
  if (op.ok === false) return op.error || "Engine operation failed (ok: false).";
  if (op.status === "error") return op.error || "Engine operation failed (status: error).";
  const firstFailed = op.results?.find((r) => r.ok === false);
  if (firstFailed) {
    return firstFailed.error || `Engine op failed${firstFailed.op ? ` (${firstFailed.op})` : ""}.`;
  }
  return null;
}

/**
 * An auth failure is the ONE class of thrown error that is provably pre-apply:
 * the engine rejects on the Bearer-token check (tool_net_thread.cpp::_validate_auth)
 * BEFORE the op is queued or applied, so reconnecting with the fresh api-token and
 * retrying cannot double-apply a mutation. This is exactly the stale-token case
 * after the engine rotates its api-token on relaunch.
 *
 * Deliberately NARROW. A generic connection error (ECONNREFUSED / "fetch failed")
 * thrown from inside the tool closure is NOT retriable here, because it may be a
 * disconnect mid-operation where a mutation already partially applied — and the
 * MCP sends no idempotency key the engine can dedup on, so a blind retry would
 * re-apply it. The restart-between-calls case is handled proactively by
 * getClient()'s credential-drift check; the connect/preflight-failure case is
 * retried separately in withEngine (nothing is submitted there).
 *
 * Exported for unit tests.
 */
export function isAuthError(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return m.includes("401") || m.includes("403") || m.includes("unauthorized");
}

function buildActionHint(message: string): string | null {
  const normalized = message.toLowerCase();

  if (normalized.includes("no scene open") || normalized.includes("no edited scene")) {
    return "No scene is currently open. Call `summer_get_project_context` first, then `summer_open_main_scene` (or `summer_open_scene` with a known .tscn path).";
  }

  if (normalized.includes("failed to open scene")) {
    return "Scene path could not be opened. Call `summer_get_project_context` to get `mainScene`, then open that exact path. Avoid guessing scene filenames.";
  }

  if (normalized.includes("writefile cannot edit .tscn/.scn")) {
    return "Write .gd/.cs/.json/docs/simple config files with normal file-edit tools. Use Summer MCP for live scene state, inspector/node edits, imports, play/stop, diagnostics, and visual verification.";
  }

  return null;
}

export async function withEngine<T>(
  fn: (client: Awaited<ReturnType<typeof getClient>>) => Promise<T>,
  opts?: WithEngineOptions<T>
): Promise<ToolResult> {
  // Best-effort, fire-and-forget: count this MCP session as DAU for attribution.
  // No await, no throw, no quota gating.
  recordMcpSession();

  // The engine rotates its api-token (and can move ports) on every launch. The
  // proactive credential-drift check in getClient() reconnects when a restart
  // happened BETWEEN calls; this loop only covers the race where the restart
  // lands DURING a call. We retry ONLY where nothing could have been applied:
  //   - a connect/preflight failure (getClient threw — request never submitted)
  //   - a stale-token 401/403 (engine rejects at auth, before queue/apply)
  // A generic connection error thrown from inside fn() is NOT retried: it may be
  // a disconnect mid-operation where a mutation already partially applied, and
  // the MCP sends no idempotency key the engine can dedup on. A soft failure
  // terminal state (e.g. identity_mismatch from a project switch) is surfaced,
  // never silently retried — a retry cannot fix a project switch.
  const MAX_ATTEMPTS = 2;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let client: Awaited<ReturnType<typeof getClient>>;
    try {
      client = await getClient();
    } catch (err) {
      // Pre-submission: the request never went out, so reconnect and retry.
      resetClient();
      lastError = err;
      if (attempt < MAX_ATTEMPTS) continue;
      break;
    }

    try {
      const result = await fn(client);
      const opError = extractOpError(result);
      if (opError) {
        const hint = buildActionHint(opError);
        const message = hint ? `${opError}\n\nHint: ${hint}` : opError;
        return { content: [{ type: "text", text: message }], isError: true };
      }
      if (opts?.toContent) {
        return { content: opts.toContent(result) };
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      // Drop the cached client (it may point at a dead/rotated engine). Retry
      // once only for a provably pre-apply auth failure; anything else surfaces.
      resetClient();
      lastError = err;
      if (attempt < MAX_ATTEMPTS && isAuthError(err)) continue;
      break;
    }
  }

  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  return { content: [{ type: "text", text: msg }], isError: true };
}
