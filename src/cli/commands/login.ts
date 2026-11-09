import { Command } from "commander";
import { randomUUID } from "crypto";
import open from "open";
import { getAuthToken } from "../../core/auth.js";
import { cliSessionLoginUrl, pollCliSession, type CliSessionPollDependencies } from "../../core/cli-session.js";
import { resolveGatewayUrl } from "../../core/config.js";
import { runStoreLogin, storeSignInWorks } from "../../core/oauth.js";

export const loginCommand = new Command("login")
  .description(
    "Sign in to Summer in your browser: your Summer account, then the Summer sign-in (OAuth) the Summer API, store, publishing and Grow tools use, in the same browser"
  )
  .option(
    "--store",
    "Only the Summer sign-in (OAuth): the Summer API (summer api, summer token), uploads with store.upload_file, item sync, the store, publishing, board and Grow tools; plain summer login does it too"
  )
  .option("--no-store", "Only the Summer account sign-in; skip the store sign-in")
  .option("--force", "Force re-authentication even if already logged in")
  .action(async (opts: { store?: boolean; force?: boolean }) => {
    await runLoginCommand(opts);
  });

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
  // Checked with the sign-in server: a stored token for a revoked app is not a sign-in.
  hasStoreSignIn: () => storeSignInWorks(),
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

export interface LoginDependencies extends CliSessionPollDependencies {
  openUrl: (url: string) => Promise<unknown>;
  randomId: () => string;
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

  const loginUrl = cliSessionLoginUrl(gatewayUrl, sessionId);
  deps.log("Sign in at: " + loginUrl);
  deps.log("");

  try {
    await deps.openUrl(loginUrl);
  } catch {
    deps.log("Could not open browser. Copy the URL above and open it manually.");
    deps.log("");
  }

  deps.log("Waiting for authentication...");

  const completed = await pollCliSession(gatewayUrl, sessionId, deps);
  deps.log(`\nLogged in as ${completed.user?.email || "unknown"}`);
}
