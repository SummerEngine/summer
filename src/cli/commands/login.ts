import { Command } from "commander";
import { randomUUID } from "crypto";
import open from "open";
import {
  getAuthToken,
  saveLoginSession,
  type LoginSession,
} from "../../core/auth.js";
import { resolveAgentHost, summerRequestHeaders } from "../../core/agent-host.js";
import {
  KeyRequestError,
  apiKeyPath,
  getApiKey,
  keyClientName,
  startApiKeyRequest,
  waitForApiKey,
  type ApiKeyPoll,
  type ApiKeyRequest,
} from "../../core/api-key.js";
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
  .description(
    "Sign in to Summer in your browser: your Summer account, then the store, publishing and Grow tools in the same browser"
  )
  .option(
    "--store",
    "Only the store sign-in (uploads with store.upload_file, item sync with economy.sync_items, the store, publishing, board and Grow tools); plain summer login does it too"
  )
  .option("--no-store", "Only the Summer account sign-in; skip the store sign-in")
  .option("--force", "Force re-authentication even if already logged in")
  .option(
    "--api-key",
    "Only a Summer API key for this agent: the person presses Allow on a Summer page, the key is saved to ~/.summer/api-key (SUMMER_API_KEY wins over it)"
  )
  .option("--limit <usd>", "With --api-key: the spend limit to suggest on the Allow page (the person can change it)", Number)
  .option("--json", "With --api-key: JSON lines (the default when stdout is not a terminal)")
  .action(async (opts: { store?: boolean; force?: boolean; apiKey?: boolean; limit?: number; json?: boolean }) => {
    if (opts.apiKey) {
      process.exitCode = await runApiKeyLogin(opts);
      return;
    }
    await runLoginCommand(opts);
  });

/** How long `summer login --api-key` waits for the Allow click (the request itself lives 10 minutes). */
export const API_KEY_WAIT_MS = 10 * 60_000;

export interface ApiKeyLoginDependencies {
  hasApiKey: () => Promise<boolean>;
  start: (options: { client: string; limitUsd?: number; fresh?: boolean }) => Promise<ApiKeyRequest>;
  wait: (request: ApiKeyRequest) => Promise<ApiKeyPoll>;
  openUrl: (url: string) => Promise<unknown>;
  client: () => string;
  isTTY: boolean;
  print: (line: string) => void;
}

const defaultApiKeyDependencies = (): ApiKeyLoginDependencies => ({
  hasApiKey: async () => Boolean(await getApiKey()),
  start: (options) => startApiKeyRequest(options),
  wait: (request) => waitForApiKey(request, { timeoutMs: API_KEY_WAIT_MS }),
  openUrl: open,
  client: () => keyClientName(resolveAgentHost().id),
  isTTY: process.stdout.isTTY === true,
  print: (line) => console.log(line),
});

/**
 * `summer login --api-key`: a Summer API key with one Allow click and no
 * copy-paste (core/api-key.ts). An agent with no terminal gets JSON lines:
 * {"status":"needs_approval","approve_url","user_code"} to show the person,
 * then {"status":"approved","key_file","env"} (the key itself is never
 * printed), or denied / expired / failed. Exit code 0 only when approved.
 */
export async function runApiKeyLogin(
  opts: { force?: boolean; limit?: number; json?: boolean },
  overrides: Partial<ApiKeyLoginDependencies> = {}
): Promise<number> {
  const deps = { ...defaultApiKeyDependencies(), ...overrides };
  const json = opts.json === true || !deps.isTTY;
  const say = (text: string, data: Record<string, unknown>) => deps.print(json ? JSON.stringify(data) : text);

  if (!opts.force && (await deps.hasApiKey())) {
    say(`A Summer API key is already saved (${apiKeyPath()}). Use --api-key --force for a new one.`, { status: "ready", key_file: apiKeyPath(), env: "SUMMER_API_KEY" });
    return 0;
  }
  const limitUsd = typeof opts.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : undefined;
  let request: ApiKeyRequest;
  try {
    request = await deps.start({ client: deps.client(), ...(limitUsd ? { limitUsd } : {}), fresh: opts.force === true });
  } catch (error) {
    const code = error instanceof KeyRequestError ? error.code : "request_failed";
    const message = error instanceof Error ? error.message : String(error);
    say(message, { status: "failed", error: code, message });
    return 1;
  }
  say(
    `Allow this agent on Summer: ${request.approveUrl}\nCheck that the page shows ${request.userCode}. Waiting for Allow...`,
    { status: "needs_approval", approve_url: request.approveUrl, user_code: request.userCode, expires_at: request.expiresAt, message: `Ask the person to open approve_url, check that it shows ${request.userCode}, and press Allow.` }
  );
  await deps.openUrl(request.approveUrl).catch(() => undefined);

  const answer = await deps.wait(request);
  if (answer.status === "approved") {
    say(
      `Saved the Summer API key to ${apiKeyPath()}${answer.limitUsd !== null ? ` (spend limit $${answer.limitUsd})` : ""}.`,
      { status: "approved", key_id: answer.keyId, key_file: apiKeyPath(), env: "SUMMER_API_KEY", limit_usd: answer.limitUsd, expires_at: answer.expiresAt }
    );
    return 0;
  }
  if (answer.status === "pending") {
    say("Still waiting for Allow. Run \"summer login --api-key\" again to keep waiting.", { status: "pending", approve_url: request.approveUrl, user_code: request.userCode });
    return 1;
  }
  say(answer.message, { status: answer.status, message: answer.message });
  return 1;
}

/** How long `summer login` waits for the store's Allow click after the account sign-in. */
export const STORE_STEP_TIMEOUT_MS = 3 * 60_000;

export interface LoginCommandDependencies {
  hasAuthToken: () => Promise<boolean>;
  hasStoreSignIn: () => Promise<boolean>;
  login: () => Promise<void>;
  storeLogin: (options: { newClient: boolean; timeoutMs?: number }) => Promise<unknown>;
  log: (message: string) => void;
}

const defaultCommandDependencies: LoginCommandDependencies = {
  hasAuthToken: async () => Boolean(await getAuthToken()),
  hasStoreSignIn: async () => Boolean(await readStoredOAuthToken()),
  login: () => runLogin(),
  storeLogin: ({ newClient, timeoutMs }) =>
    runStoreLogin({ fetch, now: Date.now, openUrl: open, log: console.log, newClient, ...(timeoutMs ? { timeoutMs } : {}) }),
  log: console.log,
};

/**
 * One `summer login`, one browser: the Summer account sign-in (the CLI token
 * for the engine, generation and asset tools), then right away the store
 * sign-in (an OAuth grant for the hosted Summer Engine MCP: store,
 * publishing, board, Grow). The browser is signed in by then, so the second
 * step is one Allow click, or none when this machine was approved before.
 * The two are separate credentials on the server, so a failed store step
 * keeps the account sign-in and says how to finish later.
 *
 * --store: only the store step (as before). --no-store: only the account.
 */
export async function runLoginCommand(
  opts: { store?: boolean; force?: boolean },
  overrides: Partial<LoginCommandDependencies> = {}
): Promise<void> {
  const deps = { ...defaultCommandDependencies, ...overrides };
  const force = Boolean(opts.force);

  if (opts.store === true) {
    if ((await deps.hasStoreSignIn()) && !force) {
      deps.log("Already signed in to the Summer store. Use --store --force to sign in again.");
      return;
    }
    // --force also registers a new client, the way back if this machine's was removed.
    await deps.storeLogin({ newClient: force });
    deps.log("Signed in to the Summer store. Your core Summer login was not changed.");
    return;
  }

  const signedIn = (await deps.hasAuthToken()) && !force;
  const storeNeeded = opts.store !== false && (force || !(await deps.hasStoreSignIn()));
  if (signedIn) {
    deps.log(
      storeNeeded
        ? "Already logged in to Summer. Connecting the store, publishing and Grow tools next."
        : "Already logged in. Use --force to re-authenticate."
    );
  } else {
    await deps.login();
    deps.log(
      "Signed in, Summer gets one usage line per MCP tool call and per `summer` command (name, success or error code, duration, agent app; never arguments or paths). SUMMER_NO_TELEMETRY=1 turns it off."
    );
  }
  if (!storeNeeded) return;

  deps.log("");
  deps.log("Next, the store, publishing and Grow tools: approve Summer CLI in the same browser.");
  try {
    await deps.storeLogin({ newClient: false, timeoutMs: STORE_STEP_TIMEOUT_MS });
    deps.log("Signed in to the Summer store too. One sign-in covers every Summer tool on this machine.");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    deps.log(`The store sign-in did not finish: ${reason}`);
    deps.log('Your Summer login is saved. To add the store, publishing and Grow tools later, run "summer login --store".');
  }
}

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
      deps.log(`\nLogged in as ${completed.user?.email || "unknown"}`);
      return;
    }
  }

  throw new Error(
    `Login timed out after ${Math.round(POLL_TIMEOUT_MS / 60000)} minutes.${lastError ? ` Last error: ${lastError}` : ""} Recovery: run "summer login" again and complete "Yes, Sign In" in the browser tab it opens.`
  );
}
