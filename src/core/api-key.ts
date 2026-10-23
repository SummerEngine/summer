import { resolveAgentHost, summerRequestHeaders } from "./agent-host.js";
import { resolveGatewayUrl } from "./config.js";
import { getSummerDir, readStoreJson, readStoreText, removeStoreFile, writeStoreJson, writeStoreText } from "./store.js";

/**
 * The Summer API key (`sk-summer-v1-...`, the Summer API's one credential),
 * got without copy-paste: start a key request on the gateway, the person
 * presses Allow on the Summer page it names (and checks the code matches),
 * then the next poll answers the key once. The key is stored as
 * ~/.summer/api-key (0600, like auth-token) and never printed; the
 * SUMMER_API_KEY environment variable wins over the file.
 *
 * Gateway contract (PublicSummerEngine app/api/api-keys/requests): POST
 * starts a request ({request_id, user_code, approve_url, poll_url,
 * poll_token, interval, expires_in}); GET poll_url with the poll token
 * answers pending, denied, 410 expired, or approved with the key.
 */

const API_KEY_FILE = "api-key";
/** The request a CLI or MCP session is waiting on, so a second call (or command) continues it. */
const PENDING_FILE = "api-key-request.json";

export interface ApiKeyRequest {
  requestId: string;
  userCode: string;
  approveUrl: string;
  pollUrl: string;
  pollToken: string;
  intervalSeconds: number;
  expiresAt: string;
}

export type ApiKeyPoll =
  | { status: "pending" }
  | { status: "approved"; keyId: string; limitUsd: number | null; expiresAt: string | null }
  | { status: "denied" | "expired" | "failed"; message: string };

export interface ApiKeyDependencies {
  fetch: typeof fetch;
  now: () => number;
}

const defaults: ApiKeyDependencies = { fetch, now: Date.now };

/** The key in effect: SUMMER_API_KEY, else ~/.summer/api-key. */
export async function getApiKey(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const fromEnv = env.SUMMER_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  return (await readStoreText(API_KEY_FILE))?.trim() || null;
}

export function apiKeyPath(): string {
  return `${getSummerDir()}/${API_KEY_FILE}`;
}

export async function clearApiKey(): Promise<number> {
  let removed = 0;
  for (const file of [API_KEY_FILE, PENDING_FILE]) if (await removeStoreFile(file)) removed += 1;
  return removed;
}

/** What the person sees on the Allow page: the agent app this runs in, in plain words. */
export function keyClientName(hostId: string): string {
  const known: Record<string, string> = {
    "claude-code": "Claude Code",
    "claude-desktop": "Claude",
    codex: "Codex",
    cursor: "Cursor",
    windsurf: "Windsurf",
    "gemini-cli": "Gemini CLI",
    "github-copilot": "GitHub Copilot",
    opencode: "OpenCode",
    cline: "Cline",
    zed: "Zed",
  };
  if (known[hostId]) return known[hostId];
  const plain = hostId.replace(/^other\./, "").replace(/[^A-Za-z0-9 ._()+-]+/g, " ").trim().slice(0, 40);
  return plain && hostId !== "unknown" ? plain : "Summer CLI";
}

export class KeyRequestError extends Error {
  constructor(
    readonly code: "keys_unavailable" | "rate_limited" | "request_failed",
    message: string
  ) {
    super(message);
  }
}

/** Start a key request, or continue the one this machine is already waiting on. */
export async function startApiKeyRequest(
  options: { client: string; limitUsd?: number; fresh?: boolean },
  overrides: Partial<ApiKeyDependencies> = {}
): Promise<ApiKeyRequest> {
  const deps = { ...defaults, ...overrides };
  if (!options.fresh) {
    const pending = await readStoreJson<ApiKeyRequest>(PENDING_FILE).catch(() => null);
    if (pending && Date.parse(pending.expiresAt) > deps.now() + 30_000) return pending;
  }
  const gateway = await resolveGatewayUrl();
  const res = await deps.fetch(`${gateway}/api/api-keys/requests`, {
    method: "POST",
    headers: { ...summerRequestHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ client: options.client, ...(options.limitUsd ? { limitUsd: options.limitUsd } : {}) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) {
    throw new KeyRequestError("keys_unavailable", "Summer API is not open yet.");
  }
  if (res.status === 429) {
    throw new KeyRequestError("rate_limited", "Too many key requests from this network. Try again in an hour.");
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !data || typeof data.request_id !== "string" || typeof data.poll_token !== "string") {
    throw new KeyRequestError("request_failed", `The key request failed (${res.status}).`);
  }
  const request: ApiKeyRequest = {
    requestId: data.request_id,
    userCode: String(data.user_code ?? ""),
    approveUrl: String(data.approve_url ?? ""),
    pollUrl: String(data.poll_url ?? `${gateway}/api/api-keys/requests/${data.request_id}`),
    pollToken: data.poll_token,
    intervalSeconds: typeof data.interval === "number" && data.interval > 0 ? data.interval : 2,
    expiresAt: new Date(deps.now() + (typeof data.expires_in === "number" ? data.expires_in : 600) * 1000).toISOString(),
  };
  await writeStoreJson(PENDING_FILE, request);
  return request;
}

/** One poll. On approved the key is saved to ~/.summer/api-key and the request forgotten. */
export async function pollApiKeyRequest(request: ApiKeyRequest, overrides: Partial<ApiKeyDependencies> = {}): Promise<ApiKeyPoll> {
  const deps = { ...defaults, ...overrides };
  if (Date.parse(request.expiresAt) <= deps.now()) {
    await removeStoreFile(PENDING_FILE);
    return { status: "expired", message: "The key request expired before it was allowed. Start again." };
  }
  const res = await deps.fetch(request.pollUrl, {
    headers: { ...summerRequestHeaders(), Authorization: `Bearer ${request.pollToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.ok && data?.status === "pending") return { status: "pending" };
  if (res.ok && data?.status === "approved" && typeof data.key === "string") {
    await writeStoreText(API_KEY_FILE, `${data.key.trim()}\n`);
    await removeStoreFile(PENDING_FILE);
    return {
      status: "approved",
      keyId: String(data.key_id ?? ""),
      limitUsd: typeof data.limit_usd === "number" ? data.limit_usd : null,
      expiresAt: typeof data.expires_at === "string" ? data.expires_at : null,
    };
  }
  if (res.ok && data?.status === "denied") {
    await removeStoreFile(PENDING_FILE);
    return { status: "denied", message: "The person denied the key request." };
  }
  if (res.status === 410) {
    await removeStoreFile(PENDING_FILE);
    return { status: "expired", message: "The key request expired or was already used. Start again." };
  }
  if (res.status >= 500 || res.status === 429) return { status: "pending" };
  await removeStoreFile(PENDING_FILE);
  return { status: "failed", message: typeof data?.message === "string" ? data.message : `The key request failed (${res.status}).` };
}

/** Poll until the person answers or `timeoutMs` passes (then still pending). */
export async function waitForApiKey(
  request: ApiKeyRequest,
  options: { timeoutMs: number; sleep?: (ms: number) => Promise<void> },
  overrides: Partial<ApiKeyDependencies> = {}
): Promise<ApiKeyPoll> {
  const deps = { ...defaults, ...overrides };
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const until = deps.now() + options.timeoutMs;
  for (;;) {
    let poll: ApiKeyPoll;
    try {
      poll = await pollApiKeyRequest(request, deps);
    } catch {
      poll = { status: "pending" };
    }
    if (poll.status !== "pending" || deps.now() >= until) return poll;
    await sleep(request.intervalSeconds * 1000);
  }
}

/** How long one summer_api_key_login call waits for the Allow click before answering needs_approval. */
export const API_KEY_TOOL_WAIT_MS = 25_000;

/**
 * summer_api_key_login (MCP and `summer tool api-key-login`): ready when a key
 * is saved; otherwise start or continue the request, wait up to 25 seconds,
 * and answer ready, needs_approval (call again) or why not. Never the key.
 */
export async function apiKeyLoginAnswer(
  args: { limitUsd?: number; fresh?: boolean },
  options: { waitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  overrides: Partial<ApiKeyDependencies> = {}
): Promise<Record<string, unknown>> {
  if (!args.fresh && (await getApiKey())) {
    return { ok: true, status: "ready", key_file: apiKeyPath(), env: "SUMMER_API_KEY" };
  }
  try {
    const request = await startApiKeyRequest(
      { client: keyClientName(resolveAgentHost().id), ...(args.limitUsd ? { limitUsd: args.limitUsd } : {}), fresh: args.fresh === true },
      overrides
    );
    const answer = await waitForApiKey(request, { timeoutMs: options.waitMs ?? API_KEY_TOOL_WAIT_MS, ...(options.sleep ? { sleep: options.sleep } : {}) }, overrides);
    if (answer.status === "approved") {
      return { ok: true, status: "ready", key_file: apiKeyPath(), env: "SUMMER_API_KEY", key_id: answer.keyId, limit_usd: answer.limitUsd, expires_at: answer.expiresAt };
    }
    if (answer.status === "pending") {
      return {
        ok: true,
        status: "needs_approval",
        approve_url: request.approveUrl,
        user_code: request.userCode,
        expires_at: request.expiresAt,
        next: "Give the person approve_url, ask them to check it shows user_code and press Allow, then call summer_api_key_login again.",
      };
    }
    return { ok: false, status: answer.status, message: answer.message };
  } catch (error) {
    const code = error instanceof KeyRequestError ? error.code : "request_failed";
    return { ok: false, error: code, message: error instanceof Error ? error.message : String(error) };
  }
}
