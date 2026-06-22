import { getClient, resetClient } from "../server.js";
import { recordMcpSession } from "../../lib/telemetry.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

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

// Terminal states where the engine GUARANTEES the op never landed, so dropping
// the cached client and retrying once is safe (no double-mutation). Everything
// else — timed_out (may still be running), content_mismatch / denied / canceled
// (intentional) — must surface, never silently retry.
const RECONNECTABLE_TERMINAL_STATES: ReadonlySet<string> = new Set([
  "not_connected",
  "identity_mismatch",
]);

function terminalStateOf(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const ts = (result as OpResult).terminalState;
  return typeof ts === "string" && ts.length > 0 ? ts : null;
}

/**
 * A thrown transport error is safe to retry only when the engine provably never
 * applied the op: a stale-token rejection (401/403, after the engine rotated its
 * api-token on relaunch) or an unreachable/closed port (connection refused/reset,
 * after the engine moved ports or is mid-restart). A timeout or any 5xx may have
 * mutated, so those surface instead of risking a double-apply on retry.
 *
 * Exported for unit tests.
 */
export function isReconnectableThrow(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (m.includes("timed out") || m.includes("timeout") || m.includes("aborted")) {
    return false;
  }
  return (
    m.includes("401") ||
    m.includes("403") ||
    m.includes("unauthorized") ||
    m.includes("econnrefused") ||
    m.includes("econnreset") ||
    m.includes("fetch failed") ||
    m.includes("not running") ||
    m.includes("not responding")
  );
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
  fn: (client: Awaited<ReturnType<typeof getClient>>) => Promise<T>
): Promise<ToolResult> {
  // Best-effort, fire-and-forget: count this MCP session as DAU for attribution.
  // No await, no throw, no quota gating.
  recordMcpSession();

  // The engine rotates its api-token and can move ports on every launch, so a
  // restart that lands DURING a tool call shows up as a stale-token 401, an
  // ECONNREFUSED on the old port, or a soft not_connected / identity_mismatch
  // terminal state. Drop the cached client and retry ONCE so a transient drop
  // heals itself (getClient reconnects with the fresh creds) instead of
  // surfacing as a "disconnected" error. Only provably-not-applied failures are
  // retried — see RECONNECTABLE_TERMINAL_STATES / isReconnectableThrow.
  const MAX_ATTEMPTS = 2;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const client = await getClient();
      const result = await fn(client);
      const opError = extractOpError(result);
      if (opError) {
        const ts = terminalStateOf(result);
        if (ts && RECONNECTABLE_TERMINAL_STATES.has(ts) && attempt < MAX_ATTEMPTS) {
          resetClient();
          lastError = new Error(opError);
          continue;
        }
        const hint = buildActionHint(opError);
        const message = hint ? `${opError}\n\nHint: ${hint}` : opError;
        return { content: [{ type: "text", text: message }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      // A thrown error means the cached client may be pointed at a dead/rotated
      // engine — always drop it (prior behavior). Retry once only for
      // connection-class throws that provably did not mutate.
      resetClient();
      lastError = err;
      if (attempt < MAX_ATTEMPTS && isReconnectableThrow(err)) {
        continue;
      }
      break;
    }
  }

  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  return { content: [{ type: "text", text: msg }], isError: true };
}
