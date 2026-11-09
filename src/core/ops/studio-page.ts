import type { EngineCapabilities } from "../capability-skew.js";
import { errorAnswer, type Answer, type ErrorCode } from "./contract.js";

/**
 * The Studio page ops a running Summer app answers itself, through its own
 * Studio tab (engine POST /api/studio, advertised as
 * capabilities.studioPage): the same op names, input and answers as on
 * Summer's server, with no store sign-in. When the app cannot answer (no
 * engine, an older build, or no Studio tab: `no_tab`), the caller sends the op
 * to Summer's server as before.
 */

export const STUDIO_PAGE_OPS: ReadonlySet<string> = new Set(["studio.map", "studio.page", "studio.use_page", "studio.read_form", "studio.submit_form"]);

export interface StudioPageClient {
  getEngineCapabilities?(): EngineCapabilities | undefined;
  studioPage(op: string, input: Record<string, unknown>): Promise<unknown>;
}

const CODES: ReadonlySet<string> = new Set<ErrorCode>([
  "invalid_input", "not_signed_in", "forbidden", "not_found", "conflict", "idempotency_conflict", "in_progress", "rate_limited",
  "no_credits", "over_limit", "unsupported", "moved", "outcome_unknown", "unavailable",
]);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** The page's answer as the one answer shape, or null for "send it to Summer's server". */
export function studioPageAnswer(envelope: unknown): Answer | null {
  const record = asRecord(envelope);
  const first = asRecord(Array.isArray(record?.results) ? record!.results[0] : null);
  if (!first) {
    return errorAnswer("outcome_unknown", "The Summer app did not say how the Studio page answered.", { next: { op: "studio.page" } });
  }
  if (first.ok === true) {
    const result = asRecord(first.result) ?? {};
    // An op that waits on the person (needs_approval) or runs on comes back as the answer itself.
    if (result.status === "needs_approval" || result.status === "running") return { ok: true, ...result } as Answer;
    return { ok: true, status: "done", result };
  }
  const reason = typeof first.failure_reason === "string" ? first.failure_reason : "unavailable";
  if (reason === "no_tab") return null;
  const message = typeof first.error === "string" && first.error ? first.error : "The Studio page refused this.";
  const code: ErrorCode = reason === "timeout" ? "outcome_unknown" : CODES.has(reason) ? (reason as ErrorCode) : "unavailable";
  return errorAnswer(code, message, code === "outcome_unknown" || code === "conflict" ? { next: { op: "studio.page" } } : {});
}

/**
 * Run a Studio page op in the app's own Studio tab when the running app
 * offers it; null when it does not (the op goes to Summer's server).
 */
export async function runInAppStudio(op: string, input: Record<string, unknown>, engine: () => Promise<StudioPageClient>): Promise<Answer | null> {
  if (!STUDIO_PAGE_OPS.has(op)) return null;
  let client: StudioPageClient;
  try {
    client = await engine();
  } catch {
    return null;
  }
  if (!client.getEngineCapabilities?.()?.studioPage?.ops.includes(op)) return null;
  const { tabId: _tabId, ...rest } = input;
  let envelope: unknown;
  try {
    envelope = await client.studioPage(op, rest);
  } catch (error) {
    // Not acknowledged: nothing reached the page.
    return errorAnswer("unavailable", `The Summer app did not take the Studio op: ${error instanceof Error ? error.message : String(error)}`, { retry: "safe" });
  }
  return studioPageAnswer(envelope);
}
