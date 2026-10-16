import { Command } from "commander";
import { randomUUID } from "crypto";
import open from "open";
import {
  getAuthToken,
  getUserInfo,
  saveLoginSession,
  type LoginSession,
} from "../../core/auth.js";
import { summerRequestHeaders } from "../../core/agent-host.js";
import { resolveGatewayUrl } from "../../core/config.js";
import { readStoredOAuthToken, runStoreLogin } from "../../core/oauth.js";
import { readStoreJson, removeStoreFile, writeStoreJson } from "../../core/store.js";

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
    "Only the store sign-in (summer_publish_build, the store, publishing, board and Grow tools); plain summer login does it too"
  )
  .option("--no-store", "Only the Summer account sign-in; skip the store sign-in")
  .option("--force", "Force re-authentication even if already logged in")
  .option(
    "--non-interactive",
    "Print the sign-in link as JSON ({browser_url, verification_code, next_step}) and exit; the default when stdin is not a terminal (agents)"
  )
  .option("--complete", "Finish a non-interactive sign-in: wait for the browser, then connect the store. Prints JSON")
  .option("--timeout <seconds>", "How long --complete waits for the browser", "600")
  .action(async (opts: LoginCliOptions) => {
    if (opts.complete || opts.nonInteractive || !process.stdin.isTTY) {
      const outcome = await runAgentLogin(opts);
      process.stdout.write(`${JSON.stringify(outcome.result, null, 2)}\n`);
      process.exitCode = outcome.exitCode;
      return;
    }
    await runLoginCommand(opts);
  });

interface LoginCliOptions {
  store?: boolean;
  force?: boolean;
  nonInteractive?: boolean;
  complete?: boolean;
  timeout?: string;
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
      "Signed-in MCP sessions report each tool call to Summer (tool name, success, duration, agent app name); SUMMER_NO_TELEMETRY=1 turns that off."
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

export interface RunLoginOptions {
  /** Poll this session (from a non-interactive "summer login") instead of starting one. */
  sessionId?: string;
  /** false: do not open the browser (the person already has the link). */
  openBrowser?: boolean;
  timeoutMs?: number;
}

export function loginUrlFor(gatewayUrl: string, sessionId: string): string {
  return `${gatewayUrl}/login?cli_session=${encodeURIComponent(sessionId)}`;
}

export async function runLogin(
  overrides: Partial<LoginDependencies> = {},
  options: RunLoginOptions = {}
): Promise<void> {
  const deps = { ...defaultDependencies, ...overrides };
  const gatewayUrl = await resolveGatewayUrl();
  const sessionId = options.sessionId ?? deps.randomId();
  const timeoutMs = options.timeoutMs ?? POLL_TIMEOUT_MS;

  const loginUrl = loginUrlFor(gatewayUrl, sessionId);
  deps.log("Sign in at: " + loginUrl);
  deps.log("");

  if (options.openBrowser !== false) {
    try {
      await deps.openUrl(loginUrl);
    } catch {
      deps.log("Could not open browser. Copy the URL above and open it manually.");
      deps.log("");
    }
  }

  deps.log("Waiting for authentication...");

  const pollUrl = `${gatewayUrl}/api/auth/cli-login?session=${encodeURIComponent(sessionId)}`;
  const startTime = deps.now();
  let lastHeartbeat = startTime;
  let lastError: string | null = null;

  while (deps.now() - startTime < timeoutMs) {
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
    `Login timed out after ${Math.round(timeoutMs / 60000)} minutes.${lastError ? ` Last error: ${lastError}` : ""} Recovery: run "summer login" again and complete "Yes, Sign In" in the browser tab it opens.`
  );
}

// ---------------------------------------------------------------- agents

/**
 * Sign-in for agents and scripts (no terminal on stdin), in two commands:
 *
 *   summer login             prints {status: "pending", browser_url,
 *                            verification_code, next_step} and exits 0; the
 *                            agent shows browser_url to the person
 *   summer login --complete  waits until the person signs in, then connects
 *                            the store (one Allow click in the same browser)
 *                            and prints {status: "signed_in"}
 *
 * The pending session id is kept in ~/.summer/pending-login.json. The gateway
 * keeps a completed sign-in under that id until it is picked up, so the
 * person may finish before --complete runs. Messages go to stderr; stdout
 * holds one JSON object.
 */

export const PENDING_LOGIN_FILE = "pending-login.json";

export interface PendingLogin {
  schemaVersion: 1;
  sessionId: string;
  gateway: string;
  browserUrl: string;
  createdAt: string;
}

/** A short code derived from the session id ("1A2B-3C4D"), for the person to compare with the sign-in page. */
export function verificationCode(sessionId: string): string {
  const chars = sessionId.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}

export interface AgentLoginDependencies {
  hasAuthToken: () => Promise<boolean>;
  hasStoreSignIn: () => Promise<boolean>;
  gateway: () => Promise<string>;
  randomId: () => string;
  openUrl: (url: string) => Promise<unknown>;
  readPending: () => Promise<PendingLogin | null>;
  writePending: (pending: PendingLogin) => Promise<void>;
  clearPending: () => Promise<void>;
  /** Poll the account sign-in for this session until it completes. */
  waitForSession: (sessionId: string, timeoutMs: number) => Promise<void>;
  storeLogin: (options: { newClient: boolean; timeoutMs?: number }) => Promise<unknown>;
  email: () => Promise<string | null>;
  now: () => number;
  log: (message: string) => void;
}

const stderr = (message: string) => process.stderr.write(`${message}\n`);

const defaultAgentDependencies: AgentLoginDependencies = {
  hasAuthToken: async () => Boolean(await getAuthToken()),
  hasStoreSignIn: async () => Boolean(await readStoredOAuthToken()),
  gateway: () => resolveGatewayUrl(),
  randomId: randomUUID,
  openUrl: open,
  readPending: async () => {
    const pending = await readStoreJson<PendingLogin>(PENDING_LOGIN_FILE).catch(() => null);
    return pending?.schemaVersion === 1 && typeof pending.sessionId === "string" ? pending : null;
  },
  writePending: (pending) => writeStoreJson(PENDING_LOGIN_FILE, pending),
  clearPending: async () => {
    await removeStoreFile(PENDING_LOGIN_FILE).catch(() => false);
  },
  waitForSession: (sessionId, timeoutMs) => runLogin({ log: stderr }, { sessionId, openBrowser: false, timeoutMs }),
  storeLogin: ({ newClient, timeoutMs }) =>
    runStoreLogin({ fetch, now: Date.now, openUrl: open, log: stderr, newClient, ...(timeoutMs ? { timeoutMs } : {}) }),
  email: async () => (await getUserInfo())?.email ?? null,
  now: Date.now,
  log: stderr,
};

export interface AgentLoginOutcome {
  exitCode: 0 | 1 | 2;
  result: Record<string, unknown>;
}

export async function runAgentLogin(
  opts: { store?: boolean; force?: boolean; complete?: boolean; timeout?: string },
  overrides: Partial<AgentLoginDependencies> = {}
): Promise<AgentLoginOutcome> {
  const deps = { ...defaultAgentDependencies, ...overrides };
  const timeoutSeconds = Number(opts.timeout ?? "600");
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
    return {
      exitCode: 2,
      result: { status: "error", error: { code: "invalid_input", message: `--timeout must be 1-3600 seconds, got "${opts.timeout}".`, fix: "Pass --timeout 600." } },
    };
  }
  const timeoutMs = timeoutSeconds * 1000;
  const wantStore = opts.store !== false;
  const signedIn = async () => ({
    status: "signed_in",
    email: await deps.email(),
    store: await deps.hasStoreSignIn(),
  });
  const failed = (code: string, error: unknown, fix: string): AgentLoginOutcome => ({
    exitCode: 1,
    result: { status: "error", error: { code, message: error instanceof Error ? error.message : String(error), fix } },
  });

  const storeStep = async (): Promise<AgentLoginOutcome | null> => {
    if (!wantStore || ((await deps.hasStoreSignIn()) && !(opts.store === true && opts.force))) return null;
    deps.log("Connecting the Summer store, publishing and Grow tools: approve Summer CLI in the browser.");
    try {
      await deps.storeLogin({ newClient: Boolean(opts.store === true && opts.force), timeoutMs: Math.min(timeoutMs, STORE_STEP_TIMEOUT_MS) });
    } catch (error) {
      return failed("store_sign_in_failed", error, 'The account sign-in is saved. Run "summer login --store" to connect the store.');
    }
    return null;
  };

  if (opts.complete) {
    const pending = await deps.readPending();
    if (pending) {
      try {
        await deps.waitForSession(pending.sessionId, timeoutMs);
      } catch (error) {
        return failed("sign_in_not_finished", error, `Ask the person to open ${pending.browserUrl} and click "Yes, Sign In", then run "summer login --complete" again.`);
      }
      await deps.clearPending();
    } else if (!(await deps.hasAuthToken())) {
      return {
        exitCode: 1,
        result: { status: "error", error: { code: "no_pending_login", message: "There is no sign-in to complete.", fix: 'Run "summer login" first.' }, next_step: "summer login" },
      };
    }
    const store = await storeStep();
    return store ?? { exitCode: 0, result: await signedIn() };
  }

  // --store alone: the store step, which waits for one Allow click in the browser.
  if (opts.store === true) {
    const store = await storeStep();
    return store ?? { exitCode: 0, result: await signedIn() };
  }

  if ((await deps.hasAuthToken()) && !opts.force) {
    const store = await storeStep();
    return store ?? { exitCode: 0, result: await signedIn() };
  }

  const gateway = await deps.gateway();
  const sessionId = deps.randomId();
  const browserUrl = loginUrlFor(gateway, sessionId);
  await deps.writePending({ schemaVersion: 1, sessionId, gateway, browserUrl, createdAt: new Date(deps.now()).toISOString() });
  try {
    await deps.openUrl(browserUrl);
  } catch {
    // the agent shows browser_url to the person
  }
  return {
    exitCode: 0,
    result: {
      status: "pending",
      browser_url: browserUrl,
      verification_code: verificationCode(sessionId),
      next_step: "summer login --complete",
      message: 'Show browser_url to the person. After they sign in and click "Yes, Sign In", run next_step; it waits for them.',
    },
  };
}
