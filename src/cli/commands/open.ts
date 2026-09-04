import { Command } from "commander";
import { existsSync, statSync } from "fs";
import { resolve } from "path";
import open from "open";
import { getApiPort, checkEngineHealth } from "../../core/engine.js";
import { getAuthToken } from "../../core/auth.js";
import { resolveGatewayUrl } from "../../core/config.js";
import { EngineApiClient } from "../../core/api-client.js";
import {
  runOpen,
  type OpenDeps,
  type OpenResult,
  type OpenSurface,
} from "../../core/capabilities/navigation/open.js";
import { c, sym } from "../../core/format.js";

/**
 * `summer open` has two jobs that share one verb:
 *
 * 1. `summer open <project-dir>` — the original command: open a project in
 *    Summer Engine (launching it when it is not running). Any argument that is
 *    an existing directory or looks like a filesystem path takes this branch,
 *    so nothing that worked before changes.
 * 2. `summer open <target>` — navigation (docs/design/NAVIGATION-DESIGN.md):
 *    a product-map id ("billing"), an intent phrase ("change my plan"), a
 *    res:// path, or a summerengine.com path. Same behavior as the
 *    summer_open MCP tool and `summer tool open` (core/capabilities/navigation).
 */

export interface OpenNavigationOptions {
  print?: boolean;
  list?: boolean;
  web?: boolean;
  editor?: boolean;
  json?: boolean;
  path?: string;
  node?: string;
  scene?: string;
  param?: string[];
}

/** Path-shaped (absolute, relative, home, Windows drive) or an existing directory. */
export function looksLikeProjectPath(arg: string): boolean {
  if (/^(\/|\.\/|\.\.\/|~)/.test(arg) || /^[A-Za-z]:[\\/]/.test(arg) || arg === "." || arg === "..") return true;
  try {
    return statSync(resolve(arg)).isDirectory();
  } catch {
    return false;
  }
}

export function parseParamOptions(options: OpenNavigationOptions): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of options.param ?? []) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`--param expects key=value, got "${pair}"`);
    params[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  if (options.path) params.path = options.path;
  if (options.node) params.node = options.node;
  if (options.scene) params.scene = options.scene;
  return params;
}

export function surfaceFromOptions(options: OpenNavigationOptions): OpenSurface {
  if (options.web && options.editor) throw new Error("--web and --editor are mutually exclusive");
  return options.web ? "web" : options.editor ? "editor" : "auto";
}

export function formatOpenResult(result: OpenResult): string {
  const lines: string[] = [];
  switch (result.action) {
    case "listed": {
      const targets = result.targets ?? [];
      const width = Math.max(...targets.map((t) => t.id.length), 2);
      lines.push(c.bold(`Summer destinations (${targets.length})`));
      for (const t of targets) {
        const req = t.requires.login ? c.dim(" [login]") : "";
        const avail =
          t.availability === "available"
            ? c.green("available  ")
            : t.availability === "legacy"
              ? c.dim("legacy op  ")
              : t.availability === "unavailable"
                ? c.yellow("unavailable")
                : t.availability === "unknown"
                  ? c.dim("unknown    ")
                  : c.dim("web        ");
        lines.push(`  ${t.id.padEnd(width)}  ${avail} ${t.title}${req}`);
      }
      lines.push("");
      lines.push(c.dim("Editor availability comes from the connected engine (unknown = engine not running; unavailable = update Summer Engine)."));
      lines.push(c.dim("Open one: summer open <id>   Print instead: summer open <id> --print   Phrases work too: summer open \"change my plan\""));
      break;
    }
    case "opened":
      lines.push(`${sym.ok()} Opened ${result.target?.title ?? result.url ?? "destination"}`);
      if (result.opened_url) lines.push(`  ${result.opened_url}`);
      if (result.op) lines.push(`  ${c.dim(JSON.stringify(result.op))}`);
      if (result.hint) lines.push(`  ${c.dim(result.hint)}`);
      break;
    case "printed":
      if (result.url) lines.push(result.url);
      if (result.login_url && result.logged_in === false) lines.push(c.dim(`not logged in here — through login: ${result.login_url}`));
      if (result.op) lines.push(JSON.stringify(result.op));
      if (result.target) lines.push(c.dim(`${result.target.title} — ${result.target.description}`));
      if (result.engine && !result.engine.running) lines.push(c.dim("(engine not running; nothing was sent)"));
      break;
    case "ambiguous":
      lines.push(`${sym.warn()} ${result.hint ?? "Several destinations match."}`);
      for (const m of result.matches ?? []) lines.push(`  ${m.id.padEnd(18)} ${m.surface.padEnd(6)} ${m.title}`);
      break;
    case "unsupported":
      lines.push(`${sym.warn()} ${result.target?.title ?? result.target?.id} is not available on this Summer Engine build.`);
      if (result.hint) lines.push(`  ${result.hint}`);
      if (result.op) lines.push(`  would send: ${JSON.stringify(result.op)}`);
      break;
    case "engine_not_running":
      lines.push(c.red("Summer Engine is not running (or no project is open) — nothing was opened."));
      if (result.op) lines.push(`  would send: ${JSON.stringify(result.op)}`);
      lines.push("  Start it with 'summer run <project>' or open the project in the Summer desktop app, then retry.");
      break;
    default:
      lines.push(c.red(result.hint ?? result.action));
      for (const m of result.matches ?? []) lines.push(`  ${m.id.padEnd(18)} ${m.title}`);
  }
  return lines.join("\n");
}

export function defaultOpenDeps(): OpenDeps {
  return {
    engine: () => EngineApiClient.connect(),
    openUrl: (url) => open(url),
    isLoggedIn: async () => (await getAuthToken()) !== null,
    gatewayUrl: resolveGatewayUrl,
  };
}

/** The navigation branch. Returns the result so tests can assert without a
 *  process exit; sets exitCode 1 when nothing could be opened. */
export async function runOpenNavigation(
  target: string | undefined,
  options: OpenNavigationOptions,
  deps: OpenDeps = defaultOpenDeps(),
  log: (line: string) => void = console.log
): Promise<OpenResult> {
  const result = await runOpen(
    {
      target: options.list ? undefined : target,
      params: parseParamOptions(options),
      surface: surfaceFromOptions(options),
      open: options.print !== true,
    },
    deps
  );
  log(options.json ? JSON.stringify(result, null, 2) : formatOpenResult(result));
  if (!result.ok) process.exitCode = 1;
  return result;
}

async function openProjectPath(projectPath: string): Promise<void> {
  const fullPath = resolve(projectPath);

  if (!existsSync(fullPath)) {
    console.error(`Directory not found: ${fullPath}`);
    process.exit(1);
  }

  if (!existsSync(`${fullPath}/project.godot`)) {
    console.error(
      `No project.godot found in ${fullPath}\n` +
      "This doesn't look like a Summer Engine project.\n" +
      "Create one with: summer create 3d-basic my-game"
    );
    process.exit(1);
  }

  const port = await getApiPort();
  const health = await checkEngineHealth(port);

  if (!health) {
    console.log("Engine not running. Launching with this project...");
    // Import dynamically to avoid circular deps. `from: "user"` means the
    // array holds ONLY user arguments — no node/script prefix — otherwise
    // commander binds `[path]` to "node".
    const { runCommand } = await import("./run.js");
    await runCommand.parseAsync([fullPath], { from: "user" });
    return;
  }

  console.log(`Opening project: ${fullPath}`);
  console.log(
    "Note: To switch projects, close the current one in Summer Engine first,\n" +
    "then run: summer run " + fullPath
  );
}

export const openCommand = new Command("open")
  .description(
    "Open a project in Summer Engine, or open a Summer destination by name — a summerengine.com page (billing, my-games, pricing, mcp-guide …) or an editor surface (scene, node, script, inspector …)"
  )
  .argument("[target]", "Project directory (contains project.godot), or a destination: id, phrase, res:// path, or summerengine.com path")
  .option("--print", "Resolve only: print the URL or engine op, open nothing")
  .option("--list", "List every destination with surface and status")
  .option("--web", "Only match website destinations")
  .option("--editor", "Only match editor destinations")
  .option("--json", "Print the full result as JSON")
  .option("--path <res>", "res:// path for scene / script / file targets")
  .option("--node <path>", "Node path for the node target, e.g. Player/Camera3D")
  .option("--scene <res>", "Scene to open before selecting a node")
  .option("--param <key=value>", "Slot value (gameId, section, username, version, guide); repeatable", (value: string, previous: string[] = []) => [...previous, value])
  .action(async (target: string | undefined, options: OpenNavigationOptions) => {
    if (target !== undefined && !options.list && looksLikeProjectPath(target)) {
      await openProjectPath(target);
      return;
    }
    try {
      await runOpenNavigation(target, options);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });
