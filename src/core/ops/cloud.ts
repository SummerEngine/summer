import { defaultHostedConnectDependencies, hostedConnectFailure, HostedUnreachableError, httpStatusOf, type HostedClient, type HostedConnectDependencies } from "../hosted-mcp.js";
import { OAuthError, resolveMcpResourceUrl } from "../oauth.js";
import { localEntries, localInputSchema, type CatalogEntry } from "./catalog.js";
import { errorAnswer, isLocalOp, resolveOpName, type Answer, type ErrorCode } from "./contract.js";
import { shippedCloudEntries, shippedWireForm } from "./public-catalog.js";
import { withOutField } from "./save-files.js";
import { searchEntries } from "./search.js";

/**
 * The hosted Summer server's v4 surface: the same address with `?surface=v4`
 * (it keeps serving 3.x tools to every request that does not ask). Cloud
 * operations run there with the person's sign-in (summer login). The assets
 * profile also asks for its own direct tools (`profile=assets`: the asset
 * reads and generators, jobs and whoami); every other profile gets the
 * hosted set.
 */
export function withV4Surface(url: string, profile?: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("surface", "v4");
  if (profile === "assets") parsed.searchParams.set("profile", "assets");
  return parsed.href;
}

/** Where a profile's v4 session mounts the hosted server. */
export function v4HostedUrl(profile?: string): () => string {
  return () => withV4Surface(resolveMcpResourceUrl(), profile);
}

export const v4HostedDependencies: HostedConnectDependencies = {
  ...defaultHostedConnectDependencies,
  url: v4HostedUrl(),
};

/**
 * One call to a tool on the hosted v4 surface (the CLI's path; the MCP uses
 * its mounted client). A failure before the call is sent is an OAuthError
 * (sign-in) or a HostedUnreachableError; one after it may have run.
 */
export async function callHostedV4(
  name: string,
  args: Record<string, unknown>,
  deps: HostedConnectDependencies = v4HostedDependencies
): Promise<Record<string, unknown>> {
  let client: HostedClient;
  try {
    const url = deps.url();
    await deps.token();
    client = await deps.connect(url, deps.token);
  } catch (error) {
    throw hostedConnectFailure(error, "Recovery: check the network and try again.");
  }
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close?.().catch(() => undefined);
  }
}

/** OAuth failures that mean a server did not answer, not that the person must sign in again. */
const OAUTH_UNREACHABLE = new Set(["oauth_network_failed", "oauth_discovery_failed", "oauth_server_failed"]);
/** Connection errors raised before a request is written: nothing reached the server. */
const NOT_SENT_CAUSES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);
/** Actions that only read; a cut-off read can simply run again. */
const READ_ACTIONS = new Set(["list", "get", "search", "describe", "status", "wait"]);

/** True for operations that only read (`games.list`, `jobs.wait`, `whoami`). */
export function isReadOp(op: string): boolean {
  return op === "whoami" || READ_ACTIONS.has(op.split(".")[1] ?? "");
}

function causeCode(error: unknown): string | undefined {
  for (let e: unknown = error, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/**
 * The one answer for a hosted call that threw, decided by what is known to
 * have happened:
 * - a sign-in problem (an OAuthError, a 401) is not_signed_in; an account
 *   the server refuses (403) is forbidden;
 * - nothing sent (never connected, connection refused, a 503 or another 4xx
 *   the server answers before it runs anything) is unavailable;
 * - a call cut off after it was sent may have run: outcome_unknown, retried
 *   only with the same idempotencyKey, else checked first. A read or a dry
 *   run changes nothing, so a cut-off one is unavailable.
 */
export function hostedCallFailure(error: unknown, call: { op: string; dryRun?: boolean; idempotencyKey?: string; read?: boolean }): Answer {
  const known = error instanceof OAuthError || error instanceof HostedUnreachableError;
  const cause = known ? error.message.replace(` ${error.recovery}`, "") : error instanceof Error ? error.message : String(error);
  const status = httpStatusOf(error);
  const details = { was: error instanceof OAuthError ? error.code : error instanceof HostedUnreachableError ? "unreachable" : status !== undefined ? `http_${status}` : causeCode(error) ?? "no_answer" };
  // A bad SUMMER_MCP_RESOURCE: nothing was sent, and signing in again would not help.
  if (error instanceof OAuthError && error.code === "oauth_resource_invalid") {
    return errorAnswer("unavailable", cause, { retry: "no", next: { say: error.recovery.replace(/^Recovery:\s*/, "") }, details });
  }
  if (status === 401 || (error instanceof OAuthError && !OAUTH_UNREACHABLE.has(error.code) && error.code !== "store_access_denied") || (!known && /invalid_token/.test(cause))) {
    // A missing store sign-in needs a sign-in; an expired or refused one needs a fresh store sign-in.
    const fresh = !(error instanceof OAuthError && error.code === "store_login_required");
    return errorAnswer("not_signed_in", `Cloud operations need the Summer sign-in: ${cause}`, { next: { say: fresh ? "Run: npx -y summer-engine login --store --force" : "Run: npx -y summer-engine login" }, details });
  }
  if (status === 403 || (error instanceof OAuthError && error.code === "store_access_denied")) {
    return errorAnswer("forbidden", error instanceof OAuthError ? cause : `Summer's hosted server refused this account: ${cause}`, { next: { say: "Check the account in Summer Studio (for example confirm the email), then try again." }, details });
  }
  if (status === 429) {
    return errorAnswer("rate_limited", `Summer's hosted server asked to slow down: ${cause}`, { next: { say: "Wait a minute, then call it again." }, details });
  }
  const notSent = known || status === 503 || (status !== undefined && status >= 400 && status < 500) || NOT_SENT_CAUSES.has(causeCode(error) ?? "");
  if (notSent) {
    const rejected = status !== undefined && status >= 400 && status < 500;
    return errorAnswer("unavailable", `Summer's hosted server did not run ${call.op}: ${cause}`, {
      retry: rejected ? "no" : "after",
      next: { say: rejected ? "Summer's hosted server refused the request. If it repeats, report it to Summer with this message." : "Try again in a minute. If it repeats, check the network." },
      details,
    });
  }
  if (call.dryRun || call.read || isReadOp(call.op)) {
    return errorAnswer("unavailable", `Summer's hosted server did not answer ${call.op} in time: ${cause}`, { retry: "safe", next: { say: "Call it again; it only reads." }, details });
  }
  return call.idempotencyKey
    ? errorAnswer("outcome_unknown", `Summer's hosted server did not answer in time, so it is not known whether ${call.op} ran: ${cause}`, {
        retry: "same_key",
        next: { say: "Call it again with the same idempotencyKey: Summer runs a change once per key." },
        details,
      })
    : errorAnswer("outcome_unknown", `Summer's hosted server did not answer in time, so it is not known whether ${call.op} ran: ${cause}`, {
        retry: "no",
        next: { say: "Check what it would have changed (or jobs.list) before you try again." },
        details,
      });
}

/** The answer a hosted v4 tool result carries (its JSON text), or the one error shape. */
export function answerOfHosted(result: Record<string, unknown>): Answer {
  const content = Array.isArray(result.content) ? (result.content as Array<{ type?: string; text?: string }>) : [];
  const first = content.find((part) => part.type === "text" && typeof part.text === "string")?.text ?? "";
  try {
    const parsed = JSON.parse(first) as Answer;
    if (parsed && typeof parsed === "object" && "ok" in parsed) return parsed;
  } catch {
    // not an answer: fall through
  }
  if (/summer_(call|search)\b.*(not found|disabled)/i.test(first)) {
    return errorAnswer("unavailable", "The Summer server's operation catalog is not switched on yet.", { next: { say: "Use the 3.x tools for now: summer mcp --surface v3 (or SUMMER_SURFACE=v3)." } });
  }
  return result.isError === true ? errorAnswer("unavailable", first.slice(0, 300) || "The Summer server did not answer.") : { ok: true, status: "done", result: { text: first } };
}

/** Runs a tool on the hosted v4 surface: the MCP's mounted client or the CLI's one-shot call. */
export type HostedCall = (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Failures that mean Summer's server did not describe the operation, so the shipped catalog may. */
const DID_NOT_ANSWER: ReadonlySet<ErrorCode> = new Set<ErrorCode>(["not_signed_in", "forbidden", "rate_limited", "unavailable"]);

/**
 * ops.describe of a cloud operation when Summer's server could not answer it
 * (no sign-in, no network): the operation from the shipped catalog, with a
 * warning. Null when the catalog has no such operation; the failure stands.
 */
export function describeFromShipped(name: string, failure: Answer): Answer | null {
  // The server's own answer stands (not_found: it no longer has the operation).
  if (failure.ok || !DID_NOT_ANSWER.has(failure.error.code)) return null;
  const operation = shippedWireForm(resolveOpName(name));
  if (!operation) return null;
  const warning =
    failure.error.code === "not_signed_in"
      ? "Not signed in: this is the catalog in this version; the operation runs after `summer login`."
      : `Summer's server did not answer (${failure.error.message}); this is the catalog in this version.`;
  return { ok: true, status: "done", result: { operation }, warnings: [warning] };
}

/** The warning when cloud operations come from the shipped catalog, and whether that is because no one is signed in. */
function shippedReason(answer: Answer): { warning: string; signedOut: boolean } {
  if (!answer.ok && answer.error.code === "not_signed_in") {
    return { warning: "Not signed in: cloud operations are listed from the catalog in this version and run after `summer login` (needsSignIn).", signedOut: true };
  }
  return { warning: `Cloud operations are listed from the catalog in this version; Summer's server did not search: ${answer.ok ? "no answer" : answer.error.message}`, signedOut: false };
}

/**
 * One ranked list of local and cloud operations for a plain-words query.
 * Every cloud operation comes from the shipped catalog (public-catalog.ts),
 * so search finds it signed out, marked needsSignIn; signed in, the server's
 * own search lays its live rows over the shipped ones (and adds newer
 * operations). Local hits carry their input schema from the library descriptor.
 */
export async function searchEverywhere(
  query: string,
  filters: { area?: string; limit: number },
  call: HostedCall,
  isDirect: (toolName: string) => boolean = () => false
): Promise<{ items: CatalogEntry[]; warning: string | null }> {
  let live: CatalogEntry[] = [];
  let reason: { warning: string; signedOut: boolean } | null = null;
  try {
    const answer = answerOfHosted(await call("summer_search", { query, ...(filters.area ? { area: filters.area } : {}), limit: 20 }));
    if (answer.ok && answer.status === "done") live = ((answer.result as { items?: CatalogEntry[] }).items ?? []).filter((entry) => !isLocalOp(entry.name));
    else reason = shippedReason(answer);
  } catch (error) {
    reason = shippedReason(hostedCallFailure(error, { op: "ops.search", read: true }));
  }
  const cloud = new Map(shippedCloudEntries().map((entry) => [entry.name, reason?.signedOut ? { ...entry, needsSignIn: true as const } : entry]));
  // The operations that save files take `out` here (save-files.ts), so their input shows it.
  for (const entry of live) {
    cloud.set(entry.name, { ...cloud.get(entry.name), ...entry, ...(entry.input ? { input: withOutField(entry.name, entry.input) as Record<string, unknown> } : {}) });
  }
  const items = searchEntries([...localEntries(), ...cloud.values()], query, filters).map(({ topics: _topics, ...entry }) =>
    isLocalOp(entry.name)
      ? { ...entry, input: localInputSchema(entry.name) ?? { type: "object" }, mcpTool: entry.mcpTool && isDirect(entry.mcpTool) ? entry.mcpTool : undefined }
      : entry
  );
  return { items, warning: reason?.warning ?? null };
}
