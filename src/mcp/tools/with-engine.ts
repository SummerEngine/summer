import { getClient, resetClient } from "../server.js";
import { recordMcpSession } from "../../core/telemetry.js";
import { thrownErrorClass } from "../../core/tool-errors.js";
import {
  extractOpError,
  getFailureReason,
  withOldEngineHint,
  type OpResult,
} from "../../core/capabilities/engine-receipt.js";
export { extractOpError, withOldEngineHint };
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
