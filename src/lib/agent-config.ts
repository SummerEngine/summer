import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

export const SUMMER_MCP_SERVER_NAME = "summer-engine";

export const supportedAgents = [
  "codex",
  "claude-code",
  "cursor",
  "windsurf",
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
  format: "json" | "toml";
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

export function createSummerMcpServerConfig(localDev: boolean): StdioMcpServerConfig {
  if (localDev) {
    return {
      command: "node",
      args: [resolveLocalCliPath(), "mcp"],
    };
  }

  return {
    command: "npx",
    args: ["summer-engine", "mcp"],
  };
}

export function renderConfigSnippet(
  agent: SupportedAgent,
  server: StdioMcpServerConfig
): string {
  if (agent === "codex") {
    return renderCodexServerTable(server);
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

function resolveConfigTarget(
  agent: SupportedAgent,
  scope: ConfigScope,
  cwd: string,
  env: NodeJS.ProcessEnv
): { path: string; format: "json" | "toml"; warnings: string[] } {
  const override = getConfigPathOverride(agent, env);
  const warnings: string[] = [];

  if (override) {
    return {
      path: resolve(override),
      format: agent === "codex" ? "toml" : "json",
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

  if (scope === "project") {
    warnings.push(
      "Windsurf documents MCP configuration as user-scoped; project scope writes .windsurf/mcp_config.json for teams that load workspace config."
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

function getConfigPathOverride(
  agent: SupportedAgent,
  env: NodeJS.ProcessEnv
): string | undefined {
  if (agent === "codex") return env.SUMMER_CODEX_CONFIG_FILE;
  if (agent === "claude-code") return env.SUMMER_CLAUDE_CONFIG_FILE;
  if (agent === "cursor") return env.SUMMER_CURSOR_MCP_CONFIG_FILE;
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
          : "Restart Windsurf and refresh MCP servers from Cascade settings.";

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
