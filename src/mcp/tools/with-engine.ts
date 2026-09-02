import { getClient, resetClient } from "../server.js";
import { recordMcpSession } from "../../core/telemetry.js";
import { thrownErrorClass } from "../../core/tool-errors.js";
export {
  missingEngineOpResult,
  type CapabilityAdvertisingClient,
} from "../../core/capability-skew.js";
export { ToolInputError, UnsupportedOperationError } from "../../core/tool-errors.js";

type ToolResultContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

type ToolResult = { content: ToolResultContent[]; isError?: boolean };

/** Diagnostics stamped by withEngine onto its ToolResult under a non-enumerable
 *  key so the server.ts result logger can emit a single structured stderr line
 *  per tool call WITHOUT every one of the ~31 callers having to thread its own
 *  tool name through. Never serialized to the model (non-enumerable). */
export interface WithEngineMeta {
  terminalState?: string;
  errorClass?: string;
  failureReason?: string;
  retried: boolean;
  boundProjectIdHash?: string;
}

export const WITH_ENGINE_META = Symbol("summerWithEngineMeta");

function attachMeta(result: ToolResult, meta: WithEngineMeta): ToolResult {
  Object.defineProperty(result, WITH_ENGINE_META, {
    value: meta,
    enumerable: false,
    configurable: true,
  });
  return result;
}

/** Options for {@link withEngine}. `toContent` maps a successful engine result
 *  to MCP content blocks — used by the screenshot tool to hand the raw frame
 *  back as an image block instead of JSON-stringified text. Only runs on genuine
 *  success (after extractOpError clears); failures still surface as text.
 *
 *  `onResult` runs FIRST on a genuine success and may short-circuit to a custom
 *  ToolResult (e.g. a fail-loud message for a structurally-blocked capture).
 *  Return null to fall through to toContent / the default JSON text. */
export interface WithEngineOptions<T> {
  toContent?: (result: T) => ToolResultContent[];
  onResult?: (result: T) => ToolResult | null;
}

type OpResult = {
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

function getFailureReason(value: {
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

/** Pull the failure classifiers off an engine envelope for logging (best-effort,
 *  shape-tolerant). Does not decide success/failure — that stays in
 *  extractOpError. */
function readClassifiers(result: unknown): Pick<WithEngineMeta, "terminalState" | "errorClass" | "failureReason"> {
  if (!result || typeof result !== "object") return {};
  const op = result as OpResult;
  const failed = op.results?.find((entry) => entry.ok === false);
  return {
    terminalState: typeof op.terminalState === "string" ? op.terminalState : undefined,
    errorClass: typeof op.errorClass === "string" ? op.errorClass : undefined,
    failureReason: getFailureReason(op) ?? (failed ? getFailureReason(failed) : undefined),
  };
}

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
/** An older engine answers an unknown op with a per-op "unknown op: <Kind>"
 *  (ops_executor.cpp fallthrough). Amend the envelope's error so the model gets
 *  the upgrade path instead of retrying. Engines WITH a capability advert never
 *  reach this — the pre-flight in missingEngineOpResult refuses before sending.
 *  A chunked mutation (executeSceneMutation) rewrites the envelope error into
 *  the "N earlier op(s) already applied" receipt, so the raw per-op text lives
 *  only inside results[] — both are read before deciding this is an old engine. */
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
  if (!/unknown op/i.test(opError) && !/unknown op/i.test(failedOpError ?? "")) return result;
  return {
    ...envelope,
    error:
      `This Summer Engine build doesn't support ${opName} yet — ` +
      `${fallback}, or update Summer Engine (restart it after updating). ` +
      `Engine said: ${failedOpError ?? engineSaid}`,
  };
}

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

  if (
    normalized.includes("identity_mismatch") ||
    normalized.includes("projectidhash mismatch") ||
    normalized.includes("projectid mismatch") ||
    normalized.includes("wrong project/instance")
  ) {
    return "Summer Engine is now on a DIFFERENT project than this session is bound to — nothing was applied (your edit did NOT land in the wrong project). If you meant to work on the now-open project, call `summer_get_project_context` to rebind to it, then retry. If not, switch the engine back to the original project first.";
  }

  if (normalized.includes("no scene open") || normalized.includes("no edited scene")) {
    return "No scene is currently open. Call `summer_get_project_context` first, then `summer_open_main_scene` (or `summer_open_scene` with a known .tscn path).";
  }

  if (normalized.includes("failed to open scene")) {
    return "Scene path could not be opened. Call `summer_get_project_context` to get `mainScene`, then open that exact path. Avoid guessing scene filenames.";
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
  let retried = false;
  let boundProjectIdHash: string | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) retried = true;
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

    boundProjectIdHash =
      typeof client.getBoundProjectIdHash === "function"
        ? client.getBoundProjectIdHash()
        : undefined;

    try {
      const result = await fn(client);
      const opError = extractOpError(result);
      if (opError) {
        const hint = buildActionHint(opError);
        const message = hint ? `${opError}\n\nHint: ${hint}` : opError;
        return attachMeta(
          { content: [{ type: "text", text: message }], isError: true },
          { ...readClassifiers(result), retried, boundProjectIdHash }
        );
      }
      const meta: WithEngineMeta = { ...readClassifiers(result), retried, boundProjectIdHash };
      if (opts?.onResult) {
        const short = opts.onResult(result);
        if (short) return attachMeta(short, meta);
      }
      if (opts?.toContent) {
        return attachMeta({ content: opts.toContent(result) }, meta);
      }
      return attachMeta(
        { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
        meta
      );
    } catch (err) {
      // A tagged pre-apply throw (argument validation, or a client that cannot
      // perform the op at all) never reached the engine: keep the cached
      // client, skip the transport recovery recipe, and say so.
      const preApply = thrownErrorClass(err);
      if (preApply) {
        return attachMeta(preApplyFailureResult(preApply, err), {
          errorClass: preApply,
          failureReason: PRE_APPLY_FAILURE_REASON[preApply],
          retried,
          boundProjectIdHash,
        });
      }
      // Drop the cached client (it may point at a dead/rotated engine). Retry
      // once only for a provably pre-apply auth failure; anything else surfaces.
      resetClient();
      lastError = err;
      if (attempt < MAX_ATTEMPTS && isAuthError(err)) continue;
      break;
    }
  }

  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  return attachMeta(
    { content: [{ type: "text", text: withTransportRecovery(msg) }], isError: true },
    { errorClass: "transport", retried, boundProjectIdHash }
  );
}

const PRE_APPLY_FAILURE_REASON = {
  input: "invalid_input",
  unsupported: "unsupported_operation",
} as const;

/** Model-visible result for a throw that is provably pre-apply. Rendered as
 *  JSON like every other classified failure (callers read failure_reason
 *  instead of scraping a sentence); `sent:false` is the load-bearing bit —
 *  no mutation could have landed, so the model may fix the call and retry. */
function preApplyFailureResult(
  errorClass: keyof typeof PRE_APPLY_FAILURE_REASON,
  err: unknown
): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{
      type: "text",
      text: JSON.stringify(
        {
          error: message,
          failure_reason: PRE_APPLY_FAILURE_REASON[errorClass],
          errorClass,
          sent: false,
          hint:
            errorClass === "input"
              ? "Nothing was sent to the engine. Fix the argument named in the error and call again — no inspection needed."
              : "Nothing was sent or applied. This client cannot perform the operation; use the alternative named in the error.",
        },
        null,
        2
      ),
    }],
  };
}

/** Every transport-level failure must TEACH recovery, not just name the error.
 *  getClient()'s connect failure already carries its own instructions; anything
 *  else (fetch failed / abort / HTTP status thrown mid-call) gets the generic
 *  recovery recipe appended. Exported for unit tests. */
export function withTransportRecovery(message: string): string {
  // Connect-path failures already prescribe (server.ts getClient appends the
  // "Open the intended project…" instructions). Don't stack a second recipe.
  if (message.includes("summer-engine run") || message.includes("summer-engine@latest run")) return message;
  return (
    message +
    "\n\nRecovery: (1) check the engine is running and responsive — summer_get_project_context here, or `summer doctor` in a shell; " +
    "(2) if this was a MUTATION, do NOT blind-retry — it may have partially applied; inspect the target first (summer_get_scene_tree / summer_world_snapshot / summer_read_file); " +
    "(3) if the call was large or long-running, break it into smaller scripts/batches and re-run piece by piece; " +
    "(4) if the engine restarted, the next tool call reconnects automatically — just retry a READ to confirm."
  );
}
