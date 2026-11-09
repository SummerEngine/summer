import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync, type Stats } from "fs";
import { copyFile, mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { Document, isMap, parseDocument } from "yaml";
import { PACKAGE_ROOT } from "../core/package-root.js";
import { SetupError } from "./setup-error.js";
import type { Profile } from "../core/tool-profiles.js";
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
  /** npm dist-tag or exact version the generated MCP entry runs (`npx -y summer-engine@<channel> mcp`).
   *  Default "latest"; "next" while a release soaks on the next tag. Ignored with localDev. */
  channel?: string;
  /** MCP tool profile written as SUMMER_PROFILE; default the agent's own (full for most). */
  profile?: Profile;
  /** A bundled Node runtime and summer-engine package (the Summer desktop installer):
   *  the entry runs `<node> <packageDir>/dist/bin/summer.js mcp` instead of npx.
   *  Check it with resolveBundledRuntime first. Ignores localDev and channel. */
  runtime?: BundledRuntime;
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
  /** The dist-tag or exact version the written entry runs ("latest" unless --channel /
   *  SUMMER_CHANNEL, or a CLI ahead of npm latest: see resolveDefaultChannel). */
  channel: string;
  /** The MCP tool profile the entry runs (full = every tool, no SUMMER_PROFILE written). */
  profile: Profile;
  /** Set when the entry runs a bundled Node runtime (--runtime, --package-dir). */
  runtime: BundledRuntime | null;
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

  const name = agentOpt ?? agentArg;
  const parsed = parseAgent(name);
  if (!parsed) {
    throw new Error(
      name
        ? `Unknown agent "${name}". Supported: ${supportedAgents.join(", ")}`
        : `Specify an agent: ${supportedAgents.join(", ")}`
    );
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
  const spec = agentSpec(options.agent);
  const profile = options.profile ?? spec.mcpProfile ?? "full";
  const runtime = options.runtime ?? null;
  const server = withProfile(
    runtime ? bundledRuntimeServerConfig(runtime) : createSummerMcpServerConfig(Boolean(options.localDev), process.platform, channel),
    profile
  );
  const target = resolveConfigTarget(spec, options.scope, cwd, env);
  // An entry an earlier setup wrote where the agent no longer reads (Devin Desktop moved from ~/.codeium/windsurf).
  const moved = spec.mcp.movedFrom ? spec.mcp.movedFrom(defaultPathContext(env, cwd)) : null;
  if (moved && moved !== target.path && (await readTextFileIfExists(moved)).includes(`"${SUMMER_MCP_SERVER_NAME}"`)) {
    target.warnings.push(`${moved} still lists ${SUMMER_MCP_SERVER_NAME} from an earlier setup. ${spec.label} now reads ${target.path}, so setup writes it there; the old entry stays for older builds.`);
  }
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
    localDev: !runtime && Boolean(options.localDev),
    channel,
    profile,
    runtime,
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
 * Adds the Summer Games MCP next to summer-engine in the same config file, in
 * the agent's own entry shape (remoteMcp in agent-table.ts). An entry that
 * already points at the same URL, under any name, counts as added and is left
 * as it is. Returns null for agents without remoteMcp.
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
  const name = SUMMER_GAMES_MCP_SERVER_NAME;
  const entry = spec.remoteMcp.entry(url) as JsonObject;
  const key = topLevelKey(spec.format);

  let existing: string | undefined;
  let changed = false;
  switch (spec.format) {
    case "toml":
    case "toml-array": {
      const current = await readTextFileIfExists(target.path);
      existing = spec.format === "toml" ? findTomlServerByUrl(current, url) : findTomlArrayServerByUrl(current, url);
      if (existing) break;
      const next =
        spec.format === "toml"
          ? upsertTomlTable(current, renderTomlTable(`[mcp_servers.${name}]`, entry), name)
          : upsertTomlArrayBlock(current, renderTomlTable("[[mcp_servers]]", entry), name);
      changed = current !== next;
      if (write && changed) await writeTextFile(target.path, next);
      break;
    }
    case "yaml-goose":
    case "yaml-hermes": {
      const current = await readTextFileIfExists(target.path);
      const parsed = current.trim() === "" ? {} : (parseDocument(current).toJS() as unknown);
      existing = isJsonObject(parsed) ? findServerByUrl([parsed[key]], url) : undefined;
      if (existing) break;
      ({ changed } = await upsertYamlConfig(target.path, [key, name], entry, write));
      break;
    }
    case "json-gemini":
      throw new Error("The Gemini extension manifest has no Summer Games entry.");
    default: {
      const current = await readJsonConfig(target.path);
      const maps: unknown[] = [current[key]];
      // Claude Code's ~/.claude.json also keeps per-project servers (`claude
      // mcp add` without --scope user) under projects.<dir>.mcpServers.
      if (isJsonObject(current.projects)) {
        for (const project of Object.values(current.projects)) {
          if (isJsonObject(project)) maps.push(project.mcpServers);
        }
      }
      existing = findServerByUrl(maps, url);
      if (existing) break;
      const next = copyJsonObject(current);
      next[key] = mergeNamedObject(next[key], name, entry, key);
      const nextRendered = renderJsonFile(next);
      changed = renderJsonFile(current) !== nextRendered;
      if (write && changed) await writeTextFile(target.path, nextRendered);
    }
  }

  const serverName = existing ?? name;
  return {
    serverName,
    url,
    path: target.path,
    changed,
    wrote: write && changed,
    ...(existing && existing !== name ? { existingName: existing } : {}),
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

/** Agents name a remote server's address url, serverUrl (Windsurf,
 *  Antigravity), httpUrl (Qwen Code) or uri (Goose). */
const REMOTE_URL_FIELDS = ["url", "serverUrl", "httpUrl", "uri"];

/** The name of a server with this URL in any of these name -> entry maps. */
function findServerByUrl(maps: unknown[], url: string): string | undefined {
  for (const map of maps) {
    if (!isJsonObject(map)) continue;
    for (const [name, entry] of Object.entries(map)) {
      if (isJsonObject(entry) && REMOTE_URL_FIELDS.some((field) => sameMcpUrl(entry[field], url))) return name;
    }
  }
  return undefined;
}

/** The name of a [[mcp_servers]] block (Mistral Vibe) whose url is this URL. */
function findTomlArrayServerByUrl(content: string, url: string): string | undefined {
  let block: { name?: string; matches: boolean } | undefined;
  const done = () => (block?.matches ? block.name : undefined);
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      if (done()) return done();
      block = /^\s*\[\[mcp_servers\]\]\s*(?:#.*)?$/.test(line) ? { matches: false } : undefined;
      continue;
    }
    if (!block) continue;
    const field = /^\s*(name|url)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(line);
    if (!field) continue;
    const value = field[2] ?? field[3];
    if (field[1] === "name") block.name = value;
    else if (sameMcpUrl(value, url)) block.matches = true;
  }
  return done();
}

/** A TOML table: the header line, then key = value for each entry field. */
function renderTomlTable(header: string, entry: JsonObject): string {
  return `${[header, ...Object.entries(entry).map(([field, value]) => `${field} = ${tomlValue(value)}`)].join("\n")}\n`;
}

function tomlValue(value: unknown): string {
  if (typeof value === "string") return tomlString(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (isJsonObject(value)) {
    const fields = Object.entries(value).map(([field, inner]) => `${field} = ${tomlValue(inner)}`);
    return fields.length === 0 ? "{}" : `{ ${fields.join(", ")} }`;
  }
  throw new Error(`Cannot write ${JSON.stringify(value)} as TOML.`);
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
 *  an exact version (`3.9.1`, `3.9.1-rc.1`) pins the entry to that release, which
 *  setup does for a CLI that is ahead of npm latest. Anything else, partial
 *  versions and paths included, is refused. */
export function normalizeChannel(channel: string | undefined): string {
  const value = (channel ?? "").trim();
  if (value === "") return DEFAULT_CHANNEL;
  if (/^\d+\.\d+\.\d+(?:-[0-9a-z][0-9a-z.-]*)?$/.test(value)) return value;
  if (!/^[a-z][a-z0-9-]*$/.test(value) || /^v?\d/.test(value)) {
    throw new Error(
      `Invalid channel "${channel}": use an npm dist-tag such as latest or next (lowercase letters, digits, hyphens), or an exact version such as 4.0.0.`
    );
  }
  return value;
}

/**
 * The profile rides in the entry's env, not its args: an older summer-engine
 * that an agent still runs ignores the variable and serves every tool, where
 * an unknown --profile flag would stop it from starting.
 */
export function withProfile(server: StdioMcpServerConfig, profile: Profile): StdioMcpServerConfig {
  return profile === "full" ? server : { ...server, env: { ...server.env, SUMMER_PROFILE: profile } };
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

/**
 * A Node runtime and a summer-engine package shipped next to each other (the
 * Summer desktop installer bundles both, so the person needs no Node.js of
 * their own). Both are absolute paths.
 */
export interface BundledRuntime {
  /** The node executable (node, or node.exe on Windows). */
  node: string;
  /** The summer-engine package folder: the one with package.json and dist/bin/summer.js. */
  packageDir: string;
}

/** The CLI entry point inside a summer-engine package folder. */
export function bundledCliPath(packageDir: string): string {
  return join(packageDir, "dist", "bin", "summer.js");
}

/**
 * --runtime <node> and --package-dir <dir>: both or neither, and both must
 * exist. The runtime must be an executable file (any file on Windows); the
 * package folder must hold summer-engine's package.json and its built CLI.
 * Returns absolute paths, so the agent's entry works from any folder.
 */
export function resolveBundledRuntime(node: string | undefined, packageDir: string | undefined, cwd: string = process.cwd()): BundledRuntime | null {
  if (node === undefined && packageDir === undefined) return null;
  if (!node || !packageDir) {
    throw new SetupError("runtime_incomplete", "--runtime and --package-dir go together: name the node executable and the summer-engine package folder.");
  }
  const nodePath = resolve(cwd, node);
  const nodeStat = statIfExists(nodePath);
  if (!nodeStat) throw new SetupError("runtime_not_found", `--runtime ${nodePath} does not exist.`);
  if (!nodeStat.isFile()) throw new SetupError("runtime_not_found", `--runtime ${nodePath} is not a file. Name the node executable itself.`);
  if (process.platform !== "win32") {
    try {
      accessSync(nodePath, fsConstants.X_OK);
    } catch {
      throw new SetupError("runtime_not_executable", `--runtime ${nodePath} is not executable.`);
    }
  }
  const dir = resolve(cwd, packageDir);
  if (!statIfExists(dir)?.isDirectory()) throw new SetupError("package_dir_not_found", `--package-dir ${dir} is not a folder.`);
  let name: unknown;
  try {
    name = (JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as { name?: unknown }).name;
  } catch {
    name = undefined;
  }
  if (name !== "summer-engine") {
    throw new SetupError("package_dir_invalid", `--package-dir ${dir} is not the summer-engine package: it has no package.json named summer-engine.`);
  }
  if (!statIfExists(bundledCliPath(dir))?.isFile()) {
    throw new SetupError("package_dir_invalid", `--package-dir ${dir} has no built CLI at dist/bin/summer.js.`);
  }
  return { node: nodePath, packageDir: dir };
}

/** The entry for a bundled runtime: `<node> <packageDir>/dist/bin/summer.js mcp`.
 *  node is a real executable, so no cmd.exe wrapper is needed on Windows. */
export function bundledRuntimeServerConfig(runtime: BundledRuntime): StdioMcpServerConfig {
  return { command: runtime.node, args: [bundledCliPath(runtime.packageDir), "mcp"] };
}

function statIfExists(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
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
    throw new SetupError("config_invalid", `Could not parse YAML in ${path}: ${doc.errors[0].message}`);
  }
  if (!isMap(doc.contents)) {
    throw new SetupError("config_invalid", `Expected ${path} to contain a YAML mapping.`);
  }
  const parent = doc.getIn(keyPath.slice(0, -1));
  if (parent !== undefined && parent !== null && !isMap(parent)) {
    throw new SetupError("config_invalid", `Existing ${keyPath[0]} value in ${path} must be a mapping.`);
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
    throw new SetupError("config_unreadable", `Could not read ${path}: ${formatError(error)}`);
  }

  if (content.trim() === "") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new SetupError("config_invalid", `Could not parse JSON in ${path}: ${formatError(error)}`);
  }

  if (!isJsonObject(parsed)) {
    throw new SetupError("config_invalid", `Expected ${path} to contain a JSON object.`);
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

export function upsertTomlArrayBlock(content: string, block: string, name: string = SUMMER_MCP_SERVER_NAME): string {
  const lines = content.split(/\r?\n/);
  const header = /^\s*\[\[mcp_servers\]\]\s*(?:#.*)?$/;
  const nameLine = new RegExp(`^\\s*name\\s*=\\s*"${name}"\\s*(?:#.*)?$`);
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
    throw new SetupError("config_unreadable", `Could not read ${path}: ${formatError(error)}`);
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
    throw new SetupError("config_invalid", `Existing ${label} value must be a JSON object.`);
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
