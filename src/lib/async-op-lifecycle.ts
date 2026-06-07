/**
 * 0.5.34 Block E — async tool-lifecycle consumer for the CLI/MCP.
 *
 * Ported from the web orchestrator (publicsummerengine
 * src/lib/bridge/async-op-lifecycle.ts) so the CLI speaks the SAME contract as
 * the engine's responsive tool server (Block E):
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

const TIMED_OUT_RESULT: Record<string, unknown> = {
  status: "error",
  error: "Tool timeout - Summer Engine may be unresponsive",
  terminalState: "timed_out",
  errorClass: "transient",
};

/**
 * Drive an async op to a terminal result by polling. `pollOnce(waitMs)` performs
 * one GET /api/ops/result (long-poll up to waitMs). Returns the engine's apply
 * dict with terminalState/errorClass/appliedSeq merged on top, or a synthetic
 * `timed_out` result if the budget is exhausted.
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
      return { ...TIMED_OUT_RESULT };
    }

    await sleep(pacingMs);
  }
}
