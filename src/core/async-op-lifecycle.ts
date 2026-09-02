/**
 * Async tool-lifecycle consumer for the CLI/MCP.
 *
 * Speaks the engine tool server's async op contract (the same one the Summer
 * web app uses), so both clients read engine responses identically:
 *   - NEW path: `202 {requestId, status:"queued"}` -> long-poll
 *     GET /api/ops/result?requestId=&wait=ms until terminal (done|failed|canceled).
 *   - LEGACY path (dormant/older engine): a synchronous `200` with the full apply
 *     result, exactly as before.
 *
 * It inspects the RESPONSE (status/body), not a flag, so it stays compatible with
 * both an async and a synchronous engine. Pure + dependency-injected (now/sleep/
 * pollOnce) so it is unit-tested without HTTP.
 */

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["done", "failed", "canceled"]);

export function isTerminalStatus(status: string | undefined): boolean {
  return status != null && TERMINAL_STATUSES.has(status);
}

/** The envelope returned by GET /api/ops/result. */
export interface OpResultEnvelope {
  requestId?: string;
  status: string; // queued | running | done | failed | canceled | unknown
  terminalState?: string; // M1 ToolTerminalState (applied|content_mismatch|...|canceled)
  errorClass?: string; // M1 ToolErrorClass
  result?: Record<string, unknown>; // the apply dict ({status, results, elapsed_ms, ...})
  progress?: unknown; // optional intermediate progress frame (Tier B)
  appliedSeq?: number;
}

export type OpsResponseClassification =
  | { mode: "queued"; requestId: string }
  | { mode: "legacy"; legacyResult: unknown };

/**
 * Decide whether a POST /api/ops (or GET /api/snapshot/*) response is the new
 * async ack (`202`) or the legacy synchronous result (`200`). Inspecting the HTTP
 * status (not a flag) is what keeps this compatible with both engines.
 */
export function classifyOpsResponse(httpStatus: number, body: unknown): OpsResponseClassification {
  const b = (body ?? {}) as Record<string, unknown>;
  const looksQueued = b.accepted === true && b.status === "queued" && typeof b.requestId === "string";
  if (httpStatus === 202 || looksQueued) {
    return { mode: "queued", requestId: String(b.requestId ?? "") };
  }
  return { mode: "legacy", legacyResult: body };
}

export interface PollOpts {
  /** Hard wall-clock cap on the whole poll loop (ms). The per-tool budget. */
  totalTimeoutMs: number;
  /** Stable client-generated correlation ID. Preserved in non-terminal timeout
   *  receipts so callers can reconcile the accepted operation instead of
   *  blindly retrying it. */
  requestId?: string;
  /** Give up if the op hasn't advanced for this long (ms). Default = totalTimeoutMs. */
  noProgressTimeoutMs?: number;
  /** Server long-poll wait per GET (ms). Default 5000 — the engine holds the
   *  connection up to this long, which paces the loop in production. */
  pollWaitMs?: number;
  /** Pacing sleep between non-terminal polls (ms). Negligible in production
   *  (the long-poll dominates); keeps the loop from hot-spinning. Default 250. */
  pacingMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function incompleteResult(
  requestId: string | undefined,
  lastStatus: string | undefined,
): Record<string, unknown> {
  if (lastStatus === "queued") {
    return {
      status: "error",
      error:
        `Summer Engine accepted request ${requestId ?? "(unknown)"}, but it was still queued when this tool stopped waiting. ` +
        "It may still run; do not retry blindly.",
      terminalState: "still_queued",
      errorClass: "transient",
      dispatchState: "accepted",
      requestId,
      lastKnownStatus: "queued",
    };
  }

  const wasRunning = lastStatus === "running";
  return {
    status: "error",
    error:
      `Summer Engine did not provide a final receipt for request ${requestId ?? "(unknown)"}. ` +
      `${wasRunning ? "The operation was still running" : "Its dispatch state is uncertain"}; inspect the target before retrying.`,
    terminalState: wasRunning ? "still_running" : "uncertain",
    errorClass: "transient",
    dispatchState: wasRunning ? "sent" : "uncertain",
    requestId,
    lastKnownStatus: lastStatus ?? "unknown",
  };
}

/**
 * Drive an async op to a terminal result by polling. `pollOnce(waitMs)` performs
 * one GET /api/ops/result (long-poll up to waitMs). Returns the engine's apply
 * dict with terminalState/errorClass/appliedSeq merged on top, or a truthful
 * non-terminal `still_queued` / `still_running` / `uncertain` receipt when the
 * client budget expires before the engine publishes a terminal.
 */
export async function pollOpToTerminal(
  pollOnce: (waitMs: number) => Promise<OpResultEnvelope>,
  opts: PollOpts
): Promise<Record<string, unknown>> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollWaitMs = opts.pollWaitMs ?? 5000;
  const pacingMs = opts.pacingMs ?? 250;
  const noProgressMs = opts.noProgressTimeoutMs ?? opts.totalTimeoutMs;

  const start = now();
  let lastAdvanceAt = start;
  let lastStatus: string | undefined;
  let lastSeq = -1;
  let lastProgress = "";

  for (;;) {
    const env = await pollOnce(pollWaitMs);

    if (isTerminalStatus(env.status)) {
      const out: Record<string, unknown> = { ...(env.result ?? {}) };
      const requestId = opts.requestId ?? env.requestId;
      if (requestId) out.requestId = requestId;
      if (env.terminalState) out.terminalState = env.terminalState;
      if (env.errorClass) out.errorClass = env.errorClass;
      if (env.appliedSeq != null) out.appliedSeq = env.appliedSeq;
      return out;
    }

    const progressJson = env.progress != null ? JSON.stringify(env.progress) : "";
    const seq = env.appliedSeq ?? -1;
    const advanced = env.status !== lastStatus || seq !== lastSeq || progressJson !== lastProgress;

    const t = now();
    if (advanced) {
      lastAdvanceAt = t;
      lastStatus = env.status;
      lastSeq = seq;
      lastProgress = progressJson;
    }

    if (t - start >= opts.totalTimeoutMs || t - lastAdvanceAt >= noProgressMs) {
      return incompleteResult(opts.requestId ?? env.requestId, env.status);
    }

    await sleep(pacingMs);
  }
}
