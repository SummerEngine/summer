/**
 * Pure-telemetry beacon for MCP usage. Fire-and-forget, never blocks, never throws.
 * One ping per MCP server lifetime — counts daily-active users, not per-tool calls.
 *
 * The endpoint /api/mcp/log-local-call always returns allowed:true and never gates.
 * No quota. The user account is the only thing being attributed; the response is
 * ignored entirely on the CLI side.
 */
import { getAuthToken } from "./auth.js";
import { resolveGatewayUrl } from "./config.js";

const TELEMETRY_PATH = "/api/mcp/log-local-call";
const TIMEOUT_MS = 5000;

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
  if (pinged) return;
  pinged = true;

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
          body: JSON.stringify({
            client: "summer-cli",
            event: "mcp_session_start",
          }),
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
