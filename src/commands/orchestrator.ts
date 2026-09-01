/**
 * CLI command: summer agent
 * Launches the web app locally with direct engine execution enabled.
 * The web app handles all AI logic (prompts, tools, RAG, billing).
 * This command just starts it with LOCAL_ENGINE_PORT set.
 */
import { Command } from "commander";
import { spawn } from "node:child_process";
import { readFile, access, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { getApiToken, getApiPort, checkEngineHealth } from "../core/engine.js";
import { getSummerDir } from "../core/auth.js";

async function findWebAppPath(): Promise<string | null> {
  // 1. Check env var
  if (process.env.SUMMER_WEB_APP_PATH) {
    return process.env.SUMMER_WEB_APP_PATH;
  }

  // 2. Check ~/.summer/web-app-path
  try {
    const stored = (
      await readFile(join(getSummerDir(), "web-app-path"), "utf-8")
    ).trim();
    if (stored) {
      await access(join(stored, "package.json"));
      return stored;
    }
  } catch {
    // Not stored yet
  }

  // 3. Search common sibling locations
  const cliDir = dirname(dirname(dirname(new URL(import.meta.url).pathname)));
  const searchPaths = [
    resolve(cliDir, "../../publicsummerengine"), // sibling in development/
    resolve(cliDir, "../../../publicsummerengine"), // one level up
    resolve(homedir(), "development/publicsummerengine"),
  ];

  for (const candidate of searchPaths) {
    try {
      await access(join(candidate, "package.json"));
      const pkg = JSON.parse(
        await readFile(join(candidate, "package.json"), "utf-8")
      );
      if (pkg.name && pkg.name.includes("summer")) {
        // Store for future use
        try {
          await writeFile(
            join(getSummerDir(), "web-app-path"),
            candidate,
            "utf-8"
          );
        } catch {
          // Non-critical
        }
        return candidate;
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function loadEnvFile(): Promise<Record<string, string>> {
  const envVars: Record<string, string> = {};
  try {
    const envPath = join(getSummerDir(), "env");
    const content = await readFile(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        envVars[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
      }
    }
  } catch {
    // No env file — user will need to have env vars set
  }
  return envVars;
}

export const orchestratorCommand = new Command("agent")
  .description(
    "Start the web app locally with direct engine execution. " +
      "Tools call localhost:6550 instead of the Redis bridge."
  )
  .option("-p, --port <number>", "Web app port", "3000")
  .option(
    "--web-path <path>",
    "Path to publicsummerengine (auto-detected if not set)"
  )
  .option("--dev", "Run in dev mode (pnpm dev) instead of production")
  .action(
    async (opts: { port: string; webPath?: string; dev?: boolean }) => {
      const port = parseInt(opts.port, 10);

      // 1. Verify engine is running
      const enginePort = await getApiPort();
      const engineToken = await getApiToken();
      const health = await checkEngineHealth(enginePort);

      if (!health) {
        console.error(
          "Summer Engine is not running. Open Summer Engine first."
        );
        process.exit(1);
      }

      console.log(
        `Engine running on port ${enginePort} | project: ${health.project_name ?? "unknown"}`
      );

      // 2. Find web app
      const webAppPath = opts.webPath ?? (await findWebAppPath());
      if (!webAppPath) {
        console.error(
          "Could not find publicsummerengine. Set --web-path or SUMMER_WEB_APP_PATH."
        );
        process.exit(1);
      }

      console.log(`Web app: ${webAppPath}`);

      // 3. Load env vars from ~/.summer/env
      const storedEnv = await loadEnvFile();

      // 4. Build env for the web app
      const childEnv: Record<string, string> = {
        ...process.env as Record<string, string>,
        ...storedEnv,
        LOCAL_ENGINE_PORT: String(enginePort),
        LOCAL_ENGINE_TOKEN: engineToken ?? "",
        PORT: String(port),
      };

      // 5. Start the web app
      const cmd = opts.dev ? "pnpm" : "pnpm";
      const args = opts.dev ? ["dev", "--port", String(port)] : ["start", "--port", String(port)];

      console.log(
        `\nStarting web app (${opts.dev ? "dev" : "production"} mode) on port ${port}...`
      );
      console.log(`  LOCAL_ENGINE_PORT=${enginePort}`);
      console.log(`  Tools will execute via localhost:${enginePort} (direct, no bridge)\n`);

      const child = spawn(cmd, args, {
        cwd: webAppPath,
        env: childEnv,
        stdio: "inherit",
      });

      // Write agent port for engine to discover
      try {
        await writeFile(
          join(getSummerDir(), "agent-port"),
          String(port),
          "utf-8"
        );
      } catch {
        // Non-critical
      }

      child.on("error", (err) => {
        console.error("Failed to start web app:", err.message);
        process.exit(1);
      });

      child.on("exit", (code) => {
        process.exit(code ?? 0);
      });

      // Graceful shutdown
      const shutdown = () => {
        child.kill("SIGTERM");
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    }
  );
