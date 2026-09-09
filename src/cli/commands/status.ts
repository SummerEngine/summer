import { Command } from "commander";
import { getAuthToken, getUserInfo, hasEnvAuthToken } from "../../core/auth.js";
import { resolveGatewayUrl } from "../../core/config.js";
import { getApiToken, getApiPort, checkEngineHealth } from "../../core/engine.js";

export const statusCommand = new Command("status")
  .description("Check Summer Engine status, connection, and auth state")
  .action(async () => {
    await runStatus(console.log);
  });

export async function runStatus(log: (message: string) => void): Promise<void> {
  log("Summer Engine Status\n");

  const authToken = await getAuthToken();
  if (!authToken) {
    log("  Auth: Not logged in");
    log("        Run: npx -y summer-engine@latest login");
    log(`        Or: ${await loginPageHint()}`);
  } else if (hasEnvAuthToken()) {
    // The env credential is what every gateway call uses; a stored identity
    // (if any) is not the one in effect, so it is not printed.
    log("  Auth: SUMMER_TOKEN (env) — logout does not affect it");
  } else {
    log(`  Auth: Logged in${await storedIdentitySuffix()}`);
  }

  const apiToken = await getApiToken();
  const port = await getApiPort();

  if (!apiToken) {
    log("  Engine: Not running (no api-token found)");
    log("\n  To start: summer run");
    return;
  }

  log("  API Token: Found (~/.summer/api-token)");
  log(`  Port: ${port}`);

  const health = await checkEngineHealth(port);
  if (!health) {
    log("  Engine: Not responding (may have closed since last launch)");
    log("\n  To start: summer run");
    return;
  }

  // /api/health carries no project name/path/scene (see EngineHealth in
  // core/engine.ts); summer_get_project_context is the read for those.
  log(`  Engine: Running (v${health.version})`);
}

/** A corrupt user.json must not take `summer status` down with it. */
async function storedIdentitySuffix(): Promise<string> {
  try {
    const userInfo = await getUserInfo();
    return userInfo?.email ? ` as ${userInfo.email}` : "";
  } catch (error) {
    return ` (identity unreadable: ${error instanceof Error ? error.message : String(error)})`;
  }
}

async function loginPageHint(): Promise<string> {
  try {
    return `${await resolveGatewayUrl()}/login`;
  } catch (error) {
    return `(gateway.url is invalid: ${error instanceof Error ? error.message : String(error)})`;
  }
}
