/**
 * Usage beacons for the local MCP server. Fire-and-forget, never blocks, never throws.
 *
 * - One session ping per MCP server lifetime (mcp_session_start), on the
 *   first tool call, with the host app's name from the MCP handshake.
 * - One line per local tool call (mcp_tool_call): the tool name, the
 *   Summer operation it ran, success, duration, the host app's name from the
 *   MCP handshake, and the tool surface and profile. Nothing else: no
 *   arguments, no results, no project or file names.
 *
 * Both go to /api/mcp/log-local-call, only when signed in (the account token
 * attributes them), and never when SUMMER_NO_TELEMETRY=1 or DO_NOT_TRACK=1.
 * The endpoint always returns allowed:true and never gates; the response is
 * ignored.
 */
import { currentMcpClient, isTelemetryDisabled, summerRequestHeaders } from "./agent-host.js";
import { getAuthToken } from "./auth.js";
import { resolveGatewayUrl } from "./config.js";

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
  send({ client: "summer-cli", event: "mcp_session_start", ...(mcpClient ? { mcpClient: mcpClient.slice(0, 64) } : {}) });
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
}

/** Report one local tool call: tool name, success, duration, host app name. */
export function recordLocalToolCall(call: LocalToolCall): void {
  if (isTelemetryDisabled() || !TOOL_NAME.test(call.tool)) return;
  send({
    client: "summer-cli",
    event: "mcp_tool_call",
    ...(call.mcpClient ? { mcpClient: call.mcpClient.slice(0, 64) } : {}),
    tool: call.tool,
    ...(call.op ? { op: call.op } : {}),
    ...(call.surfaceVersion ? { surfaceVersion: call.surfaceVersion } : {}),
    ...(call.profile ? { profile: call.profile } : {}),
    ok: call.ok,
    durationMs: Math.max(0, Math.round(call.durationMs)),
  });
}

function send(body: Record<string, unknown>): void {
  // Void-discarded so the caller never accidentally awaits us.
  void postUsage(body);
}

/** POST one usage line with the account token; resolves when sent or given up. Never throws. */
export async function postUsage(body: Record<string, unknown>, timeoutMs = TIMEOUT_MS): Promise<void> {
  try {
    const token = await getAuthToken();
    if (!token) return; // unauthenticated usage is allowed; we just can't attribute it
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
}

/**
 * Reset the once-per-session guard. Test-only.
 */
export function _resetTelemetryPingedForTests(): void {
  pinged = false;
}
