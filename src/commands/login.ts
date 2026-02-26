import { Command } from "commander";
import { randomUUID } from "crypto";
import open from "open";
import { getAuthToken, saveAuthToken, saveUserInfo } from "../lib/auth.js";

const GATEWAY_URL =
  process.env.SUMMER_GATEWAY_URL || "https://www.summerengine.com";

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 120000;

export const loginCommand = new Command("login")
  .description("Sign in to Summer Engine via your browser")
  .option("--force", "Force re-authentication even if already logged in")
  .action(async (opts: { force?: boolean }) => {
    const existing = await getAuthToken();
    if (existing && !opts.force) {
      console.log("Already logged in. Use --force to re-authenticate.");
      return;
    }

    await doLogin();
  });

async function doLogin(): Promise<void> {
  const sessionId = randomUUID();

  const loginUrl = `${GATEWAY_URL}/login?cli_session=${sessionId}`;
  console.log(`Opening browser to sign in...\n  ${loginUrl}\n`);

  try {
    await open(loginUrl);
  } catch {
    console.log(
      "Could not open browser automatically. Please open the URL above manually."
    );
  }

  console.log("Waiting for authentication...");

  const pollUrl = `${GATEWAY_URL}/api/auth/cli-login?session=${sessionId}`;
  const startTime = Date.now();

  while (Date.now() - startTime < POLL_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);

    try {
      const res = await fetch(pollUrl, {
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) continue;

      const data = (await res.json()) as {
        status: string;
        token?: string;
        user?: { id: string; email: string; name?: string };
      };

      if (data.status === "pending") continue;

      if (data.status === "complete" && data.token) {
        await saveAuthToken(data.token);
        if (data.user) {
          await saveUserInfo(data.user);
        }
        console.log(`\nLogged in as ${data.user?.email || "unknown"}`);
        return;
      }
    } catch {
      // Network error, retry
    }
  }

  console.error("\nLogin timed out. Please try again.");
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
