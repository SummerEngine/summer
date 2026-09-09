import { Command } from "commander";
import { randomUUID } from "crypto";
import open from "open";
import {
  getAuthToken,
  getCreatorToken,
  saveCreatorToken,
  saveLoginSession,
  type LoginSession,
} from "../../core/auth.js";
import { getCreatorApiUrl, resolveGatewayUrl } from "../../core/config.js";

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
    "--creator",
    "Connect a separately scoped Summercraft creator token for publishing"
  )
  .option("--force", "Force re-authentication even if already logged in")
  .action(async (opts: { creator?: boolean; force?: boolean }) => {
    if (opts.creator) {
      const existingCreator = await getCreatorToken();
      if (existingCreator && !opts.force) {
        console.log(
          "A creator token is already connected. Use --creator --force to replace it."
        );
        return;
      }
      await runCreatorLogin();
      return;
    }

    const existing = await getAuthToken();
    if (existing && !opts.force) {
      console.log("Already logged in. Use --force to re-authenticate.");
      return;
    }

    await runLogin();
  });

export interface CreatorLoginDependencies {
  openUrl: (url: string) => Promise<unknown>;
  readSecret: (prompt: string) => Promise<string>;
  log: (message: string) => void;
}

async function readHiddenLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(prompt);
    let value = "";
    for await (const chunk of process.stdin) value += String(chunk);
    return value.trim();
  }

  process.stdout.write(prompt);
  const input = process.stdin;
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      input.off("data", onData);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value.trim());
    };
    const onData = (chunk: Buffer | string) => {
      for (const char of String(chunk)) {
        if (char === "\u0003") {
          finish(new Error("Creator token entry cancelled."));
          return;
        }
        if (char === "\r" || char === "\n" || char === "\u0004") {
          finish();
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
        } else if (char >= " ") {
          value += char;
        }
      }
    };
    input.on("data", onData);
  });
}

const defaultCreatorLoginDependencies: CreatorLoginDependencies = {
  openUrl: open,
  readSecret: readHiddenLine,
  log: console.log,
};

/**
 * The browser session mints the token; the token is pasted once into a hidden
 * prompt. This deliberately does not replace the core Summer login JWT.
 */
export async function runCreatorLogin(
  overrides: Partial<CreatorLoginDependencies> = {}
): Promise<void> {
  const deps = { ...defaultCreatorLoginDependencies, ...overrides };
  const settingsUrl = `${await getCreatorApiUrl()}/creator/settings/tokens`;
  deps.log(`Opening creator token settings: ${settingsUrl}`);
  deps.log(
    'Mint a token with the exact "publish" scope, copy its one-time sc_ value, then return here.'
  );
  try {
    await deps.openUrl(settingsUrl);
  } catch {
    deps.log("Could not open the browser. Copy the URL above and open it manually.");
  }
  const token = await deps.readSecret("Creator token (input hidden): ");
  await saveCreatorToken(token);
  deps.log(
    "Creator publishing connected. Your core Summer login token was not changed."
  );
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
