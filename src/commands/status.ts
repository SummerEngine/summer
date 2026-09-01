import { Command } from "commander";
import { getAuthToken, getUserInfo } from "../core/auth.js";
import { getApiToken, getApiPort, checkEngineHealth } from "../core/engine.js";
import { getProjectMemorySummary } from "../project-memory/project-memory.js";
import { formatStatusMemoryLine } from "./memory.js";

export const statusCommand = new Command("status")
  .description("Check Summer Engine status, connection, and auth state")
  .action(async () => {
    console.log("Summer Engine Status\n");

    const authToken = await getAuthToken();
    const userInfo = await getUserInfo();
    if (authToken) {
      console.log(`  Auth: Logged in${userInfo ? ` as ${userInfo.email}` : ""}`);
    } else {
      console.log("  Auth: Not logged in");
      console.log("        Run: npx summer-engine login");
      console.log("        Or: https://www.summerengine.com/login");
    }

    const apiToken = await getApiToken();
    const port = await getApiPort();

    if (!apiToken) {
      console.log("  Engine: Not running (no api-token found)");
      console.log("\n  To start: summer run");
      return;
    }

    console.log(`  API Token: Found (~/.summer/api-token)`);
    console.log(`  Port: ${port}`);

    const health = await checkEngineHealth(port);
    if (!health) {
      console.log("  Engine: Not responding (may have closed since last launch)");
      console.log("\n  To start: summer run");
      return;
    }

    console.log(`  Engine: Running (v${health.version})`);
    if (health.project_name) {
      console.log(`  Project: ${health.project_name}`);
    }
    if (health.project_path) {
      console.log(`  Path: ${health.project_path}`);
      console.log(`  ${formatStatusMemoryLine(getProjectMemorySummary(health.project_path))}`);
    }
    if (health.scene) {
      console.log(`  Scene: ${health.scene}`);
    }
  });
