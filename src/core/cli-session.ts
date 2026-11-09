/**
 * The browser sign-in for the Summer account (the `cli_session` flow): the
 * person opens `{gateway}/login?cli_session=<id>`, signs in, and approves;
 * this polls `{gateway}/api/auth/cli-login?session=<id>` until the gateway
 * hands over the CLI token, then saves it to ~/.summer (the files the desktop
 * engine and every tool read). `summer login` and the MCP's sign-in link
 * (core/sign-in-link.ts) share it.
 */

import { saveLoginSession, type LoginSession } from "./auth.js";
import { summerRequestHeaders } from "./agent-host.js";

const POLL_INTERVAL_MS = 2000;
// One generous window on ONE session id. First-time users may need to create an
// account and confirm an email before they can approve the CLI. The gateway
// never expires a pending session (the completed payload waits under this id
// for pickup), so the worst mistake would be rotating ids mid-wait — the user
// would approve the original browser tab while we poll a different session.
export const POLL_TIMEOUT_MS = 900000;
const HEARTBEAT_MS = 30000;

export interface CliSessionPollDependencies {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (message: string) => void;
  /** Stop waiting (another sign-in already saved a token, the server is closing). */
  cancelled?: () => boolean | Promise<boolean>;
}

/** The gateway answered with a terminal 4xx — retrying the same URL cannot help. */
class LoginRejectedError extends Error {}

/** The page the person opens to sign in. */
export function cliSessionLoginUrl(gatewayUrl: string, sessionId: string): string {
  return `${gatewayUrl}/login?cli_session=${encodeURIComponent(sessionId)}`;
}

/**
 * Wait for the browser sign-in of `sessionId`, save it, and return it.
 * Throws on a rejected request, an invalid token, a timeout, or `cancelled`.
 */
export async function pollCliSession(
  gatewayUrl: string,
  sessionId: string,
  deps: CliSessionPollDependencies
): Promise<LoginSession> {
  const loginUrl = cliSessionLoginUrl(gatewayUrl, sessionId);
  const pollUrl = `${gatewayUrl}/api/auth/cli-login?session=${encodeURIComponent(sessionId)}`;
  const startTime = deps.now();
  let lastHeartbeat = startTime;
  let lastError: string | null = null;

  while (deps.now() - startTime < POLL_TIMEOUT_MS) {
    await deps.sleep(POLL_INTERVAL_MS);
    if (deps.cancelled && (await deps.cancelled())) {
      throw new Error("The sign-in wait was cancelled.");
    }

    if (deps.now() - lastHeartbeat >= HEARTBEAT_MS) {
      lastHeartbeat = deps.now();
      deps.log(
        'Still waiting — finish signing in (or creating your account) in the browser, then click "Yes, Sign In". Same link: ' +
          loginUrl +
          (lastError ? ` (last error: ${lastError})` : "")
      );
    }

    // Only the network round-trip is retried. A completed session is handled
    // OUTSIDE this try: saveLoginSession rejecting the token (mismatched sub,
    // non-CLI token type, already expired) is terminal — the gateway will
    // return the same payload forever, so polling on would only bury the
    // recovery message under a 15-minute timeout.
    let completed: LoginSession | null = null;
    try {
      const res = await deps.fetch(pollUrl, {
        headers: summerRequestHeaders({ surface: "cli" }),
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        if (res.status === 503) {
          lastError =
            "The login service is unavailable (Redis/auth is not configured).";
        } else if (res.status >= 500) {
          lastError = `The login service failed (${res.status}).`;
        } else if (res.status === 429 || res.status === 408) {
          lastError = `The login service asked us to slow down (${res.status}).`;
        } else {
          // 401/403/404 and the other 4xx are terminal: this URL will not
          // start succeeding on its own.
          throw new LoginRejectedError(
            `The login request was rejected (${res.status}). Recovery: check that gateway.url (${gatewayUrl}) is the Summer gateway you meant, then run "summer login" again.`
          );
        }
        continue;
      }

      const data = (await res.json()) as {
        status: string;
        token?: string;
        user?: { id: string; email: string; name?: string };
        scopes?: string[];
      };

      if (data.status === "pending") continue;

      if (data.status === "complete" && data.token) {
        completed = { token: data.token, user: data.user, scopes: data.scopes };
      } else {
        lastError = "The login service returned an incomplete authentication result.";
      }
    } catch (err) {
      if (err instanceof LoginRejectedError) throw err;
      lastError = err instanceof Error ? err.message : "Network error";
    }

    if (completed) {
      await saveLoginSession(completed);
      return completed;
    }
  }

  throw new Error(
    `Login timed out after ${Math.round(POLL_TIMEOUT_MS / 60000)} minutes.${lastError ? ` Last error: ${lastError}` : ""} Recovery: run "summer login" again and complete "Yes, Sign In" in the browser tab it opens.`
  );
}
