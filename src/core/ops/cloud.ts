import { defaultHostedConnectDependencies, HostedUnreachableError, type HostedClient, type HostedConnectDependencies } from "../hosted-mcp.js";
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
    if (error instanceof OAuthError) throw error;
    throw new HostedUnreachableError(`Summer's hosted server did not answer: ${error instanceof Error ? error.message : String(error)}.`, "Recovery: check the network and try again.");
  }
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close?.().catch(() => undefined);
  }
}

/** OAuth failures that mean a server did not answer, not that the person must sign in again. */
const OAUTH_UNREACHABLE = new Set(["oauth_network_failed", "oauth_discovery_failed"]);

/**
 * The one answer for a hosted call that threw. A sign-in problem is
 * not_signed_in. Nothing sent (no connection) is unavailable: try again
 * later. A call cut off after it was sent may have run, so it is
 * outcome_unknown: retried only with the same idempotencyKey, else checked
 * first. A dry run changes nothing, so a cut-off one is unavailable.
 */
export function hostedCallFailure(error: unknown, call: { op: string; dryRun?: boolean; idempotencyKey?: string }): Answer {
  const cause = error instanceof Error ? error.message : String(error);
  const unauthorized = !(error instanceof HostedUnreachableError) && /\b401\b|unauthori[sz]ed/i.test(cause);
  if ((error instanceof OAuthError && !OAUTH_UNREACHABLE.has(error.code)) || unauthorized) {
    return errorAnswer("not_signed_in", `Cloud operations need the Summer sign-in: ${cause}`, { next: { say: "Run: npx -y summer-engine login" } });
  }
  if (error instanceof OAuthError || error instanceof HostedUnreachableError) {
    return errorAnswer("unavailable", `Summer's hosted server did not answer, so ${call.op} did not run: ${cause}`, { next: { say: "Try again in a minute. If it repeats, check the network." } });
  }
  if (call.dryRun) {
    return errorAnswer("unavailable", `Summer's hosted server did not answer the dry run of ${call.op}: ${cause}`, { next: { say: "Try again in a minute; a dry run changes nothing." } });
  }
  return call.idempotencyKey
    ? errorAnswer("outcome_unknown", `Summer's hosted server did not answer in time, so it is not known whether ${call.op} ran: ${cause}`, {
        retry: "same_key",
        next: { say: "Call it again with the same idempotencyKey: Summer runs a change once per key." },
      })
    : errorAnswer("outcome_unknown", `Summer's hosted server did not answer in time, so it is not known whether ${call.op} ran: ${cause}`, {
        retry: "no",
        next: { say: "A read can run again. For a change, check what it would have changed (or jobs.list) before you try again." },
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
