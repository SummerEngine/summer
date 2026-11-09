/**
 * `summer setup --detect`: which agents from agent-table.ts are on this
 * computer, where each one's MCP config file is, and whether it already lists
 * summer-engine. Reads only; never writes.
 *
 * How an agent counts as installed (any one hit; `detectedBy` names each):
 *  - bin: one of its commands is a file on PATH, or in a usual install folder
 *    (~/.local/bin, /opt/homebrew/bin, %APPDATA%\npm, ...). A desktop app's
 *    installer runs with a short PATH that leaves those out, so they are
 *    checked by name. On Windows each name is tried with every PATHEXT ending.
 *  - app: a macOS app bundle in /Applications or ~/Applications, or a Windows
 *    executable under %LOCALAPPDATA%, %ProgramFiles% or %ProgramFiles(x86)%.
 *  - folder: a config, data or install folder the agent makes on first run.
 *  - extension: a VS Code extension folder in ~/.vscode/extensions.
 * The per-agent names live in agent-table.ts (`detect`).
 */
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import {
  allAgentSpecs,
  defaultPathContext,
  resolveMcpPath,
  type AgentSpec,
  type ConfigScope,
  type McpFormat,
  type PathContext,
  type SupportedAgent,
} from "./agent-table.js";
import { listsSummerEngine, readRecordedMcpServer } from "./version-check.js";
import { toStepError, type SetupStepError } from "./setup-error.js";
import type { StdioMcpServerConfig } from "./agent-config.js";

export interface DetectHit {
  kind: "bin" | "app" | "folder" | "extension";
  path: string;
}

export interface DetectedAgent {
  id: SupportedAgent;
  label: string;
  /** legacy: the product was retired or renamed; setup still writes it, with a warning. */
  status: "active" | "legacy";
  installed: boolean;
  /** A command, app or extension was found, not only a folder. A folder can outlive the
   *  program, or be one an earlier Summer setup made for its skills or config. */
  programFound: boolean;
  /** Every place that showed the agent is installed (empty when not installed). */
  detectedBy: DetectHit[];
  /** The MCP config file `summer setup <id>` writes at user scope (project scope for agents with no user file). */
  configPath: string;
  configScope: ConfigScope;
  configFormat: McpFormat;
  configExists: boolean;
  /** The config file lists a summer-engine MCP server, in any shape. */
  mcpEntry: boolean;
  /** The command the summer-engine entry runs, when it is a local (stdio) entry. */
  mcpServer: StdioMcpServerConfig | null;
  /** Setup also adds the Summer Games MCP for this agent. */
  summerGames: boolean;
  /** Setup also installs skills for this agent. */
  skills: boolean;
  /** Set when the config file exists but cannot be read. */
  configError?: SetupStepError;
}

export interface DetectOptions {
  ctx?: PathContext;
  /** Folders searched for macOS app bundles; default /Applications and ~/Applications. */
  macAppDirs?: string[];
  /** Shared command folders outside home searched on macOS and Linux; default Homebrew's /opt/homebrew/bin and /usr/local/bin. */
  systemBinDirs?: string[];
}

export function detectAgents(options: DetectOptions = {}): DetectedAgent[] {
  const ctx = options.ctx ?? defaultPathContext();
  const binDirs = searchedBinDirs(ctx, options.systemBinDirs);
  const macAppDirs = options.macAppDirs ?? ["/Applications", join(ctx.home, "Applications")];
  return allAgentSpecs().map((spec) => detectAgent(spec, ctx, binDirs, macAppDirs));
}

function detectAgent(spec: AgentSpec, ctx: PathContext, binDirs: string[], macAppDirs: string[]): DetectedAgent {
  const detectedBy = [
    ...(spec.detect.bins ?? []).flatMap((name) => findBin(name, binDirs, ctx)).map((path): DetectHit => ({ kind: "bin", path })),
    ...findApps(spec, ctx, macAppDirs).map((path): DetectHit => ({ kind: "app", path })),
    ...(spec.detect.dirs?.(ctx) ?? []).filter((path) => existsSync(path)).map((path): DetectHit => ({ kind: "folder", path })),
    ...findVsCodeExtensions(spec.detect.vscodeExtensions ?? [], ctx).map((path): DetectHit => ({ kind: "extension", path })),
  ];
  const unique = detectedBy.filter((hit, index) => detectedBy.findIndex((other) => other.path === hit.path) === index);

  const resolved = resolveMcpPath(spec, "user", ctx);
  const override = ctx.env[spec.envOverride];
  const configPath = override || resolved.path;
  const configExists = existsSync(configPath);
  let mcpEntry = false;
  let mcpServer: StdioMcpServerConfig | null = null;
  let configError: SetupStepError | undefined;
  if (configExists) {
    try {
      const text = readFileSync(configPath, "utf-8");
      mcpEntry = listsSummerEngine(text, spec.format);
      mcpServer = readRecordedMcpServer(text, spec.format);
    } catch (error) {
      configError = toStepError(error, "config_unreadable");
    }
  }
  return {
    id: spec.id,
    label: spec.label,
    status: spec.status,
    installed: unique.length > 0,
    programFound: unique.some((hit) => hit.kind !== "folder"),
    detectedBy: unique,
    configPath,
    configScope: resolved.scope,
    configFormat: spec.format,
    configExists,
    mcpEntry,
    mcpServer,
    summerGames: Boolean(spec.remoteMcp),
    skills: spec.skills !== null,
    ...(configError ? { configError } : {}),
  };
}

/** PATH first, then the install folders a GUI-launched process's PATH leaves out. */
export function searchedBinDirs(ctx: PathContext, systemBinDirs: string[] = ["/opt/homebrew/bin", "/usr/local/bin"]): string[] {
  const path = ctx.env.PATH ?? ctx.env.Path ?? "";
  const sep = ctx.os === "win32" ? ";" : ":";
  const fromPath = path.split(sep).filter(Boolean);
  const home = ctx.home;
  const usual =
    ctx.os === "win32"
      ? [
          join(home, ".local", "bin"),
          join(ctx.env.APPDATA ?? join(home, "AppData", "Roaming"), "npm"),
          join(localAppData(ctx), "Microsoft", "WinGet", "Links"),
          join(localAppData(ctx), "pnpm"),
          join(home, ".bun", "bin"),
          join(home, ".volta", "bin"),
          join(home, ".lmstudio", "bin"),
        ]
      : [
          join(home, ".local", "bin"),
          join(home, "bin"),
          ...systemBinDirs,
          join(home, ".npm-global", "bin"),
          join(home, ".bun", "bin"),
          join(home, ".volta", "bin"),
          join(home, "Library", "pnpm"),
          join(home, ".local", "share", "pnpm"),
          join(home, ".claude", "local"),
          join(home, ".opencode", "bin"),
          join(home, ".lmstudio", "bin"),
          ...nvmBinDirs(home),
        ];
  return [...new Set([...fromPath, ...usual])];
}

/** ~/.nvm/versions/node/<version>/bin for each installed Node (npm -g installs land there). */
function nvmBinDirs(home: string): string[] {
  const root = join(home, ".nvm", "versions", "node");
  try {
    return readdirSync(root).map((version) => join(root, version, "bin"));
  } catch {
    return [];
  }
}

function localAppData(ctx: PathContext): string {
  return ctx.env.LOCALAPPDATA ?? join(ctx.home, "AppData", "Local");
}

function findBin(name: string, dirs: string[], ctx: PathContext): string[] {
  const names =
    ctx.os === "win32"
      ? [name, ...(ctx.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((ext) => `${name}${ext.toLowerCase()}`)]
      : [name];
  const hits: string[] = [];
  for (const dir of dirs) {
    for (const candidate of names) {
      const path = join(dir, candidate);
      if (isRunnable(path, ctx)) {
        hits.push(path);
        break;
      }
    }
  }
  return hits;
}

function isRunnable(path: string, ctx: PathContext): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (ctx.os !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findApps(spec: AgentSpec, ctx: PathContext, macAppDirs: string[]): string[] {
  if (ctx.os === "darwin") {
    return (spec.detect.macApps ?? []).flatMap((app) => macAppDirs.map((dir) => join(dir, app))).filter((path) => existsSync(path));
  }
  if (ctx.os === "win32") {
    const roots = [localAppData(ctx), ctx.env.ProgramFiles, ctx.env["ProgramFiles(x86)"]].filter((root): root is string => Boolean(root));
    return (spec.detect.winApps ?? []).flatMap((exe) => roots.map((root) => join(root, exe))).filter((path) => existsSync(path));
  }
  return [];
}

function findVsCodeExtensions(prefixes: readonly string[], ctx: PathContext): string[] {
  if (prefixes.length === 0) return [];
  const dir = join(ctx.home, ".vscode", "extensions");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((entry) => prefixes.some((prefix) => entry.toLowerCase().startsWith(prefix))).map((entry) => join(dir, entry));
}
