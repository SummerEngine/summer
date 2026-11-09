import { Command } from "commander";
import { getAuthToken, getUserInfo, hasEnvAuthToken } from "../../core/auth.js";
import { resolveGatewayUrl } from "../../core/config.js";
import { getApiToken, getApiPort, checkEngineHealth } from "../../core/engine.js";

export const statusCommand = new Command("status")
  .description("Check Summer Engine status, connection, and auth state")
  .option("--json", "Print the status as JSON")
  .action(async (opts: { json?: boolean }) => {
    if (opts.json) console.log(JSON.stringify(await readStatus()));
    else await runStatus(console.log);
  });

/** What `summer status` reports; `--json` prints exactly this. */
export interface StatusReport {
  auth:
    | { signedIn: false; loginUrl: string }
    | { signedIn: true; source: "env" }
    | { signedIn: true; source: "stored"; email?: string; identityError?: string };
  engine:
    | { state: "not_running" }
    | { state: "not_responding"; port: number }
    | { state: "running"; port: number; version: string };
}

export async function readStatus(): Promise<StatusReport> {
  const authToken = await getAuthToken();
  // The env credential is what every gateway call uses; a stored identity
  // (if any) is not the one in effect, so it is not reported.
  const auth: StatusReport["auth"] = !authToken
    ? { signedIn: false, loginUrl: await loginPageHint() }
    : hasEnvAuthToken()
      ? { signedIn: true, source: "env" }
      : { signedIn: true, source: "stored", ...(await storedIdentity()) };

  if (!(await getApiToken())) return { auth, engine: { state: "not_running" } };
  const port = await getApiPort();
  const health = await checkEngineHealth(port);
  // /api/health carries no project name/path/scene (see EngineHealth in
  // core/engine.ts); summer_get_project_context is the read for those.
  return { auth, engine: health ? { state: "running", port, version: health.version } : { state: "not_responding", port } };
}

export async function runStatus(log: (message: string) => void): Promise<void> {
  const { auth, engine } = await readStatus();
  log("Summer Engine Status\n");

  if (!auth.signedIn) {
    log("  Auth: Not logged in");
    log("        Run: npx -y summer-engine@latest login");
    log(`        Or: ${auth.loginUrl}`);
  } else if (auth.source === "env") {
    log("  Auth: SUMMER_TOKEN (env) — logout does not affect it");
  } else {
    const identity = auth.identityError ? ` (identity unreadable: ${auth.identityError})` : auth.email ? ` as ${auth.email}` : "";
    log(`  Auth: Logged in${identity}`);
  }

  if (engine.state === "not_running") {
    log("  Engine: Not running (no api-token found)");
    log("\n  To start: summer run");
    return;
  }

  log("  API Token: Found (~/.summer/api-token)");
  log(`  Port: ${engine.port}`);

  if (engine.state === "not_responding") {
    log("  Engine: Not responding (may have closed since last launch)");
    log("\n  To start: summer run");
    return;
  }

  log(`  Engine: Running (v${engine.version})`);
}

/** A corrupt user.json must not take `summer status` down with it. */
async function storedIdentity(): Promise<{ email?: string; identityError?: string }> {
  try {
    const userInfo = await getUserInfo();
    return userInfo?.email ? { email: userInfo.email } : {};
  } catch (error) {
    return { identityError: error instanceof Error ? error.message : String(error) };
  }
}

async function loginPageHint(): Promise<string> {
  try {
    return `${await resolveGatewayUrl()}/login`;
  } catch (error) {
    return `(gateway.url is invalid: ${error instanceof Error ? error.message : String(error)})`;
  }
}
