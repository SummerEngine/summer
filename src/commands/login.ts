import { Command } from "commander";
import { randomUUID } from "crypto";
import open from "open";
import { getAuthToken, saveAuthToken, saveCloudToken, saveUserInfo } from "../lib/auth.js";

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
  console.log("Sign in at: " + loginUrl);
  console.log("");

  try {
    await open(loginUrl);
  } catch {
    console.log("Could not open browser. Copy the URL above and open it manually.");
    console.log("");
  }

  console.log("Waiting for authentication...");

  const pollUrl = `${GATEWAY_URL}/api/auth/cli-login?session=${sessionId}`;
  const startTime = Date.now();
  let lastError: string | null = null;

  while (Date.now() - startTime < POLL_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);

    try {
      const res = await fetch(pollUrl, {
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        if (res.status === 503) {
          lastError = "Server not ready (Redis/auth not configured). Try again later.";
        } else if (res.status >= 500) {
          lastError = `Server error (${res.status}). Try again later.`;
        }
        continue;
      }

      const data = (await res.json()) as {
        status: string;
        token?: string;
        cloudToken?: string | null;
        user?: { id: string; email: string; name?: string };
      };

      if (data.status === "pending") continue;

      if (data.status === "complete" && data.token) {
        await saveAuthToken(data.token);
        if (data.cloudToken) {
          await saveCloudToken(data.cloudToken);
        }
        if (data.user) {
          await saveUserInfo(data.user);
        }
        console.log(`\nLogged in as ${data.user?.email || "unknown"}`);
        return;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : "Network error";
    }
  }

  console.error("\nLogin timed out. Please try again.");
  if (lastError) {
    console.error(`Last error: ${lastError}`);
  }
  console.error("\nDid you click \"Yes, Sign In\" in the browser after opening the URL?");
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
