import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getStoreAccessToken, OAuthError, readStoredOAuthToken, resolveMcpResourceUrl } from "./oauth.js";
import { TOOLKIT_VERSION } from "./version.js";
import { processSurface, summerRequestHeaders, type ClientSurface } from "./agent-host.js";

/**
 * A client for the hosted Summer Engine MCP (mcp.summerengine.com), signed in
 * with the store sign-in ("summer login --store"). The local MCP mounts its
 * tools (src/mcp/hosted-mount.ts); `summer tool` and `summer doctor` call it
 * directly through the helpers below, so all three faces reach the same
 * store and publishing tools.
 */

const CALL_TIMEOUT_MS = 120_000;

/** The part of an MCP client the mount and the CLI use (a fake in tests). */
export interface HostedClient {
  listTools(params?: { cursor?: string }): Promise<{ tools: Tool[]; nextCursor?: string }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<Record<string, unknown>>;
  listPrompts(params?: { cursor?: string }): Promise<{ prompts: Array<{ name: string; title?: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }>; nextCursor?: string }>;
  getPrompt(params: { name: string; arguments?: Record<string, string> }): Promise<Record<string, unknown>>;
  listResources(params?: { cursor?: string }): Promise<{ resources: Array<{ uri: string; name: string; title?: string; description?: string; mimeType?: string }>; nextCursor?: string }>;
  readResource(params: { uri: string }): Promise<Record<string, unknown>>;
  close?(): Promise<void>;
}

export interface HostedConnectDependencies {
  /** The hosted Summer Engine MCP URL (the store sign-in's resource). */
  url: () => string;
  token: () => Promise<string>;
  connect: (url: string, token: () => Promise<string>) => Promise<HostedClient>;
}

/** The handshake name the hosted server sees: the MCP server's own, or the `summer` CLI's, so usage tells them apart. */
export const HOSTED_CLIENT_NAMES = { mcp: "summer-engine-local", cli: "summer-cli" } as const;

export async function connectHostedMcp(
  url: string,
  token: () => Promise<string>,
  surface: ClientSurface = processSurface()
): Promise<HostedClient> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    // A fresh (refreshed when near expiry) token on every request.
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(summerRequestHeaders({ tool: calledTool(init?.body), surface }))) headers.set(name, value);
      headers.set("authorization", `Bearer ${await token()}`);
      return fetch(input, { ...init, headers });
    },
  });
  const client = new Client({ name: HOSTED_CLIENT_NAMES[surface], version: TOOLKIT_VERSION });
  await client.connect(transport);
  const timeout = { timeout: CALL_TIMEOUT_MS };
  return {
    listTools: (params) => client.listTools(params),
    callTool: (params) => client.callTool(params, undefined, timeout) as Promise<Record<string, unknown>>,
    listPrompts: (params) => client.listPrompts(params),
    getPrompt: (params) => client.getPrompt(params) as Promise<Record<string, unknown>>,
    listResources: (params) => client.listResources(params),
    readResource: (params) => client.readResource(params) as Promise<Record<string, unknown>>,
    close: () => client.close(),
  };
}

/**
 * The hosted server's 3.x surface: the same address with `?surface=v3`. Once
 * the hosted server serves 4.0 to every request that does not ask, only 3.x
 * npm releases keep 3.x without asking, so the 3.x tool names here ask.
 */
export function withV3Surface(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("surface", "v3");
  return parsed.href;
}

export const defaultHostedConnectDependencies: HostedConnectDependencies = {
  url: () => withV3Surface(resolveMcpResourceUrl()),
  token: () => getStoreAccessToken(),
  connect: connectHostedMcp,
};

/** The hosted server could not be reached, so no call was sent (a sign-in problem is an OAuthError instead). */
export class HostedUnreachableError extends Error {
  constructor(
    message: string,
    readonly recovery: string
  ) {
    super(`${message} ${recovery}`);
    this.name = "HostedUnreachableError";
  }
}

/** The HTTP status an MCP transport error carries (the SDK's StreamableHTTPError puts it on `code`). */
export function httpStatusOf(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" && code >= 100 && code <= 599 ? code : undefined;
}

/**
 * A failure to connect to the hosted server, before any call was sent: a
 * sign-in problem (an OAuthError, or a 401), an account the server refuses
 * (403, store_access_denied), or the server not answering.
 */
export function hostedConnectFailure(error: unknown, unreachableRecovery: string): OAuthError | HostedUnreachableError {
  if (error instanceof OAuthError || error instanceof HostedUnreachableError) return error;
  const cause = error instanceof Error ? error.message : String(error);
  const status = httpStatusOf(error);
  if (status === 401) return new OAuthError("oauth_token_invalid", `Summer's hosted server refused the sign-in: ${cause}.`, 'Recovery: run "summer login --store --force".');
  if (status === 403) return new OAuthError("store_access_denied", `Summer's hosted server refused this account: ${cause}.`, "Recovery: check the account in Summer Studio (for example confirm the email), then try again.");
  return new HostedUnreachableError(`The hosted Summer Engine MCP did not answer: ${cause}.`, unreachableRecovery);
}

/** True when this machine has a store sign-in on disk (no network). */
export async function hasStoreSignIn(): Promise<boolean> {
  return (await readStoredOAuthToken()) !== null;
}

export async function listAllHostedTools(client: HostedClient): Promise<Tool[]> {
  const out: Tool[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 20; pages++) {
    const result = await client.listTools(cursor ? { cursor } : undefined);
    out.push(...(result.tools ?? []));
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return out;
}

/** Connect with the store sign-in, run fn, close. Throws OAuthError when not signed in. */
export async function withHostedMcp<T>(
  fn: (client: HostedClient) => Promise<T>,
  deps: HostedConnectDependencies = defaultHostedConnectDependencies
): Promise<T> {
  const url = deps.url();
  await deps.token();
  const client = await deps.connect(url, deps.token);
  try {
    return await fn(client);
  } finally {
    await client.close?.().catch(() => undefined);
  }
}

/** The text of a tool result, parsed as JSON when it is JSON. */
export function hostedResultPayload(result: Record<string, unknown>): { isError: boolean; text: string; json: Record<string, unknown> | null } {
  const content = Array.isArray(result.content) ? (result.content as Array<{ type?: string; text?: string }>) : [];
  const text = content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
  let json: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
  } catch {
    json = null;
  }
  if (!json && result.structuredContent && typeof result.structuredContent === "object") {
    json = result.structuredContent as Record<string, unknown>;
  }
  return { isError: result.isError === true, text, json };
}

export type StoreAccessResult =
  | { status: "not_signed_in"; message: string }
  | { status: "ok"; games: number | null }
  | { status: "refused"; code: string | null; message: string; requestId?: string }
  | { status: "unreachable"; message: string };

/**
 * Ask the store for the creator's games through the hosted MCP
 * (summer_store_list_games): proves the store accepts this machine's sign-in.
 */
export async function checkStoreAccess(
  timeoutMs = 8_000,
  deps: HostedConnectDependencies = defaultHostedConnectDependencies
): Promise<StoreAccessResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<StoreAccessResult>((resolve) => {
    timer = setTimeout(() => resolve({ status: "unreachable", message: `no answer within ${Math.round(timeoutMs / 1000)} s` }), timeoutMs);
    timer.unref?.();
  });
  const attempt = (async (): Promise<StoreAccessResult> => {
    try {
      const result = await withHostedMcp((client) => client.callTool({ name: "summer_store_list_games", arguments: {} }), deps);
      const payload = hostedResultPayload(result);
      if (payload.isError || payload.json?.ok === false) {
        const code = typeof payload.json?.code === "string" ? payload.json.code : typeof payload.json?.error === "string" ? payload.json.error : null;
        const message = typeof payload.json?.message === "string" ? payload.json.message : payload.text.slice(0, 300) || "the store refused the call";
        const requestId = typeof payload.json?.requestId === "string" ? payload.json.requestId : undefined;
        return { status: "refused", code, message, ...(requestId ? { requestId } : {}) };
      }
      const games = Array.isArray(payload.json?.games) ? (payload.json!.games as unknown[]).length : null;
      return { status: "ok", games };
    } catch (error) {
      if (error instanceof OAuthError && error.code === "store_login_required") {
        return { status: "not_signed_in", message: error.message.replace(` ${error.recovery}`, "") };
      }
      if (error instanceof OAuthError) return { status: "refused", code: error.code, message: error.message };
      return { status: "unreachable", message: error instanceof Error ? error.message : String(error) };
    }
  })();
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The hosted tool a CLI name means: the exact name, or a slug ("store-list-games" -> summer_store_list_games). */
export function matchHostedTool(name: string, tools: readonly Tool[]): Tool | null {
  const needle = name.trim();
  const asAlias = needle.startsWith("summer_") ? needle : `summer_${needle.replace(/-/g, "_")}`;
  return tools.find((tool) => tool.name === needle) ?? tools.find((tool) => tool.name === asAlias) ?? null;
}

export type HostedToolsListing =
  | { status: "listed"; tools: Tool[] }
  | { status: "not_signed_in" }
  | { status: "unavailable"; message: string };

/** The hosted store and publishing tools, when this machine has a store sign-in. */
export async function listHostedToolsForCli(
  deps: HostedConnectDependencies = defaultHostedConnectDependencies,
  signedIn: () => Promise<boolean> = hasStoreSignIn
): Promise<HostedToolsListing> {
  if (!(await signedIn())) return { status: "not_signed_in" };
  try {
    return { status: "listed", tools: await withHostedMcp(listAllHostedTools, deps) };
  } catch (error) {
    if (error instanceof OAuthError && error.code === "store_login_required") return { status: "not_signed_in" };
    return { status: "unavailable", message: error instanceof Error ? error.message : String(error) };
  }
}

export type HostedCallOutcome =
  | { status: "called"; tool: string; result: Record<string, unknown> }
  | { status: "not_found" }
  | { status: "not_signed_in" }
  | { status: "unavailable"; message: string };

/** Call a hosted tool by its name or slug with the store sign-in (one connection). */
export async function callHostedToolForCli(
  name: string,
  args: Record<string, unknown>,
  deps: HostedConnectDependencies = defaultHostedConnectDependencies,
  signedIn: () => Promise<boolean> = hasStoreSignIn
): Promise<HostedCallOutcome> {
  if (!(await signedIn())) return { status: "not_signed_in" };
  try {
    return await withHostedMcp(async (client) => {
      const tool = matchHostedTool(name, await listAllHostedTools(client));
      if (!tool) return { status: "not_found" } as const;
      return { status: "called", tool: tool.name, result: await client.callTool({ name: tool.name, arguments: args }) } as const;
    }, deps);
  } catch (error) {
    if (error instanceof OAuthError && error.code === "store_login_required") return { status: "not_signed_in" };
    return { status: "unavailable", message: error instanceof Error ? error.message : String(error) };
  }
}

/** The tool a tools/call JSON-RPC body names, for the X-Summer-MCP-Tool header. */
export function calledTool(body: unknown): string | undefined {
  if (typeof body !== "string" || !body.includes('"tools/call"')) return undefined;
  try {
    const message = JSON.parse(body) as { method?: string; params?: { name?: unknown } };
    return message.method === "tools/call" && typeof message.params?.name === "string" ? message.params.name : undefined;
  } catch {
    return undefined;
  }
}
