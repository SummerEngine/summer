import { defaultHostedConnectDependencies, hostedConnectFailure, HostedUnreachableError, httpStatusOf, type HostedClient, type HostedConnectDependencies } from "../hosted-mcp.js";
import { OAuthError, resolveMcpResourceUrl } from "../oauth.js";
import { localEntries, localInputSchema, type CatalogEntry } from "./catalog.js";
import { errorAnswer, isLocalOp, type Answer } from "./contract.js";
import { withOutField } from "./save-files.js";
import { scoreEntry, searchEntries } from "./search.js";

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
  if (status === 401 || (error instanceof OAuthError && !OAUTH_UNREACHABLE.has(error.code) && error.code !== "store_access_denied") || (!known && /invalid_token/.test(cause))) {
    // A missing store sign-in needs a sign-in; an expired or refused one needs a fresh store sign-in.
    const fresh = !(error instanceof OAuthError && error.code === "store_login_required");
    return errorAnswer("not_signed_in", `Cloud operations need the Summer sign-in: ${cause}`, { next: { say: fresh ? "Run: npx -y summer-engine login --store --force" : "Run: npx -y summer-engine login" }, details });
  }
  if (status === 403 || (error instanceof OAuthError && error.code === "store_access_denied")) {
    return errorAnswer("forbidden", `Summer's hosted server refused this account: ${cause}`, { next: { say: "Check the account in Summer Studio (for example confirm the email), then try again." }, details });
  }
  if (status === 429) {
    return errorAnswer("rate_limited", `Summer's hosted server asked to slow down: ${cause}`, { next: { say: "Wait a minute, then call it again." }, details });
  }
  const notSent = known || status === 503 || (status !== undefined && status >= 400 && status < 500) || NOT_SENT_CAUSES.has(causeCode(error) ?? "");
  if (notSent) {
    const rejected = status !== undefined && status >= 400 && status < 500;
    return errorAnswer("unavailable", `Summer's hosted server did not run ${call.op}: ${cause}`, {
      retry: rejected ? "no" : "after",
      next: { say: rejected ? "Update Summer: npx -y summer-engine@latest, then try again." : "Try again in a minute. If it repeats, check the network." },
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

/**
 * One ranked list of local and cloud operations for a plain-words query.
 * Local hits carry their input schema from the library descriptor. When the
 * hosted server cannot be asked, the local hits come back with a warning.
 */
export async function searchEverywhere(
  query: string,
  filters: { area?: string; limit: number },
  call: HostedCall,
  isDirect: (toolName: string) => boolean = () => false
): Promise<{ items: CatalogEntry[]; warning: string | null }> {
  const local = searchEntries(localEntries(), query, filters).map((entry) => ({
    ...entry,
    input: localInputSchema(entry.name) ?? { type: "object" },
    mcpTool: entry.mcpTool && isDirect(entry.mcpTool) ? entry.mcpTool : undefined,
  }));
  let cloud: CatalogEntry[] = [];
  let warning: string | null = null;
  try {
    const answer = answerOfHosted(await call("summer_search", { query, ...(filters.area ? { area: filters.area } : {}), limit: filters.limit }));
    // The operations that save files take `out` here (save-files.ts), so their input shows it.
    if (answer.ok && answer.status === "done") {
      cloud = ((answer.result as { items?: CatalogEntry[] }).items ?? [])
        .filter((entry) => !isLocalOp(entry.name))
        .map((entry) => (entry.input ? { ...entry, input: withOutField(entry.name, entry.input) as Record<string, unknown> } : entry));
    }
    else if (!answer.ok) warning = `Cloud operations were not searched: ${answer.error.message}`;
  } catch (error) {
    warning = `Cloud operations were not searched: ${error instanceof Error ? error.message : String(error)}`;
  }
  const items = [...local, ...cloud]
    .map((entry) => ({ entry, score: scoreEntry(entry, query) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, filters.limit)
    .map(({ entry }) => entry);
  return { items, warning };
}
