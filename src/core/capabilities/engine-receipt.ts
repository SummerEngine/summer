/**
 * Engine receipt failure semantics — ONE copy, imported by both faces
 * (src/mcp/tools/with-engine.ts and src/core/capabilities/tool-dispatch.ts).
 */

export type OpResult = {
  ok?: boolean;
  status?: string;
  error?: string;
  terminalState?: string;
  errorClass?: string;
  failureReason?: string;
  failure_reason?: string;
  results?: Array<{
    ok?: boolean;
    op?: string;
    error?: string;
    failureReason?: string;
    failure_reason?: string;
  }>;
};

export function getFailureReason(value: {
  failureReason?: string;
  failure_reason?: string;
}): string | undefined {
  return typeof value.failureReason === "string"
    ? value.failureReason
    : typeof value.failure_reason === "string"
      ? value.failure_reason
      : undefined;
}

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
  timed_out:
    "Engine operation timed out. Its final state is unknown; inspect the target before retrying (summer_get_scene_tree / summer_world_snapshot / summer_read_file). To recover: break the work into smaller pieces — several short scripts or batches instead of one long one — raise the tool's max_seconds if it has one, and confirm the engine is still responsive (summer_get_project_context, or `summer doctor` from a shell).",
  still_queued:
    "Summer Engine accepted the operation, but it was still queued when the client stopped waiting. It may still run; do NOT retry blindly — inspect the target first (summer_get_scene_tree / summer_world_snapshot), and if the queue stays stuck check whether the editor is busy (modal dialog, long import) or run `summer doctor`.",
  still_running:
    "Summer Engine accepted and started the operation, but no final receipt arrived. It may still be running or may already have applied; inspect the target before retrying (summer_get_scene_tree / summer_world_snapshot / summer_read_file). For long jobs, split the work into smaller scripts/batches so each finishes inside its budget.",
  uncertain:
    "Summer Engine did not provide a final operation receipt. The current state is uncertain; inspect the target before retrying (summer_get_scene_tree / summer_world_snapshot / summer_read_file), and verify the engine is healthy with summer_get_project_context.",
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
  const firstFailed = op.results?.find((r) => r.ok === false);
  // The engine stamps failure classifiers on the envelope OR per-op inside
  // results[] (the batch gate does the latter) — read both.
  const failureReason = getFailureReason(op) ?? (firstFailed ? getFailureReason(firstFailed) : undefined);

  // Classified failures are rendered as JSON so callers can reliably read
  // failure_reason instead of scraping a sentence. A plain-text "Hint:" line may
  // follow the JSON in the final tool text. Unclassified failures stay plain.
  const classify = (message: string): string => {
    if (!failureReason) return message;
    return JSON.stringify(
      {
        error: message,
        failure_reason: failureReason,
        ...(typeof firstFailed?.error === "string" && firstFailed.error.length > 0 && firstFailed.error !== message
          ? { op_error: firstFailed.error }
          : {}),
        ...(typeof firstFailed?.op === "string" ? { op: firstFailed.op } : {}),
        ...(typeof op.terminalState === "string" ? { terminalState: op.terminalState } : {}),
        ...(typeof op.errorClass === "string" ? { errorClass: op.errorClass } : {}),
      },
      null,
      2
    );
  };

  // Failure terminalState takes precedence — it is set by the async lifecycle
  // exactly when the op did not land (timeout, backpressure, lease/identity
  // rejection, cancellation), sometimes with NO results[] to inspect. Prefer the
  // precise engine rejection (envelope error, then the failed op's error) over
  // the generic terminal-state sentence.
  const ts = op.terminalState;
  if (typeof ts === "string" && ts.length > 0 && !SUCCESS_TERMINAL_STATES.has(ts)) {
    const message =
      (typeof op.error === "string" && op.error.length > 0 && op.error) ||
      (typeof firstFailed?.error === "string" && firstFailed.error.length > 0 && firstFailed.error) ||
      TERMINAL_STATE_MESSAGES[ts] ||
      `Engine operation failed (terminalState: ${ts}).`;
    return classify(message);
  }

  // An explicit ok:false / status:"error" / failed op inside results[] is a
  // failure even when the engine omitted an error string — surface it rather
  // than mask it (matches the web contract `isFailureSignal`). The envelope
  // error is kept when present; the failed op's own error backs it up.
  if (op.ok === false || op.status === "error" || firstFailed) {
    const message =
      (typeof op.error === "string" && op.error.length > 0 && op.error) ||
      (typeof firstFailed?.error === "string" && firstFailed.error.length > 0 && firstFailed.error) ||
      (firstFailed
        ? `Engine op failed${firstFailed.op ? ` (${firstFailed.op})` : ""}.`
        : op.ok === false
          ? "Engine operation failed (ok: false)."
          : "Engine operation failed (status: error).");
    return classify(message);
  }
  return null;
}

/** The per-op text an older engine answers for a Kind its dispatch ladder does
 *  not know (ops_executor.cpp fallthrough: `unknown op: <Kind>`). */
const UNKNOWN_OP_PATTERN = /unknown op/i;

/**
 * An older engine answers an unknown op with a per-op "unknown op: <Kind>"
 * (ops_executor.cpp fallthrough). Amend the envelope's error so the model gets
 * the upgrade path instead of retrying, and stamp `failure_reason:
 * "engine_lacks_op"` (+ `op`) so the result is detectable the same way as the
 * capability pre-flight's MissingOpResult: programmatic callers read the
 * field (the CLI prints the whole receipt), and extractOpError renders the
 * classified failure as JSON. Engines WITH a capability advert never reach
 * this — the pre-flight in missingEngineOpResult refuses before sending.
 * A chunked mutation (executeSceneMutation) rewrites the envelope error into
 * the "N earlier op(s) already applied" receipt, so the raw per-op text lives
 * only inside results[] — both are read before deciding this is an old engine.
 * Returns the input untouched when there is nothing to rewrite.
 */
export function withOldEngineHint(result: unknown, opName: string, fallback: string): unknown {
  const opError = extractOpError(result);
  if (!opError) return result;
  const envelope = (result ?? {}) as Record<string, unknown> & {
    results?: Array<{ ok?: boolean; error?: unknown }>;
  };
  const failedOpError = envelope.results?.find((entry) => entry.ok === false && typeof entry.error === "string")
    ?.error as string | undefined;
  const engineSaid =
    (typeof envelope.error === "string" && envelope.error) || failedOpError || opError;
  if (!UNKNOWN_OP_PATTERN.test(opError) && !UNKNOWN_OP_PATTERN.test(failedOpError ?? "")) return result;
  return {
    ...envelope,
    op: opName,
    failure_reason: "engine_lacks_op",
    error:
      `This Summer Engine build doesn't support ${opName} yet — ` +
      `${fallback}, or update Summer Engine (restart it after updating). ` +
      `Engine said: ${failedOpError ?? engineSaid}`,
  };
}
