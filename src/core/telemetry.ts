/**
 * Usage beacons for the local MCP server. Fire-and-forget, never blocks, never throws.
 *
 * - One session ping per MCP server lifetime (mcp_session_start), on the
 *   first tool call, with the host app's name from the MCP handshake and
 *   this machine's install id, so the anonymous first-run line (below) joins
 *   the account.
 * - One line per local tool call (mcp_tool_call): the tool name, the
 *   Summer operation it ran, success, duration, the host app's name from the
 *   MCP handshake, and the tool surface and profile, plus the closed-shape
 *   fields of usage-fields.ts (project id hash, template, game clients
 *   started, engine state on engine_not_running). Nothing else: no
 *   arguments, no results, no project or file names.
 * - Once per machine, the first `summer` command (any, `summer mcp` too)
 *   prints a short notice to stderr and sends one anonymous line
 *   (cli_first_run): the install id, the command name, the agent app and the
 *   operating system. It is the only line sent without an account.
 *
 * The session and call lines go to /api/mcp/log-local-call only when signed
 * in (the account token attributes them). Nothing is sent when
 * SUMMER_NO_TELEMETRY=1 or DO_NOT_TRACK=1. The endpoint always returns
 * allowed:true and never gates; the response is ignored.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { currentMcpClient, isTelemetryDisabled, resolveAgentHost, summerRequestHeaders } from "./agent-host.js";
import { getAuthToken } from "./auth.js";
import { resolveGatewayUrl } from "./config.js";
import { getInstallId } from "./feedback/client.js";
import { readStoreText, writeStoreText } from "./store.js";
import { usageLineFields, type UsageFields } from "./usage-fields.js";

export { isTelemetryDisabled };

const TELEMETRY_PATH = "/api/mcp/log-local-call";
const TIMEOUT_MS = 5000;

const TOOL_NAME = /^summer_[a-z0-9_]{1,64}$/;

let pinged = false;

/**
 * Ping the telemetry endpoint once per MCP server lifetime.
 *
 * - No await: returns synchronously after kicking off the request.
 * - No throw: every error is swallowed.
 * - No retry: a single best-effort attempt.
 * - Skips entirely if no auth token is on disk (anonymous users still work).
 */
export function recordMcpSession(): void {
  if (pinged || isTelemetryDisabled()) return;
  pinged = true;
  const mcpClient = currentMcpClient()?.name;
  void (async () => {
    const installId = await getInstallId();
    await postUsage({ client: "summer-cli", event: "mcp_session_start", ...(mcpClient ? { mcpClient: mcpClient.slice(0, 64) } : {}), installId });
  })();
}

export interface LocalToolCall {
  tool: string;
  ok: boolean;
  durationMs: number;
  /** The host app's name from the MCP handshake (clientInfo.name). */
  mcpClient?: string;
  /** The Summer operation the call ran (core/ops/contract.ts opForToolCall). */
  op?: string | null;
  /** The tool surface: v3 (3.x names) or v4 (the operation catalog). */
  surfaceVersion?: "v3" | "v4";
  /** The MCP profile: full, engine, assets or custom. */
  profile?: string;
  /** A failed call's error code (toolErrorCode); never sent for a call that worked. */
  error?: string | null;
  /** What the call noted (usage-fields.ts noteToolUsage) and the bound project. */
  usage?: UsageFields;
}

const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The code a failed tool result names, read from its first text block: the
 * one answer shape's `error.code`, the 3.x `code`, then an engine
 * `failure_reason`. Codes only, never the message or anything else.
 */
export function toolErrorCode(result: unknown, fallback?: string): string | null {
  const content = (result as { content?: unknown } | null)?.content;
  const text = Array.isArray(content) ? (content[0] as { text?: unknown } | undefined)?.text : undefined;
  let parsed: Record<string, unknown> | null = null;
  if (typeof text === "string" && text.length < 200_000) {
    try {
      const value: unknown = JSON.parse(text);
      if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
    } catch {
      // plain text: no code in it
    }
  }
  const nested = parsed?.error && typeof parsed.error === "object" ? (parsed.error as Record<string, unknown>).code : undefined;
  for (const candidate of [nested, parsed?.code, parsed?.failure_reason, fallback]) {
    if (typeof candidate === "string" && ERROR_CODE.test(candidate)) return candidate;
  }
  return null;
}

/** Report one local tool call: tool name, success, duration, host app name. */
export function recordLocalToolCall(call: LocalToolCall): void {
  if (isTelemetryDisabled() || !TOOL_NAME.test(call.tool)) return;
  const error = !call.ok && call.error && ERROR_CODE.test(call.error) ? call.error : null;
  send({
    client: "summer-cli",
    event: "mcp_tool_call",
    ...(call.mcpClient ? { mcpClient: call.mcpClient.slice(0, 64) } : {}),
    tool: call.tool,
    ...(call.op ? { op: call.op } : {}),
    ...(call.surfaceVersion ? { surfaceVersion: call.surfaceVersion } : {}),
    ...(call.profile ? { profile: call.profile } : {}),
    ok: call.ok,
    ...(error ? { error } : {}),
    durationMs: Math.max(0, Math.round(call.durationMs)),
  }, call.usage ?? {}, error);
}

function send(body: Record<string, unknown>, usage: UsageFields, error: string | null): void {
  // Void-discarded so the caller never accidentally awaits us.
  void (async () => postUsage({ ...body, ...(await usageLineFields(usage, error)) }))();
}

/** POST one usage line with the account token; resolves when sent or given up. Never throws. */
export async function postUsage(body: Record<string, unknown>, timeoutMs = TIMEOUT_MS, options: { anonymous?: boolean } = {}): Promise<void> {
  try {
    // The first-run line is the one line sent without an account token.
    const token = options.anonymous ? null : await getAuthToken();
    if (!token && !options.anonymous) return; // unauthenticated usage is allowed; we just can't attribute it
    // Resolved per call, not at import: the gateway the token belongs to is
    // whatever env/config says NOW (see config.resolveGatewayUrl).
    const gatewayUrl = await resolveGatewayUrl();

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      await fetch(`${gatewayUrl}${TELEMETRY_PATH}`, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          ...summerRequestHeaders(),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // never throws — telemetry is best-effort
  }
}

const NOTICE_MARKER_FILE = "telemetry-notice";
const COMMAND = /^[a-z][a-z0-9_]{0,79}$/;
const BEACON = fileURLToPath(new URL("./cli-usage-beacon.js", import.meta.url));

/** The one-time notice, printed to stderr (never stdout: `summer mcp` speaks MCP there). */
export const TELEMETRY_NOTICE = [
  "Summer collects usage data to improve its tools: which commands and tools run, whether they worked, and which agent app ran them.",
  "No prompts, code, file names or project names. Opt out: SUMMER_NO_TELEMETRY=1",
  "Details: https://github.com/summerengine/summer#telemetry",
].join("\n");

export interface FirstRunDeps {
  env?: NodeJS.ProcessEnv;
  write?: (text: string) => void;
  send?: (body: Record<string, unknown>) => void;
}

/** CI runs and this repo's own tests are not people trying Summer. */
function automatedRun(env: NodeJS.ProcessEnv): boolean {
  const on = (value: string | undefined) => !!value && value !== "0" && value.toLowerCase() !== "false";
  return on(env.CI) || on(env.VITEST);
}

/**
 * The first `summer` command on this machine: print the notice once, then
 * send one anonymous cli_first_run line (install id, command name, agent
 * app, operating system). Nothing when opted out, in CI, or when the marker
 * cannot be written (no line without the notice). Returns whether it ran.
 */
export async function noteFirstRun(command: string, deps: FirstRunDeps = {}): Promise<boolean> {
  const env = deps.env ?? process.env;
  try {
    if (isTelemetryDisabled(env) || automatedRun(env)) return false;
    if ((await readStoreText(NOTICE_MARKER_FILE)) !== null) return false;
    await writeStoreText(NOTICE_MARKER_FILE, new Date().toISOString());
    (deps.write ?? ((text: string) => process.stderr.write(text)))(`${TELEMETRY_NOTICE}\n\n`);
    const body = {
      client: "summer-cli",
      event: "cli_first_run",
      installId: await getInstallId(),
      ...(COMMAND.test(command) ? { command } : {}),
      mcpClient: resolveAgentHost(env, undefined).id,
      os: process.platform,
    };
    (deps.send ?? sendAnonymous)(body);
    return true;
  } catch {
    return false;
  }
}

/** A detached child sends it, so no command waits for the network or loses it to process.exit(). */
function sendAnonymous(body: Record<string, unknown>): void {
  try {
    spawn(process.execPath, [BEACON, JSON.stringify(body), "--anonymous"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: (process.env.NODE_OPTIONS ?? "").replace(/--inspect\S*/g, "").trim() },
    }).unref();
  } catch {
    // best-effort
  }
}

/**
 * Reset the once-per-session guard. Test-only.
 */
export function _resetTelemetryPingedForTests(): void {
  pinged = false;
}
