/**
 * Usage beacons for the local MCP server. Fire-and-forget, never blocks, never throws.
 *
 * - One session ping per MCP server lifetime (mcp_session_start).
 * - One line per local tool call (mcp_tool_call): the tool name, success,
 *   duration and the host app's name from the MCP handshake. Nothing else:
 *   no arguments, no results, no project or file names.
 *
 * Both go to /api/mcp/log-local-call, only when signed in (the account token
 * attributes them), and never when SUMMER_NO_TELEMETRY=1 or DO_NOT_TRACK=1.
 * The endpoint always returns allowed:true and never gates; the response is
 * ignored.
 */
import { getAuthToken } from "./auth.js";
import { resolveGatewayUrl } from "./config.js";

const TELEMETRY_PATH = "/api/mcp/log-local-call";
const TIMEOUT_MS = 5000;

const TOOL_NAME = /^summer_[a-z0-9_]{1,64}$/;

let pinged = false;

/** The opt-out switches, the same two the library feedback mailbox honors. */
export function isTelemetryDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SUMMER_NO_TELEMETRY === "1" || env.DO_NOT_TRACK === "1";
}

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
  send({ client: "summer-cli", event: "mcp_session_start" });
}

export interface LocalToolCall {
  tool: string;
  ok: boolean;
  durationMs: number;
  /** The host app's name from the MCP handshake (clientInfo.name). */
  mcpClient?: string;
}

/** Report one local tool call: tool name, success, duration, host app name. */
export function recordLocalToolCall(call: LocalToolCall): void {
  if (isTelemetryDisabled() || !TOOL_NAME.test(call.tool)) return;
  send({
    client: "summer-cli",
    event: "mcp_tool_call",
    ...(call.mcpClient ? { mcpClient: call.mcpClient.slice(0, 64) } : {}),
    tool: call.tool,
    ok: call.ok,
    durationMs: Math.max(0, Math.round(call.durationMs)),
  });
}

function send(body: Record<string, unknown>): void {
  // Wrap the entire async pipeline in a void-discarded promise so the caller
  // never accidentally awaits us.
  void (async () => {
    try {
      const token = await getAuthToken();
      if (!token) return; // unauthenticated MCP usage is allowed; we just can't attribute it
      // Resolved per call, not at import: the gateway the token belongs to is
      // whatever env/config says NOW (see config.resolveGatewayUrl).
      const gatewayUrl = await resolveGatewayUrl();

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        await fetch(`${gatewayUrl}${TELEMETRY_PATH}`, {
          method: "POST",
          signal: ctrl.signal,
          headers: {
            Authorization: `Bearer ${token}`,
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
  })();
}

/**
 * Reset the once-per-session guard. Test-only.
 */
export function _resetTelemetryPingedForTests(): void {
  pinged = false;
}
