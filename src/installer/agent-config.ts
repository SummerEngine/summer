import { existsSync, readFileSync } from "fs";
import { copyFile, mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { Document, isMap, parseDocument } from "yaml";
import { PACKAGE_ROOT } from "../core/package-root.js";
import {
  agentAliasMap,
  agentSpec,
  defaultPathContext,
  resolveMcpPath,
  supportedAgents,
  type AgentSpec,
  type ConfigScope,
  type McpFormat,
  type SupportedAgent,
} from "./agent-table.js";

export { supportedAgents, type ConfigScope, type SupportedAgent } from "./agent-table.js";

export const SUMMER_MCP_SERVER_NAME = "summer-engine";

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
  /** npm dist-tag the generated MCP entry runs (`npx -y summer-engine@<channel> mcp`).
   *  Default "latest"; "next" while a release soaks on the next tag. Ignored with localDev. */
  channel?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface AgentConfigResult {
  agent: SupportedAgent;
  scope: ConfigScope;
  path: string;
  serverName: string;
  server: StdioMcpServerConfig;
  format: McpFormat;
  snippet: string;
  changed: boolean;
  wrote: boolean;
  dryRun: boolean;
  print: boolean;
  localDev: boolean;
  /** The dist-tag the written entry runs ("latest" unless --channel / SUMMER_CHANNEL). */
  channel: string;
  warnings: string[];
  nextSteps: string[];
}

type JsonObject = Record<string, unknown>;

const agentAliases: Record<string, SupportedAgent> = agentAliasMap();

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
  const channel = normalizeChannel(options.channel);
  const server = createSummerMcpServerConfig(Boolean(options.localDev), process.platform, channel);
  const spec = agentSpec(options.agent);
  const target = resolveConfigTarget(spec, options.scope, cwd, env);
  const snippet = renderConfigSnippet(options.agent, server);
  const dryRun = Boolean(options.dryRun);
  const print = Boolean(options.print);
  const shouldWrite = !dryRun && !print;

  const update = print
    ? { changed: true }
    : await upsertConfig(spec.format, target.path, server, shouldWrite);

  return {
    agent: options.agent,
    scope: options.scope,
    path: target.path,
    serverName: SUMMER_MCP_SERVER_NAME,
    server,
    format: spec.format,
    snippet,
    changed: update.changed,
    wrote: shouldWrite && update.changed,
    dryRun,
    print,
    localDev: Boolean(options.localDev),
    channel,
    warnings: target.warnings,
    nextSteps: [`Updated ${target.path}.`, spec.restart],
  };
}

/** The Summer Games player MCP: friends, parties, messages and the player's
 *  inbox, as the signed-in player. A remote server; the agent signs in to it
 *  with OAuth in the browser, so setup writes no credential. */
export const SUMMER_GAMES_MCP_SERVER_NAME = "summer-games";
export const SUMMER_GAMES_MCP_URL = "https://mcp.summer.games/mcp";

export interface RemoteMcpResult {
  /** The entry's name: summer-games, or the name the person already gave it. */
  serverName: string;
  url: string;
  path: string;
  changed: boolean;
  wrote: boolean;
  /** Set when the server was already listed under another name (e.g. a
   *  hand-added "summer"); setup then leaves the file alone. */
  existingName?: string;
  /** What the person does once to sign in (the agent opens summer.games). */
  signIn: string;
}

/**
 * Adds the Summer Games MCP next to summer-engine in the same config file.
 * An entry that already points at the same URL, under any name, counts as
 * added and is left as it is. Returns null for agents without a remote-server
 * entry in agent-table.ts.
 */
export async function configureSummerGamesMcp(
  options: Pick<AgentConfigOptions, "agent" | "scope" | "dryRun" | "cwd" | "env">
): Promise<RemoteMcpResult | null> {
  const spec = agentSpec(options.agent);
  if (!spec.remoteMcp) return null;
  const env = options.env ?? process.env;
  const target = resolveConfigTarget(spec, options.scope, resolve(options.cwd ?? process.cwd()), env);
  const write = !options.dryRun;
  const url = SUMMER_GAMES_MCP_URL;

  let existing: string | undefined;
  let changed = false;
  if (spec.remoteMcp.format === "toml-url") {
    const current = await readTextFileIfExists(target.path);
    existing = findTomlServerByUrl(current, url);
    if (!existing) {
      const name = SUMMER_GAMES_MCP_SERVER_NAME;
      const next = upsertTomlTable(current, `[mcp_servers.${name}]\nurl = ${tomlString(url)}\n`, name);
      changed = current !== next;
      if (write && changed) await writeTextFile(target.path, next);
    }
  } else {
    const current = await readJsonConfig(target.path);
    existing = findJsonServerByUrl(current, url);
    if (!existing) {
      const next = copyJsonObject(current);
      next.mcpServers = mergeNamedObject(next.mcpServers, SUMMER_GAMES_MCP_SERVER_NAME, { type: "http", url }, "mcpServers");
      const nextRendered = renderJsonFile(next);
      changed = renderJsonFile(current) !== nextRendered;
      if (write && changed) await writeTextFile(target.path, nextRendered);
    }
  }

  const serverName = existing ?? SUMMER_GAMES_MCP_SERVER_NAME;
  return {
    serverName,
    url,
    path: target.path,
    changed,
    wrote: write && changed,
    ...(existing && existing !== SUMMER_GAMES_MCP_SERVER_NAME ? { existingName: existing } : {}),
    signIn: spec.remoteMcp.signIn(serverName),
  };
}

function sameMcpUrl(a: unknown, b: string): boolean {
  if (typeof a !== "string") return false;
  const normalize = (value: string) => {
    try {
      const parsed = new URL(value.trim());
      return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`.toLowerCase();
    } catch {
      return value.trim().toLowerCase();
    }
  };
  return normalize(a) === normalize(b);
}

/** The name of a server with this URL in mcpServers. Claude Code's
 *  ~/.claude.json also keeps per-project servers (`claude mcp add` without
 *  --scope user) under projects.<dir>.mcpServers; those count too. */
function findJsonServerByUrl(config: JsonObject, url: string): string | undefined {
  const maps: unknown[] = [config.mcpServers];
  if (isJsonObject(config.projects)) {
    for (const project of Object.values(config.projects)) {
      if (isJsonObject(project)) maps.push(project.mcpServers);
    }
  }
  for (const map of maps) {
    if (!isJsonObject(map)) continue;
    for (const [name, entry] of Object.entries(map)) {
      if (isJsonObject(entry) && sameMcpUrl(entry.url, url)) return name;
    }
  }
  return undefined;
}

/** The name of a [mcp_servers.<name>] table whose url is this URL. */
function findTomlServerByUrl(content: string, url: string): string | undefined {
  let table: string | undefined;
  for (const line of content.split(/\r?\n/)) {
    const header = /^\s*\[([^\[\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      const server = /^mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))$/.exec(header[1].trim());
      table = server ? (server[1] ?? server[2]) : undefined;
      continue;
    }
    if (/^\s*\[/.test(line)) {
      table = undefined;
      continue;
    }
    const value = /^\s*url\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(line);
    if (table && value && sameMcpUrl(value[1] ?? value[2], url)) return table;
  }
  return undefined;
}

async function upsertConfig(
  format: McpFormat,
  path: string,
  server: StdioMcpServerConfig,
  write: boolean
): Promise<{ changed: boolean }> {
  switch (format) {
    case "toml":
      return upsertCodexConfig(path, server, write);
    case "toml-array":
      return upsertTomlArrayConfig(path, server, write);
    case "json-gemini":
      return upsertGeminiExtension(path, server, write);
    case "yaml-goose":
    case "yaml-hermes":
      return upsertYamlConfig(path, [topLevelKey(format), SUMMER_MCP_SERVER_NAME], mcpEntry(format, server), write);
    default:
      return upsertJsonEntry(path, format, server, write);
  }
}

export const DEFAULT_CHANNEL = "latest";

/** npm dist-tags are lowercase words like `latest`, `next`, `beta`, `v3-preview`;
 *  anything that could be read as a version or a path is refused (a bare
 *  version belongs in a version bump, not a channel). */
export function normalizeChannel(channel: string | undefined): string {
  const value = (channel ?? "").trim();
  if (value === "") return DEFAULT_CHANNEL;
  if (!/^[a-z][a-z0-9-]*$/.test(value) || /^v?\d/.test(value)) {
    throw new Error(
      `Invalid channel "${channel}": use an npm dist-tag such as latest or next (lowercase letters, digits, hyphens).`
    );
  }
  return value;
}

export function createSummerMcpServerConfig(
  localDev: boolean,
  platform: NodeJS.Platform = process.platform,
  channel: string = DEFAULT_CHANNEL
): StdioMcpServerConfig {
  const spec = `summer-engine@${normalizeChannel(channel)}`;
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
      args: ["/c", "npx", "-y", spec, "mcp"],
    };
  }

  return {
    command: "npx",
    args: ["-y", spec, "mcp"],
  };
}

export function renderConfigSnippet(
  agent: SupportedAgent,
  server: StdioMcpServerConfig
): string {
  const format = agentSpec(agent).format;
  if (format === "toml") return renderCodexServerTable(server);
  if (format === "toml-array") return renderTomlArrayEntry(server);
  if (format === "json-gemini") {
    return renderJsonFile(geminiExtensionManifest(server, readBundledGeminiManifestSync()));
  }
  if (format === "yaml-goose" || format === "yaml-hermes") {
    const doc = new Document({});
    doc.setIn([topLevelKey(format), SUMMER_MCP_SERVER_NAME], doc.createNode(mcpEntry(format, server)));
    return doc.toString();
  }
  const file: JsonObject = {};
  if (format === "json-opencode" && agent === "opencode") file.$schema = OPENCODE_SCHEMA;
  file[topLevelKey(format)] = { [SUMMER_MCP_SERVER_NAME]: mcpEntry(format, server) };
  return renderJsonFile(file);
}

const OPENCODE_SCHEMA = "https://opencode.ai/config.json";

/** The key under which the file lists MCP servers (see McpFormat in agent-table.ts). */
export function topLevelKey(format: McpFormat): string {
  switch (format) {
    case "json-vscode":
    case "json-servers":
      return "servers";
    case "json-opencode":
    case "json-crush":
      return "mcp";
    case "json-zed":
      return "context_servers";
    case "json-amp":
      return "amp.mcpServers";
    case "yaml-goose":
      return "extensions";
    case "yaml-hermes":
    case "toml":
    case "toml-array":
      return "mcp_servers";
    default:
      return "mcpServers";
  }
}

/** One server entry in the shape the agent's file expects. */
export function mcpEntry(format: McpFormat, server: StdioMcpServerConfig): JsonObject {
  const env = server.env && Object.keys(server.env).length > 0 ? { ...server.env } : undefined;
  switch (format) {
    case "json-opencode":
      return {
        type: "local",
        command: [server.command, ...server.args],
        enabled: true,
        ...(env ? { environment: env } : {}),
      };
    case "json-copilot":
      return { type: "local", command: server.command, args: server.args, tools: ["*"], ...(env ? { env } : {}) };
    case "json-vscode":
    case "json-stdio":
    case "json-crush":
      return { type: "stdio", command: server.command, args: server.args, ...(env ? { env } : {}) };
    case "json-zed":
      return { command: server.command, args: server.args, env: env ?? {} };
    case "json-transport":
      return { command: server.command, args: server.args, transport: "stdio", ...(env ? { env } : {}) };
    case "toml-array":
      return { name: SUMMER_MCP_SERVER_NAME, transport: "stdio", command: server.command, args: server.args, ...(env ? { env } : {}) };
    case "yaml-goose":
      return {
        type: "stdio",
        name: SUMMER_MCP_SERVER_NAME,
        description: "Summer Engine: scenes, scripts, play mode and diagnostics over MCP",
        cmd: server.command,
        args: server.args,
        enabled: true,
        timeout: 300,
        env_keys: [],
        envs: env ?? {},
      };
    default:
      return { command: server.command, args: server.args, ...(env ? { env } : {}) };
  }
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
  spec: AgentSpec,
  scope: ConfigScope,
  cwd: string,
  env: NodeJS.ProcessEnv
): { path: string; warnings: string[] } {
  const resolved = resolveMcpPath(spec, scope, defaultPathContext(env, cwd));
  const override = env[spec.envOverride];
  return { path: override ? resolve(override) : resolved.path, warnings: resolved.warnings };
}

/** Merge one server entry into a JSON config file under the format's top-level key. */
async function upsertJsonEntry(
  path: string,
  format: McpFormat,
  server: StdioMcpServerConfig,
  write: boolean
): Promise<{ changed: boolean }> {
  const current = await readJsonConfig(path);
  const next = copyJsonObject(current);
  const key = topLevelKey(format);

  // OpenCode's file carries its schema; Kilo shares the shape but has its own.
  if (format === "json-opencode" && typeof next.$schema !== "string" && /opencode\.json$/.test(path)) {
    next.$schema = OPENCODE_SCHEMA;
  }
  next[key] = mergeNamedObject(next[key], SUMMER_MCP_SERVER_NAME, mcpEntry(format, server), key);

  const currentRendered = renderJsonFile(current);
  const nextRendered = renderJsonFile(next);
  const changed = currentRendered !== nextRendered;

  if (write && changed) {
    await writeTextFile(path, nextRendered);
  }

  return { changed };
}

/**
 * Merge one server entry into a YAML config (Goose, Hermes). Uses the yaml
 * Document API so the user's comments and ordering survive; only the
 * summer-engine node is replaced.
 */
async function upsertYamlConfig(
  path: string,
  keyPath: string[],
  entry: JsonObject,
  write: boolean
): Promise<{ changed: boolean }> {
  const current = await readTextFileIfExists(path);
  // An empty file starts from a fresh block-style document; parseDocument("{}")
  // would make the root a flow mapping and the whole file would render as {}.
  const doc = current.trim() === "" ? new Document({}) : parseDocument(current);
  if (doc.errors.length > 0) {
    throw new Error(`Could not parse YAML in ${path}: ${doc.errors[0].message}`);
  }
  if (!isMap(doc.contents)) {
    throw new Error(`Expected ${path} to contain a YAML mapping.`);
  }
  const parent = doc.getIn(keyPath.slice(0, -1));
  if (parent !== undefined && parent !== null && !isMap(parent)) {
    throw new Error(`Existing ${keyPath[0]} value in ${path} must be a mapping.`);
  }
  doc.setIn(keyPath, doc.createNode(entry));
  const next = doc.toString();
  const changed = current !== next;

  if (write && changed) {
    await writeTextFile(path, next);
  }

  return { changed };
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

/**
 * Mistral Vibe lists servers as a TOML array of tables:
 *   [[mcp_servers]]
 *   name = "summer-engine"
 *   ...
 * Replace the block whose name is ours, else append one.
 */
async function upsertTomlArrayConfig(
  path: string,
  server: StdioMcpServerConfig,
  write: boolean
): Promise<{ changed: boolean }> {
  const current = await readTextFileIfExists(path);
  const next = upsertTomlArrayBlock(current, renderTomlArrayEntry(server));
  const changed = current !== next;
  if (write && changed) {
    await writeTextFile(path, next);
  }
  return { changed };
}

export function upsertTomlArrayBlock(content: string, block: string): string {
  const lines = content.split(/\r?\n/);
  const header = /^\s*\[\[mcp_servers\]\]\s*(?:#.*)?$/;
  const nameLine = new RegExp(`^\\s*name\\s*=\\s*"${SUMMER_MCP_SERVER_NAME}"\\s*(?:#.*)?$`);
  let start = -1;
  let end = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    if (!header.test(lines[index])) continue;
    let blockEnd = lines.length;
    for (let inner = index + 1; inner < lines.length; inner += 1) {
      if (/^\s*\[/.test(lines[inner])) {
        blockEnd = inner;
        break;
      }
    }
    if (lines.slice(index + 1, blockEnd).some((line) => nameLine.test(line))) {
      start = index;
      end = blockEnd;
      break;
    }
  }
  if (start === -1) {
    const trimmed = content.endsWith("\n") || content === "" ? content : `${content}\n`;
    return `${trimmed}${trimmed === "" ? "" : "\n"}${block}`;
  }
  const replacement = block.trimEnd().split("\n");
  if (lines[end] && lines[end].trim() !== "") replacement.push("");
  return ensureTrailingNewline([...lines.slice(0, start), ...replacement, ...lines.slice(end)].join("\n"));
}

function renderTomlArrayEntry(server: StdioMcpServerConfig): string {
  const lines = [
    "[[mcp_servers]]",
    `name = ${tomlString(SUMMER_MCP_SERVER_NAME)}`,
    `transport = "stdio"`,
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

async function readTextFileIfExists(path: string): Promise<string> {
  if (!existsSync(path)) return "";
  try {
    return await readFile(path, "utf-8");
  } catch (error) {
    throw new Error(`Could not read ${path}: ${formatError(error)}`);
  }
}

function upsertTomlTable(content: string, table: string, name: string = SUMMER_MCP_SERVER_NAME): string {
  const lines = content.split(/\r?\n/);
  const key = name.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  const serverHeader = new RegExp(`^\\s*\\[mcp_servers\\.(?:"${key}"|${key})(?:\\.|\\])`);
  const start = lines.findIndex((line) =>
    new RegExp(`^\\s*\\[mcp_servers\\.(?:"${key}"|${key})\\]\\s*(?:#.*)?$`).test(line)
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
