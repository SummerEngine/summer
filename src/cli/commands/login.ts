import { Command } from "commander";
import { randomUUID } from "crypto";
import open from "open";
import {
  getAuthToken,
  saveLoginSession,
  type LoginSession,
} from "../../core/auth.js";
import { resolveGatewayUrl } from "../../core/config.js";
import { readStoredOAuthToken, runStoreLogin } from "../../core/oauth.js";

const POLL_INTERVAL_MS = 2000;
// One generous window on ONE session id. First-time users may need to create an
// account and confirm an email before they can approve the CLI. The gateway
// never expires a pending session (the completed payload waits under this id
// for pickup), so the worst mistake would be rotating ids mid-wait — the user
// would approve the original browser tab while we poll a different session.
const POLL_TIMEOUT_MS = 900000;
const HEARTBEAT_MS = 30000;

export const loginCommand = new Command("login")
  .description("Sign in to Summer Engine via your browser")
  .option(
    "--store",
    "Sign in to the Summer store so agents can upload builds (summer_publish_build)"
  )
  .option("--force", "Force re-authentication even if already logged in")
  .action(async (opts: { store?: boolean; force?: boolean }) => {
    if (opts.store) {
      if ((await readStoredOAuthToken()) && !opts.force) {
        console.log(
          "Already signed in to the Summer store. Use --store --force to sign in again."
        );
        return;
      }
      // --force also registers a new client, the way back if this machine's was removed.
      await runStoreLogin({ fetch, now: Date.now, openUrl: open, log: console.log, newClient: Boolean(opts.force) });
      console.log(
        "Signed in to the Summer store. Your core Summer login was not changed."
      );
      return;
    }
    const existing = await getAuthToken();
    if (existing && !opts.force) {
      console.log("Already logged in. Use --force to re-authenticate.");
      return;
    }

    await runLogin();
  });

/** The gateway answered with a terminal 4xx — retrying the same URL cannot help. */
class LoginRejectedError extends Error {}

export interface LoginDependencies {
  fetch: typeof fetch;
  openUrl: (url: string) => Promise<unknown>;
  randomId: () => string;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (message: string) => void;
}

const defaultDependencies: LoginDependencies = {
  fetch,
  openUrl: open,
  randomId: randomUUID,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
  log: console.log,
};

export async function runLogin(
  overrides: Partial<LoginDependencies> = {}
): Promise<void> {
  const deps = { ...defaultDependencies, ...overrides };
  const gatewayUrl = await resolveGatewayUrl();
  const sessionId = deps.randomId();

  const loginUrl = `${gatewayUrl}/login?cli_session=${encodeURIComponent(sessionId)}`;
  deps.log("Sign in at: " + loginUrl);
  deps.log("");

  try {
    await deps.openUrl(loginUrl);
  } catch {
    deps.log("Could not open browser. Copy the URL above and open it manually.");
    deps.log("");
  }

  deps.log("Waiting for authentication...");

  const pollUrl = `${gatewayUrl}/api/auth/cli-login?session=${encodeURIComponent(sessionId)}`;
  const startTime = deps.now();
  let lastHeartbeat = startTime;
  let lastError: string | null = null;

  while (deps.now() - startTime < POLL_TIMEOUT_MS) {
    await deps.sleep(POLL_INTERVAL_MS);

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
      deps.log(`\nLogged in as ${completed.user?.email || "unknown"}`);
      return;
    }
  }

  throw new Error(
    `Login timed out after ${Math.round(POLL_TIMEOUT_MS / 60000)} minutes.${lastError ? ` Last error: ${lastError}` : ""} Recovery: run "summer login" again and complete "Yes, Sign In" in the browser tab it opens.`
  );
}
