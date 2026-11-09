import { AsyncLocalStorage } from "node:async_hooks";
import { TOOLKIT_VERSION } from "./version.js";

/**
 * Which agent app runs Summer (Claude Code, Codex, Cursor, ...) and which tool
 * made a request, sent as headers on every request to Summer's servers
 * (summerengine.com and the hosted Summer Engine MCP), so usage can be
 * counted per agent app and per tool.
 *
 * The server reads X-Summer-Agent-Host / X-Summer-Agent-Host-Source
 * (publicsummerengine src/lib/mcp/agent-host.ts) into the attribution of the
 * usage rows a request causes, and X-Summer-MCP-Tool on generation errors.
 * X-Summer-Agent-Host-Name / -Version carry the MCP handshake's clientInfo
 * as the app sent it.
 *
 * Host resolution: SUMMER_AGENT_HOST (explicit override), then the MCP
 * initialize handshake's clientInfo.name, then the environment an agent sets
 * for the commands it runs (the CLI surface), else "unknown".
 *
 * SUMMER_NO_TELEMETRY=1 / DO_NOT_TRACK=1 drop the host and tool headers; the
 * product headers (X-Summer-Client, -Version, -Surface) stay, like a
 * user agent.
 */

export const AGENT_HOST_HEADER = "X-Summer-Agent-Host";
export const AGENT_HOST_SOURCE_HEADER = "X-Summer-Agent-Host-Source";
export const AGENT_HOST_NAME_HEADER = "X-Summer-Agent-Host-Name";
export const AGENT_HOST_VERSION_HEADER = "X-Summer-Agent-Host-Version";
export const MCP_TOOL_HEADER = "X-Summer-MCP-Tool";
export const AGENT_HOST_OVERRIDE_ENV = "SUMMER_AGENT_HOST";

export type AgentHostSource = "override" | "mcp-client" | "env" | "none";
export type ClientSurface = "mcp" | "cli";

export interface AgentHost {
  id: string;
  source: AgentHostSource;
}

export interface McpClientInfo {
  name?: string;
  version?: string;
}

type Env = Record<string, string | undefined>;

/** The opt-out switches, the same two the library feedback mailbox honors. */
/** SUMMER_NO_TELEMETRY or DO_NOT_TRACK set to 1, true, yes or on. */
export function isTelemetryDisabled(env: Env = process.env): boolean {
  const on = (value: string | undefined) => value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());
  return on(env.SUMMER_NO_TELEMETRY) || on(env.DO_NOT_TRACK);
}

const set = (env: Env, key: string) => {
  const value = env[key];
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
};

/**
 * Variables hosts set for the commands they run, most specific first (the
 * convention @vercel/detect-agent reads). CURSOR_TRACE_ID is last: Cursor sets
 * it in every integrated terminal, so Claude Code or Codex inside Cursor wins.
 */
const ENV_SIGNALS: ReadonlyArray<{ id: string; test: (env: Env) => boolean }> = [
  { id: "claude-code", test: (e) => set(e, "CLAUDECODE") || set(e, "CLAUDE_CODE") || set(e, "CLAUDE_CODE_ENTRYPOINT") },
  { id: "codex", test: (e) => set(e, "CODEX_SANDBOX") || set(e, "CODEX_CI") || set(e, "CODEX_THREAD_ID") },
  { id: "gemini-cli", test: (e) => set(e, "GEMINI_CLI") },
  { id: "antigravity", test: (e) => set(e, "ANTIGRAVITY_AGENT") },
  { id: "augment", test: (e) => set(e, "AUGMENT_AGENT") },
  { id: "opencode", test: (e) => set(e, "OPENCODE_CLIENT") },
  { id: "github-copilot", test: (e) => set(e, "COPILOT_MODEL") || set(e, "COPILOT_ALLOW_ALL") || set(e, "COPILOT_GITHUB_TOKEN") },
  { id: "cursor", test: (e) => set(e, "CURSOR_AGENT") || e.CURSOR_EXTENSION_HOST_ROLE === "agent-exec" },
  { id: "replit", test: (e) => set(e, "REPL_ID") },
  { id: "cursor", test: (e) => set(e, "CURSOR_TRACE_ID") },
];

/**
 * clientInfo.name patterns (lowercased), most specific first. Names are what
 * each app sends in `initialize`, matched loosely so a renamed build lands.
 */
const MCP_CLIENT_PATTERNS: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: "claude-code", pattern: /claude[-_ ]?code/ },
  { id: "claude-desktop", pattern: /^claude(-ai)?$|claude[-_ ]desktop/ },
  { id: "codex", pattern: /codex/ },
  { id: "cursor", pattern: /cursor/ },
  { id: "windsurf", pattern: /windsurf|codeium|cascade|devin/ },
  { id: "gemini-cli", pattern: /gemini/ },
  { id: "antigravity", pattern: /antigravity/ },
  { id: "openclaw", pattern: /openclaw|clawdbot|moltbot/ },
  { id: "hermes", pattern: /hermes/ },
  { id: "grok", pattern: /grok/ },
  { id: "chatgpt", pattern: /chatgpt|openai/ },
  { id: "roo-code", pattern: /roo[-_ ]?(code|cline)/ },
  { id: "kilo-code", pattern: /kilo/ },
  { id: "cline", pattern: /cline/ },
  { id: "github-copilot", pattern: /copilot/ },
  { id: "vscode", pattern: /visual studio code|vscode/ },
  { id: "visual-studio", pattern: /visual studio/ },
  { id: "zed", pattern: /\bzed\b/ },
  { id: "opencode", pattern: /opencode/ },
  { id: "goose", pattern: /goose/ },
  { id: "amp", pattern: /\bamp\b/ },
  { id: "kiro", pattern: /kiro/ },
  { id: "trae", pattern: /trae/ },
  { id: "qwen-code", pattern: /qwen/ },
  { id: "kimi-code", pattern: /kimi/ },
  { id: "crush", pattern: /crush/ },
  { id: "factory", pattern: /factory|droid/ },
  { id: "junie", pattern: /junie|jetbrains/ },
  { id: "warp", pattern: /warp/ },
  { id: "rovo-dev", pattern: /rovo/ },
  { id: "qoder", pattern: /qoder/ },
  { id: "mistral-vibe", pattern: /mistral|vibe/ },
  { id: "lm-studio", pattern: /lm[-_ ]?studio/ },
  { id: "continue", pattern: /continue/ },
  { id: "augment", pattern: /augment/ },
  { id: "replit", pattern: /replit/ },
];

/** Lowercase `[a-z0-9-]`, at most 40 characters: the server's host id shape. */
export function sanitizeHostId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function matchClientPattern(name: string): string | null {
  const lower = name.toLowerCase();
  return MCP_CLIENT_PATTERNS.find(({ pattern }) => pattern.test(lower))?.id ?? null;
}

/** A known host id, or "other.<name>" for a client Summer does not know yet. */
export function hostFromClientName(name: string | undefined | null): string | null {
  if (!name) return null;
  const known = matchClientPattern(name);
  if (known) return known;
  const fallback = sanitizeHostId(name);
  return fallback ? `other.${fallback}` : null;
}

/** AI_AGENT ("<name>_<version>_<mode>") first, then the per-host variables. */
export function hostFromEnv(env: Env): string | null {
  if (env.AI_AGENT) {
    const declared = hostFromClientName(env.AI_AGENT.split("_")[0]);
    if (declared) return declared;
  }
  return ENV_SIGNALS.find(({ test }) => test(env))?.id ?? null;
}

// The MCP server registers a getter; it is read at request time, after the
// initialize handshake has given the client's name and version.
let mcpClientSource: (() => McpClientInfo | undefined) | null = null;

/** `mcp` inside `summer mcp` (it registers its handshake), `cli` for every other command. */
export function processSurface(): ClientSurface {
  return mcpClientSource ? "mcp" : "cli";
}

export function registerMcpClientSource(source: (() => McpClientInfo | undefined) | null): void {
  mcpClientSource = source;
}

export function currentMcpClient(): McpClientInfo | undefined {
  try {
    return mcpClientSource?.() ?? undefined;
  } catch {
    return undefined;
  }
}

export function resolveAgentHost(env: Env = process.env, client: McpClientInfo | undefined = currentMcpClient()): AgentHost {
  const override = env[AGENT_HOST_OVERRIDE_ENV] ? sanitizeHostId(env[AGENT_HOST_OVERRIDE_ENV]!) : "";
  if (override) return { id: override, source: "override" };
  const fromClient = hostFromClientName(client?.name);
  if (fromClient) return { id: fromClient, source: "mcp-client" };
  const fromEnv = hostFromEnv(env);
  if (fromEnv) return { id: fromEnv, source: "env" };
  return { id: "unknown", source: "none" };
}

interface ToolContext {
  tool: string;
  surface: ClientSurface;
  /** Usage fields the call noted for its usage line (telemetry.ts noteToolUsage);
   *  one object shared with any tool it runs, so the outer call's line has them. */
  usage: Record<string, unknown>;
}

const toolContext = new AsyncLocalStorage<ToolContext>();

/** Run one tool call so every Summer request it makes names the tool and surface. */
export function runWithToolContext<T>(tool: string, surface: ClientSurface, fn: () => T): T {
  return toolContext.run({ tool, surface, usage: toolContext.getStore()?.usage ?? {} }, fn);
}

/** The tool call running now, if any (a tool that runs inside another one sees the outer call). */
export function currentToolContext(): ToolContext | undefined {
  return toolContext.getStore();
}

/** Printable ASCII only, so a header value never breaks a request. */
const headerValue = (value: string, max: number) => value.replace(/[^\x20-\x7e]/g, "").trim().slice(0, max);

/**
 * Headers for a request to Summer's servers. `tool` names the tool when no
 * tool call is running (the endpoint's own tool); a running call's tool wins.
 */
export function summerRequestHeaders(
  options: { tool?: string; surface?: ClientSurface } = {},
  env: Env = process.env
): Record<string, string> {
  const context = toolContext.getStore();
  const surface = context?.surface ?? options.surface ?? processSurface();
  const headers: Record<string, string> = {
    "X-Summer-Client": "summer-cli",
    "X-Summer-Client-Version": TOOLKIT_VERSION,
    "X-Summer-Client-Surface": surface,
  };
  if (isTelemetryDisabled(env)) return headers;

  const client = surface === "mcp" ? currentMcpClient() : undefined;
  const host = resolveAgentHost(env, client);
  headers[AGENT_HOST_HEADER] = host.id;
  headers[AGENT_HOST_SOURCE_HEADER] = host.source;
  const name = client?.name ? headerValue(client.name, 64) : "";
  const version = client?.version ? headerValue(client.version, 32) : "";
  if (name) headers[AGENT_HOST_NAME_HEADER] = name;
  if (version) headers[AGENT_HOST_VERSION_HEADER] = version;
  const tool = context?.tool ?? options.tool;
  if (tool) headers[MCP_TOOL_HEADER] = tool;
  return headers;
}
