import { existsSync, readFileSync } from "fs";
import { copyFile, mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { PACKAGE_ROOT } from "../core/package-root.js";
import { homedir, platform } from "os";

export const SUMMER_MCP_SERVER_NAME = "summer-engine";

export const supportedAgents = [
  "codex",
  "claude-code",
  "cursor",
  "windsurf",
  "cline",
  "roo-code",
  "kilo-code",
  "gemini",
  "github-copilot",
  "vscode-copilot",
  "opencode",
  "lm-studio",
] as const;

export type SupportedAgent = (typeof supportedAgents)[number];
export type ConfigScope = "user" | "project";

export interface StdioMcpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface AgentConfigOptions {
  agent: SupportedAgent;
  scope: ConfigScope;
  dryRun?: boolean;
  print?: boolean;
  localDev?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface AgentConfigResult {
  agent: SupportedAgent;
  scope: ConfigScope;
  path: string;
  serverName: string;
  server: StdioMcpServerConfig;
  format: "json" | "toml" | "json-opencode" | "json-copilot" | "json-vscode";
  snippet: string;
  changed: boolean;
  wrote: boolean;
  dryRun: boolean;
  print: boolean;
  localDev: boolean;
  warnings: string[];
  nextSteps: string[];
}

type JsonObject = Record<string, unknown>;

const agentAliases: Record<string, SupportedAgent> = {
  claude: "claude-code",
  "claude-code": "claude-code",
  codex: "codex",
  cursor: "cursor",
  windsurf: "windsurf",
  devin: "windsurf",
  "devin-desktop": "windsurf",
  devindesktop: "windsurf",
  cline: "cline",
  "roo-code": "roo-code",
  roo: "roo-code",
  roocode: "roo-code",
  kilo: "kilo-code",
  kilocode: "kilo-code",
  "kilo-code": "kilo-code",
  gemini: "gemini",
  "gemini-cli": "gemini",
  copilot: "github-copilot",
  "copilot-cli": "github-copilot",
  "github-copilot": "github-copilot",
  "github-copilot-cli": "github-copilot",
  vscode: "vscode-copilot",
  "vs-code": "vscode-copilot",
  "vscode-copilot": "vscode-copilot",
  "vs-code-copilot": "vscode-copilot",
  "github-copilot-vscode": "vscode-copilot",
  opencode: "opencode",
  "open-code": "opencode",
  lmstudio: "lm-studio",
  "lm-studio": "lm-studio",
  "lm_studio": "lm-studio",
};

export function parseAgent(value: string | undefined): SupportedAgent | null {
  if (!value) return null;
  return agentAliases[value.trim().toLowerCase()] ?? null;
}

export function parseScope(value: string | undefined): ConfigScope | null {
  if (!value) return "user";
  const normalized = value.trim().toLowerCase();
  if (normalized === "user" || normalized === "project") return normalized;
  return null;
}

/** `summer setup [agent] --agent <agent>`: positional and option must agree;
 *  throws with a user-facing message when neither names a supported agent. */
export function resolveAgentSelection(
  agentArg: string | undefined,
  agentOpt: string | undefined
): SupportedAgent {
  if (agentArg && agentOpt && parseAgent(agentArg) !== parseAgent(agentOpt)) {
    throw new Error("Specify the agent either positionally or with --agent, not both.");
  }

  const parsed = parseAgent(agentOpt ?? agentArg);
  if (!parsed) {
    throw new Error(`Specify an agent: ${supportedAgents.join(", ")}`);
  }

  return parsed;
}

/** `--scope` with a user-facing error; absent means "user". */
export function resolveConfigScope(scopeOpt: string | undefined): ConfigScope {
  const parsed = parseScope(scopeOpt);
  if (!parsed) {
    throw new Error("Invalid --scope. Use user or project.");
  }
  return parsed;
}

export async function configureAgentMcp(
  options: AgentConfigOptions
): Promise<AgentConfigResult> {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const server = createSummerMcpServerConfig(Boolean(options.localDev));
  const target = resolveConfigTarget(options.agent, options.scope, cwd, env);
  const snippet = renderConfigSnippet(options.agent, server);
  const dryRun = Boolean(options.dryRun);
  const print = Boolean(options.print);
  const shouldWrite = !dryRun && !print;

  const update = print
    ? { changed: true }
    : target.format === "toml"
      ? await upsertCodexConfig(target.path, server, shouldWrite)
      : target.format === "json-opencode"
        ? await upsertOpencodeConfig(target.path, server, shouldWrite)
        : target.format === "json-copilot"
          ? await upsertCopilotConfig(target.path, server, shouldWrite)
          : target.format === "json-vscode"
            ? await upsertVsCodeMcpConfig(target.path, server, shouldWrite)
            : options.agent === "gemini"
              ? await upsertGeminiExtension(target.path, server, shouldWrite)
              : await upsertJsonMcpConfig(target.path, server, shouldWrite);

  return {
    agent: options.agent,
    scope: options.scope,
    path: target.path,
    serverName: SUMMER_MCP_SERVER_NAME,
    server,
    format: target.format,
    snippet,
    changed: update.changed,
    wrote: shouldWrite && update.changed,
    dryRun,
    print,
    localDev: Boolean(options.localDev),
    warnings: target.warnings,
    nextSteps: createNextSteps(options.agent, options.scope, target.path),
  };
}

export function createSummerMcpServerConfig(
  localDev: boolean,
  platform: NodeJS.Platform = process.platform
): StdioMcpServerConfig {
  if (localDev) {
    // node is a real executable on every platform; spawn("node") resolves fine.
    return {
      command: "node",
      args: [resolveLocalCliPath(), "mcp"],
    };
  }

  // On Windows, npx is a .cmd/.ps1 shim, and Node's spawn() does not do PATHEXT
  // resolution — hosts that spawn("npx") directly (Claude Code, Kimi Code,
  // Cursor, ...) fail with ENOENT even though npx works in a terminal. Route
  // through cmd.exe so the shim resolves. (User-reported: Imitater967, 2026-09-01.)
  if (platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/c", "npx", "-y", "summer-engine@latest", "mcp"],
    };
  }

  return {
    command: "npx",
    args: ["-y", "summer-engine@latest", "mcp"],
  };
}

export function renderConfigSnippet(
  agent: SupportedAgent,
  server: StdioMcpServerConfig
): string {
  if (agent === "codex") {
    return renderCodexServerTable(server);
  }

  if (agent === "opencode") {
    return (
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          mcp: {
            [SUMMER_MCP_SERVER_NAME]: opencodeServerEntry(server),
          },
        },
        null,
        2
      ) + "\n"
    );
  }

  if (agent === "github-copilot") {
    return (
      JSON.stringify(
        {
          mcpServers: {
            [SUMMER_MCP_SERVER_NAME]: copilotServerEntry(server),
          },
        },
        null,
        2
      ) + "\n"
    );
  }

  if (agent === "vscode-copilot") {
    return (
      JSON.stringify(
        {
          servers: {
            [SUMMER_MCP_SERVER_NAME]: vsCodeServerEntry(server),
          },
        },
        null,
        2
      ) + "\n"
    );
  }

  if (agent === "gemini") {
    return renderJsonFile(geminiExtensionManifest(server, readBundledGeminiManifestSync()));
  }

  return (
    JSON.stringify(
      {
        mcpServers: {
          [SUMMER_MCP_SERVER_NAME]: server,
        },
      },
      null,
      2
    ) + "\n"
  );
}

function resolveLocalCliPath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return resolve(dirname(thisFile), "..", "bin", "summer.js");
}

/** Installed package root (dist/ and src/ alike). */
export function resolvePackageRoot(): string {
  return PACKAGE_ROOT;
}

/** Directory name Gemini expects the extension under; the manifest `name` must match it. */
export const GEMINI_EXTENSION_DIR_NAME = "summer-engine";

/** Files copied next to the extension manifest so `contextFileName` (GEMINI.md, which imports AGENTS.md) resolves. */
const GEMINI_CONTEXT_FILES = ["GEMINI.md", "AGENTS.md"] as const;

function resolveConfigTarget(
  agent: SupportedAgent,
  scope: ConfigScope,
  cwd: string,
  env: NodeJS.ProcessEnv
): { path: string; format: "json" | "toml" | "json-opencode" | "json-copilot" | "json-vscode"; warnings: string[] } {
  const override = getConfigPathOverride(agent, env);
  const warnings: string[] = [];

  if (override) {
    if (
      scope === "project" &&
      (agent === "cline" || agent === "roo-code" || agent === "gemini" || agent === "lm-studio")
    ) {
      warnings.push(
        `${agent} MCP config has no project scope today; treating as user scope.`
      );
    }
    return {
      path: resolve(override),
      format:
        agent === "codex"
          ? "toml"
          : agent === "opencode"
            ? "json-opencode"
            : agent === "github-copilot"
              ? "json-copilot"
              : agent === "vscode-copilot"
                ? "json-vscode"
            : "json",
      warnings,
    };
  }

  if (agent === "codex") {
    return {
      path:
        scope === "user"
          ? join(homedir(), ".codex", "config.toml")
          : join(cwd, ".codex", "config.toml"),
      format: "toml",
      warnings,
    };
  }

  if (agent === "claude-code") {
    return {
      path:
        scope === "user"
          ? join(homedir(), ".claude.json")
          : join(cwd, ".mcp.json"),
      format: "json",
      warnings,
    };
  }

  if (agent === "cursor") {
    return {
      path:
        scope === "user"
          ? join(homedir(), ".cursor", "mcp.json")
          : join(cwd, ".cursor", "mcp.json"),
      format: "json",
      warnings,
    };
  }

  if (agent === "cline") {
    if (scope === "project") {
      warnings.push(
        "Cline MCP config has no project scope today; writing to user-scope global VS Code storage instead."
      );
    }
    return {
      path: vsCodeGlobalStoragePath(env, "saoudrizwan.claude-dev"),
      format: "json",
      warnings,
    };
  }

  if (agent === "roo-code") {
    if (scope === "project") {
      warnings.push(
        "Roo Code MCP config has no project scope today; writing to user-scope global VS Code storage instead."
      );
    }
    return {
      path: vsCodeGlobalStoragePath(env, "rooveterinaryinc.roo-cline"),
      format: "json",
      warnings,
    };
  }

  if (agent === "kilo-code") {
    return {
      path:
        scope === "user"
          ? vsCodeGlobalStoragePath(env, "kilocode.kilo-code", "mcp_settings.json")
          : join(cwd, ".kilocode", "mcp.json"),
      format: "json",
      warnings,
    };
  }

  if (agent === "lm-studio") {
    if (scope === "project") {
      warnings.push(
        "LM Studio's MCP config is app-global (~/.lmstudio/mcp.json); treating as user scope."
      );
    }
    return {
      path: join(homedir(), ".lmstudio", "mcp.json"),
      format: "json",
      warnings,
    };
  }

  if (agent === "gemini") {
    if (scope === "project") {
      warnings.push(
        "Gemini extensions are user-scoped today; writing to ~/.gemini/extensions/summer-engine/ instead of project."
      );
    }
    return {
      path: join(
        homedir(),
        ".gemini",
        "extensions",
        "summer-engine",
        "gemini-extension.json"
      ),
      format: "json",
      warnings,
    };
  }

  if (agent === "github-copilot") {
    return {
      path:
        scope === "user"
          ? join(homedir(), ".copilot", "mcp-config.json")
          : join(cwd, ".mcp.json"),
      format: "json-copilot",
      warnings,
    };
  }

  if (agent === "vscode-copilot") {
    return {
      path:
        scope === "user"
          ? vsCodeUserMcpPath(env)
          : join(cwd, ".vscode", "mcp.json"),
      format: "json-vscode",
      warnings,
    };
  }

  if (agent === "opencode") {
    return {
      path:
        scope === "user"
          ? opencodeUserConfigPath(env)
          : join(cwd, "opencode.json"),
      format: "json-opencode",
      warnings,
    };
  }

  if (scope === "project") {
    warnings.push(
      "Devin Desktop (formerly Windsurf) documents MCP configuration as user-scoped; project scope writes .windsurf/mcp_config.json for teams that load workspace config."
    );
  }

  return {
    path:
      scope === "user"
        ? join(homedir(), ".codeium", "windsurf", "mcp_config.json")
        : join(cwd, ".windsurf", "mcp_config.json"),
    format: "json",
    warnings,
  };
}

function vsCodeGlobalStoragePath(
  env: NodeJS.ProcessEnv,
  extensionId: string,
  fileName = "cline_mcp_settings.json"
): string {
  const os = platform();
  if (os === "win32") {
    const appData = env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(
      appData,
      "Code",
      "User",
      "globalStorage",
      extensionId,
      "settings",
      fileName
    );
  }

  if (os === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "Code",
      "User",
      "globalStorage",
      extensionId,
      "settings",
      fileName
    );
  }

  // Linux and other Unix
  const xdg = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(
    xdg,
    "Code",
    "User",
    "globalStorage",
    extensionId,
    "settings",
    fileName
  );
}

function opencodeUserConfigPath(env: NodeJS.ProcessEnv): string {
  const os = platform();
  if (os === "win32") {
    const appData = env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "opencode", "opencode.json");
  }
  const xdg = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdg, "opencode", "opencode.json");
}

function vsCodeUserMcpPath(env: NodeJS.ProcessEnv): string {
  const os = platform();
  if (os === "win32") {
    const appData = env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "Code", "User", "mcp.json");
  }
  if (os === "darwin") {
    return join(homedir(), "Library", "Application Support", "Code", "User", "mcp.json");
  }
  const xdg = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdg, "Code", "User", "mcp.json");
}

function getConfigPathOverride(
  agent: SupportedAgent,
  env: NodeJS.ProcessEnv
): string | undefined {
  if (agent === "codex") return env.SUMMER_CODEX_CONFIG_FILE;
  if (agent === "claude-code") return env.SUMMER_CLAUDE_CONFIG_FILE;
  if (agent === "cursor") return env.SUMMER_CURSOR_MCP_CONFIG_FILE;
  if (agent === "cline") return env.SUMMER_CLINE_CONFIG_FILE;
  if (agent === "roo-code") return env.SUMMER_ROO_CODE_CONFIG_FILE;
  if (agent === "kilo-code") return env.SUMMER_KILO_CODE_CONFIG_FILE;
  if (agent === "lm-studio") return env.SUMMER_LM_STUDIO_CONFIG_FILE;
  if (agent === "gemini") return env.SUMMER_GEMINI_CONFIG_FILE;
  if (agent === "github-copilot") return env.SUMMER_GITHUB_COPILOT_CONFIG_FILE;
  if (agent === "vscode-copilot") return env.SUMMER_VSCODE_COPILOT_CONFIG_FILE;
  if (agent === "opencode") return env.SUMMER_OPENCODE_CONFIG_FILE;
  return env.SUMMER_WINDSURF_MCP_CONFIG_FILE;
}

async function upsertJsonMcpConfig(
  path: string,
  server: StdioMcpServerConfig,
  write: boolean
): Promise<{ changed: boolean }> {
  const current = await readJsonConfig(path);
  const next = copyJsonObject(current);

  next.mcpServers = mergeMcpServers(next.mcpServers, server);

  const currentRendered = renderJsonFile(current);
  const nextRendered = renderJsonFile(next);
  const changed = currentRendered !== nextRendered;

  if (write && changed) {
    await writeTextFile(path, nextRendered);
  }

  return { changed };
}

function mergeMcpServers(
  value: unknown,
  server: StdioMcpServerConfig
): Record<string, unknown> {
  if (value !== undefined && !isJsonObject(value)) {
    throw new Error("Existing mcpServers value must be a JSON object.");
  }

  return {
    ...(isJsonObject(value) ? value : {}),
    [SUMMER_MCP_SERVER_NAME]: server,
  };
}

async function readJsonConfig(path: string): Promise<JsonObject> {
  if (!existsSync(path)) return {};

  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch (error) {
    throw new Error(`Could not read ${path}: ${formatError(error)}`);
  }

  if (content.trim() === "") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Could not parse JSON in ${path}: ${formatError(error)}`);
  }

  if (!isJsonObject(parsed)) {
    throw new Error(`Expected ${path} to contain a JSON object.`);
  }

  return parsed;
}

async function upsertCodexConfig(
  path: string,
  server: StdioMcpServerConfig,
  write: boolean
): Promise<{ changed: boolean }> {
  const current = await readTextFileIfExists(path);
  const next = upsertTomlTable(current, renderCodexServerTable(server));
  const changed = current !== next;

  if (write && changed) {
    await writeTextFile(path, next);
  }

  return { changed };
}

async function upsertOpencodeConfig(
  path: string,
  server: StdioMcpServerConfig,
  write: boolean
): Promise<{ changed: boolean }> {
  const current = await readJsonConfig(path);
  const next = copyJsonObject(current);

  if (typeof next.$schema !== "string") {
    next.$schema = "https://opencode.ai/config.json";
  }

  const existingMcp = isJsonObject(next.mcp) ? next.mcp : {};
  next.mcp = {
    ...existingMcp,
    [SUMMER_MCP_SERVER_NAME]: opencodeServerEntry(server),
  };

  const currentRendered = renderJsonFile(current);
  const nextRendered = renderJsonFile(next);
  const changed = currentRendered !== nextRendered;

  if (write && changed) {
    await writeTextFile(path, nextRendered);
  }

  return { changed };
}

async function upsertCopilotConfig(
  path: string,
  server: StdioMcpServerConfig,
  write: boolean
): Promise<{ changed: boolean }> {
  const current = await readJsonConfig(path);
  const next = copyJsonObject(current);

  next.mcpServers = mergeNamedObject(
    next.mcpServers,
    SUMMER_MCP_SERVER_NAME,
    copilotServerEntry(server),
    "mcpServers"
  );

  const currentRendered = renderJsonFile(current);
  const nextRendered = renderJsonFile(next);
  const changed = currentRendered !== nextRendered;

  if (write && changed) {
    await writeTextFile(path, nextRendered);
  }

  return { changed };
}

async function upsertVsCodeMcpConfig(
  path: string,
  server: StdioMcpServerConfig,
  write: boolean
): Promise<{ changed: boolean }> {
  const current = await readJsonConfig(path);
  const next = copyJsonObject(current);

  next.servers = mergeNamedObject(
    next.servers,
    SUMMER_MCP_SERVER_NAME,
    vsCodeServerEntry(server),
    "servers"
  );

  const currentRendered = renderJsonFile(current);
  const nextRendered = renderJsonFile(next);
  const changed = currentRendered !== nextRendered;

  if (write && changed) {
    await writeTextFile(path, nextRendered);
  }

  return { changed };
}

async function upsertGeminiExtension(
  path: string,
  server: StdioMcpServerConfig,
  write: boolean
): Promise<{ changed: boolean }> {
  const current = await readJsonConfig(path);
  const bundled = await readBundledGeminiManifest();
  const next = geminiExtensionManifest(server, bundled, current);

  const currentRendered = renderJsonFile(current);
  const nextRendered = renderJsonFile(next);
  let changed = currentRendered !== nextRendered;

  if (write && changed) {
    await writeTextFile(path, nextRendered);
  }

  // GEMINI.md (the declared contextFileName) and AGENTS.md (which it imports)
  // must sit next to the manifest or Gemini has no context file to load.
  const extensionDir = dirname(path);
  const packageRoot = resolvePackageRoot();
  for (const name of GEMINI_CONTEXT_FILES) {
    const src = join(packageRoot, name);
    if (!existsSync(src)) continue;
    const dest = join(extensionDir, name);
    const srcText = await readFile(src, "utf-8");
    const destText = existsSync(dest) ? await readFile(dest, "utf-8") : null;
    if (destText === srcText) continue;
    changed = true;
    if (write) {
      await mkdir(extensionDir, { recursive: true, mode: 0o700 });
      await copyFile(src, dest);
    }
  }

  return { changed };
}

/**
 * The GENERATED gemini-extension.json shipped at the package root
 * (registry/generated/gemini-extension.json -> gemini-extension.json). Absent
 * only in broken installs; the installer then falls back to a minimal manifest.
 */
async function readBundledGeminiManifest(): Promise<JsonObject> {
  const path = join(resolvePackageRoot(), "gemini-extension.json");
  if (!existsSync(path)) return {};
  try {
    return await readJsonConfig(path);
  } catch {
    return {};
  }
}

function readBundledGeminiManifestSync(): JsonObject {
  const path = join(resolvePackageRoot(), "gemini-extension.json");
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return isJsonObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Manifest written to ~/.gemini/extensions/summer-engine/gemini-extension.json.
 *
 * Starts from the generated package manifest (version, description, settings,
 * contextFileName, ...) so the installed copy never drifts from the registry,
 * then overrides what only makes sense at install time:
 *  - `name` = the extension directory name (Gemini requires them to match;
 *    geminicli.com/docs/extensions/reference), which is "summer-engine".
 *  - `mcpServers` = the same launcher every other host gets (npx -y ...@latest,
 *    cmd.exe-wrapped on Windows). The bundled entry runs from `${extensionPath}`
 *    where no package is installed, and that only works inside the npm layout.
 *  - `skills` is dropped: Gemini has no such manifest field; it discovers
 *    <extension>/skills/<name>/SKILL.md, which `summer skills install --agent
 *    gemini` writes.
 *  - the `_generated` banner is dropped: this file is written by the installer.
 * Unknown keys already present in the user's file (`base`) are preserved.
 */
function geminiExtensionManifest(
  server: StdioMcpServerConfig,
  bundled: JsonObject,
  base: JsonObject = {}
): JsonObject {
  const { _generated: _banner, skills: _skills, ...fromPackage } = bundled;
  const manifest: JsonObject = { ...base, ...fromPackage };
  manifest.name = GEMINI_EXTENSION_DIR_NAME;
  if (typeof manifest.description !== "string") {
    manifest.description =
      "Agent tooling for Summer Engine: MCP bridge, context primer, and game-dev skills.";
  }
  manifest.contextFileName = "GEMINI.md";
  manifest.mcpServers = {
    [SUMMER_MCP_SERVER_NAME]: {
      command: server.command,
      args: server.args,
      ...(server.env && Object.keys(server.env).length > 0 ? { env: { ...server.env } } : {}),
    },
  };
  return manifest;
}

function opencodeServerEntry(server: StdioMcpServerConfig): JsonObject {
  const entry: JsonObject = {
    type: "local",
    command: [server.command, ...server.args],
  };
  if (server.env && Object.keys(server.env).length > 0) {
    entry.environment = { ...server.env };
  }
  return entry;
}

function copilotServerEntry(server: StdioMcpServerConfig): JsonObject {
  const entry: JsonObject = {
    type: "local",
    command: server.command,
    args: server.args,
    tools: ["*"],
  };
  if (server.env && Object.keys(server.env).length > 0) {
    entry.env = { ...server.env };
  }
  return entry;
}

function vsCodeServerEntry(server: StdioMcpServerConfig): JsonObject {
  const entry: JsonObject = {
    type: "stdio",
    command: server.command,
    args: server.args,
  };
  if (server.env && Object.keys(server.env).length > 0) {
    entry.env = { ...server.env };
  }
  return entry;
}

async function readTextFileIfExists(path: string): Promise<string> {
  if (!existsSync(path)) return "";
  try {
    return await readFile(path, "utf-8");
  } catch (error) {
    throw new Error(`Could not read ${path}: ${formatError(error)}`);
  }
}

function upsertTomlTable(content: string, table: string): string {
  const lines = content.split(/\r?\n/);
  const serverHeader = /^\s*\[mcp_servers\.(?:"summer-engine"|summer-engine)(?:\.|\])/;
  const start = lines.findIndex((line) =>
    /^\s*\[mcp_servers\.(?:"summer-engine"|summer-engine)\]\s*(?:#.*)?$/.test(line)
  );

  if (start === -1) {
    const trimmed = content.endsWith("\n") || content === "" ? content : `${content}\n`;
    return `${trimmed}${trimmed === "" ? "" : "\n"}${table}`;
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index]) && !serverHeader.test(lines[index])) {
      end = index;
      break;
    }
  }

  const replacement = table.trimEnd().split("\n");
  if (lines[end] && lines[end].trim() !== "") {
    replacement.push("");
  }
  const nextLines = [
    ...lines.slice(0, start),
    ...replacement,
    ...lines.slice(end),
  ];
  return ensureTrailingNewline(nextLines.join("\n"));
}

function renderCodexServerTable(server: StdioMcpServerConfig): string {
  const lines = [
    `[mcp_servers.${SUMMER_MCP_SERVER_NAME}]`,
    `command = ${tomlString(server.command)}`,
    `args = [${server.args.map(tomlString).join(", ")}]`,
  ];

  if (server.env && Object.keys(server.env).length > 0) {
    lines.push(
      `env = { ${Object.entries(server.env)
        .map(([key, value]) => `${key} = ${tomlString(value)}`)
        .join(", ")} }`
    );
  }

  return `${lines.join("\n")}\n`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function renderJsonFile(value: JsonObject): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function copyJsonObject(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function mergeNamedObject(
  value: unknown,
  key: string,
  entry: JsonObject,
  label: string
): Record<string, unknown> {
  if (value !== undefined && !isJsonObject(value)) {
    throw new Error(`Existing ${label} value must be a JSON object.`);
  }

  return {
    ...(isJsonObject(value) ? value : {}),
    [key]: entry,
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function writeTextFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { encoding: "utf-8", mode: 0o600 });
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function createNextSteps(
  agent: SupportedAgent,
  scope: ConfigScope,
  path: string
): string[] {
  const restart =
    agent === "claude-code"
      ? "Restart Claude Code or run /mcp in a new session."
      : agent === "codex"
        ? "Restart Codex or run /mcp in a new session."
        : agent === "cursor"
          ? "Restart Cursor and enable the summer-engine MCP server if prompted."
          : agent === "cline"
            ? "Restart VS Code so Cline reloads its MCP config."
            : agent === "roo-code"
              ? "Restart VS Code so Roo Code reloads its MCP config."
              : agent === "kilo-code"
                ? "Restart VS Code so Kilo Code reloads its MCP config."
                : agent === "lm-studio"
                  ? "Open LM Studio, toggle on the summer-engine MCP server in the Program tab, and raise the loaded model's context length to 32k or higher."
        : agent === "gemini"
          ? "Run `summer skills install --all --agent gemini` if skills were not installed, then restart Gemini CLI (or `gemini extensions enable summer-engine` if it is disabled)."
          : agent === "github-copilot"
            ? "Restart Copilot CLI, or run /mcp reload and /skills reload in the active session."
            : agent === "vscode-copilot"
              ? "Restart VS Code or run MCP: List Servers, then start summer-engine in Copilot Agent mode."
              : agent === "opencode"
                ? "Restart OpenCode so it reloads opencode.json."
                : "Restart Devin Desktop (formerly Windsurf) and refresh MCP servers from the agent settings.";

  const projectTrust =
    scope === "project" && agent === "codex"
      ? "Codex only loads project .codex/config.toml from trusted projects."
      : null;

  return [projectTrust, `Updated ${path}.`, restart].filter(
    (step): step is string => Boolean(step)
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
