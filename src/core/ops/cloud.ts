import { defaultHostedConnectDependencies, withHostedMcp, type HostedConnectDependencies } from "../hosted-mcp.js";
import { resolveMcpResourceUrl } from "../oauth.js";
import { localEntries, localInputSchema, type CatalogEntry } from "./catalog.js";
import { errorAnswer, isLocalOp, type Answer } from "./contract.js";
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

/** One call to a tool on the hosted v4 surface (the CLI's path; the MCP uses its mounted client). */
export async function callHostedV4(
  name: string,
  args: Record<string, unknown>,
  deps: HostedConnectDependencies = v4HostedDependencies
): Promise<Record<string, unknown>> {
  return withHostedMcp((client) => client.callTool({ name, arguments: args }), deps);
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
    return errorAnswer("unavailable", "The Summer server's operation catalog is not switched on yet.", { next: { say: "Use the 3.x tools (no --surface v4) for now." } });
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
    if (answer.ok && answer.status === "done") cloud = ((answer.result as { items?: CatalogEntry[] }).items ?? []).filter((entry) => !isLocalOp(entry.name));
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
