/**
 * The one table of agent clients `summer setup` and `summer skills install`
 * know how to write for. Every per-agent fact lives here: label, aliases,
 * where the MCP config file is (per scope and OS), which file shape it uses,
 * where skills go, and what to tell the user afterwards. agent-config.ts and
 * skill-locations.ts read this table; nothing else hard-codes an agent.
 *
 * Adding an agent = one entry here + an `integrations/<id>/` folder (a test
 * keeps the two in lockstep) + a row in the docs tables.
 *
 * Paths were checked against each product's official docs on 2026-09-11.
 */
import { join } from "path";
import { homedir, platform } from "os";
import type { Profile } from "../core/tool-profiles.js";

/** Ids `summer setup <agent>` accepts. Legacy ids stay so old commands and
 *  configs keep resolving, but they are hidden from help and warn on use. */
export const AGENT_IDS = [
  "claude-code",
  "claude-desktop",
  "codex",
  "cursor",
  "windsurf",
  "antigravity",
  "gemini",
  "cline",
  "cline-cli",
  "roo-code",
  "kilo-code",
  "github-copilot",
  "vscode-copilot",
  "visual-studio",
  "copilot-jetbrains",
  "opencode",
  "zed",
  "kiro",
  "goose",
  "hermes",
  "trae",
  "qwen-code",
  "kimi-code",
  "crush",
  "amp",
  "factory",
  "junie",
  "warp",
  "rovo-dev",
  "qoder",
  "grok-build",
  "mistral-vibe",
  "lm-studio",
] as const;

export type SupportedAgent = (typeof AGENT_IDS)[number];
export type ConfigScope = "user" | "project";

/**
 * File shapes the installer can write. One writer per shape in agent-config.ts.
 *  json          { mcpServers: { <name>: { command, args, env? } } }
 *  json-stdio    { mcpServers: { <name>: { type: "stdio", command, args, env? } } }
 *  json-vscode   { servers:    { <name>: { type: "stdio", command, args, env? } } }
 *  json-copilot  { mcpServers: { <name>: { type: "local", command, args, tools: ["*"], env? } } }
 *  json-opencode { mcp:        { <name>: { type: "local", command: [..], enabled: true, environment? } } }
 *  json-servers  { servers:    { <name>: { command, args, env? } } }               (Copilot in JetBrains)
 *  json-zed      { context_servers: { <name>: { command, args, env } } }
 *  json-amp      { "amp.mcpServers": { <name>: { command, args, env? } } }
 *  json-crush    { mcp:        { <name>: { type: "stdio", command, args, env? } } }
 *  json-transport{ mcpServers: { <name>: { command, args, transport: "stdio", env? } } } (Rovo Dev)
 *  toml          [mcp_servers.<name>] command/args/env                              (Codex, Grok Build)
 *  toml-array    [[mcp_servers]] name/transport/command/args                         (Mistral Vibe)
 *  yaml-goose    extensions: <name>: { type: stdio, name, cmd, args, enabled, timeout, envs }
 *  yaml-hermes   mcp_servers: <name>: { command, args, env? }
 *  json-gemini   the Gemini extension manifest (legacy)
 */
export type McpFormat =
  | "json"
  | "json-stdio"
  | "json-vscode"
  | "json-copilot"
  | "json-opencode"
  | "json-servers"
  | "json-zed"
  | "json-amp"
  | "json-crush"
  | "json-transport"
  | "toml"
  | "toml-array"
  | "yaml-goose"
  | "yaml-hermes"
  | "json-gemini";

export type SkillLocationKind =
  | "skill-dir"
  | "cursor-rule-dir"
  | "windsurf-rule-file"
  | "cline-rule-dir"
  | "opencode-skill-dir";

export interface PathContext {
  home: string;
  os: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export interface SkillHome {
  kind: SkillLocationKind;
  user: (ctx: PathContext) => string;
  /** null: the agent reads skills from one user-level place only. */
  project: ((ctx: PathContext) => string) | null;
  /** `summer skills install --agent <id>` without --scope uses this (default "user"). */
  defaultScope?: ConfigScope;
  /** Printed after a skills install when the agent needs a nudge to reload. */
  reloadHint?: string;
  /**
   * Where Summer versions before 3.1 wrote this agent's skills as generated
   * rule files. `skills install --force` deletes the `summer-<skill>` files it
   * finds there so the agent does not load a rule and a skill for the same slug.
   */
  legacyRules?: { user: (ctx: PathContext) => string; project: ((ctx: PathContext) => string) | null; suffix: string };
  /**
   * Skill folders Summer 3.1.0 wrote for this agent before it moved to the
   * shared agentskills.io folder (~/.agents/skills). `skills install --force`
   * removes Summer's own skill dirs there so the agent does not load the same
   * skill twice.
   */
  legacyDirs?: { user: (ctx: PathContext) => string; project: ((ctx: PathContext) => string) | null };
}

export interface AgentSpec {
  id: SupportedAgent;
  label: string;
  /** Extra spellings `summer setup` accepts (the id itself always resolves). */
  aliases: readonly string[];
  /** legacy: product retired or renamed; still writes, but warns and is hidden from help. */
  status: "active" | "legacy";
  legacyNote?: string;
  /** Env var that overrides the MCP config path (tests, unusual installs). */
  envOverride: string;
  format: McpFormat;
  /** MCP tool profile setup writes without --profile (default full: every tool). */
  mcpProfile?: Profile;
  /**
   * The Summer Games player MCP (a remote server that signs in with OAuth on
   * its own) in this agent's file, under the same key as summer-engine.
   * entry is the server's value; for TOML it is written as key = value lines.
   * signIn tells the person how to sign in once, for the entry's name.
   * Absent: setup links the engine only (no OAuth sign-in for remote servers,
   * no file entry for them, or a sign-in api.summer.games has not been checked
   * to accept).
   */
  remoteMcp?: { entry: (url: string) => Record<string, unknown>; signIn: (name: string) => string };
  mcp: {
    /** null: user-level servers are managed in the app's UI; a user request writes the project file with a warning. */
    user: ((ctx: PathContext) => string) | null;
    /** null: user-only config; a project request falls back to user with a warning. */
    project: ((ctx: PathContext) => string) | null;
    /** Extra warning printed when project scope is requested (also when it is honoured). */
    projectNote?: string;
    /** The user file the agent read before it moved: setup names an earlier summer-engine entry left there. */
    movedFrom?: (ctx: PathContext) => string;
  };
  /** What to do after the config is written. */
  restart: string;
  /** null: no skills/rules mechanism — MCP only. */
  skills: SkillHome | null;
  noSkillsNote?: string;
  /** How `summer setup --detect` tells the agent is on this computer (agent-detect.ts). */
  detect: AgentDetect;
}

/**
 * Where an agent shows up once it is installed, on macOS and Windows (Linux
 * uses the bins and folders). Any one hit counts as installed; `--detect`
 * names each hit, so a caller can tell a live binary from a leftover folder.
 */
export interface AgentDetect {
  /** Commands: looked up on PATH and in the usual install folders a GUI app's short PATH misses (agent-detect.ts). */
  bins?: readonly string[];
  /** macOS app bundles, looked up in /Applications and ~/Applications. */
  macApps?: readonly string[];
  /** Windows executables, relative to %LOCALAPPDATA%, %ProgramFiles% and %ProgramFiles(x86)%. */
  winApps?: readonly string[];
  /** Folders the agent creates on install or first run (config, data or install folder). */
  dirs?: (ctx: PathContext) => string[];
  /** VS Code extension id prefixes, looked up in ~/.vscode/extensions (folders named <id>-<version>). */
  vscodeExtensions?: readonly string[];
}

// ---- path helpers ---------------------------------------------------------

function appData(ctx: PathContext): string {
  return ctx.env.APPDATA ?? join(ctx.home, "AppData", "Roaming");
}

function xdgConfig(ctx: PathContext): string {
  // An empty XDG_CONFIG_HOME counts as unset (XDG Base Directory spec).
  return ctx.env.XDG_CONFIG_HOME || join(ctx.home, ".config");
}

/** ~/.config on Linux, %APPDATA% on Windows, ~/Library/Application Support on macOS. */
function appConfigRoot(ctx: PathContext): string {
  if (ctx.os === "win32") return appData(ctx);
  if (ctx.os === "darwin") return join(ctx.home, "Library", "Application Support");
  return xdgConfig(ctx);
}

/** XDG on Linux AND macOS (CLI tools that ignore Application Support), %APPDATA% on Windows. */
function xdgOrAppData(ctx: PathContext): string {
  return ctx.os === "win32" ? appData(ctx) : xdgConfig(ctx);
}

function vsCodeUserDir(ctx: PathContext): string {
  return join(appConfigRoot(ctx), "Code", "User");
}

function vsCodeGlobalStorage(ctx: PathContext, extensionId: string, fileName: string): string {
  return join(vsCodeUserDir(ctx), "globalStorage", extensionId, "settings", fileName);
}

const home = (...parts: string[]) => (ctx: PathContext) => join(ctx.home, ...parts);
const project = (...parts: string[]) => (ctx: PathContext) => join(ctx.cwd, ...parts);

/**
 * The agentskills.io shared folder: `~/.agents/skills` and `<project>/.agents/skills`.
 * Every agent whose docs say it reads this folder installs here, so one
 * install serves them all and "where are the skills" has one answer.
 */
const SHARED_SKILLS_USER = home(".agents", "skills");
const SHARED_SKILLS_PROJECT = project(".agents", "skills");
function sharedSkills(extra: Partial<SkillHome> = {}): SkillHome {
  return { kind: "skill-dir", user: SHARED_SKILLS_USER, project: SHARED_SKILLS_PROJECT, ...extra };
}

/** True when this location is the shared agentskills.io folder. */
export function isSharedSkillsPath(path: string): boolean {
  return /[\\/]\.agents[\\/]skills$/.test(path);
}

/** Agents that read the shared folder at the given scope (for the install summary). */
export function agentsSharingSkills(scope: ConfigScope, ctx: PathContext): AgentSpec[] {
  const shared = (scope === "user" ? SHARED_SKILLS_USER : SHARED_SKILLS_PROJECT)(ctx);
  return SPECS.filter((spec) => resolveSkillPath(spec, scope, ctx)?.path === shared);
}

/** agentskills.io layout (`<dir>/<skill>/SKILL.md`) under a user dir and a project dir. */
function skillDirs(user: (ctx: PathContext) => string, proj: ((ctx: PathContext) => string) | null, extra: Partial<SkillHome> = {}): SkillHome {
  return { kind: "skill-dir", user, project: proj, ...extra };
}

// ---- the table ------------------------------------------------------------

const SPECS: readonly AgentSpec[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    aliases: ["claude"],
    status: "active",
    envOverride: "SUMMER_CLAUDE_CONFIG_FILE",
    format: "json-stdio",
    remoteMcp: {
      entry: (url) => ({ type: "http", url }),
      signIn: (name) => `In Claude Code, run /mcp, choose ${name} and sign in.`,
    },
    mcp: { user: home(".claude.json"), project: project(".mcp.json") },
    detect: {
      // The native installer puts claude in ~/.local/bin (macOS and Windows); older npm installs in ~/.claude/local.
      bins: ["claude"],
      dirs: (ctx) => [join(ctx.home, ".claude"), join(ctx.home, ".claude.json")],
    },
    restart: "Restart Claude Code or run /mcp in a new session.",
    skills: skillDirs(home(".claude", "skills"), project(".claude", "skills")),
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    aliases: ["claude-app", "claudedesktop"],
    status: "active",
    envOverride: "SUMMER_CLAUDE_DESKTOP_CONFIG_FILE",
    format: "json",
    // No Summer Games entry: Claude Desktop's file takes local servers only; remote ones are added as Connectors in its settings.
    mcp: {
      user: (ctx) => join(appConfigRoot(ctx), "Claude", "claude_desktop_config.json"),
      project: null,
    },
    detect: {
      macApps: ["Claude.app"],
      // Squirrel install: %LOCALAPPDATA%/AnthropicClaude/claude.exe.
      winApps: [join("AnthropicClaude", "claude.exe")],
      dirs: (ctx) => [join(appConfigRoot(ctx), "Claude")],
    },
    restart: "Quit and reopen Claude Desktop; the summer-engine tools appear under the tools menu in a new chat.",
    skills: null,
    noSkillsNote:
      "Claude Desktop has no skills folder. The MCP server ships summer_docs_search and summer_docs_read, so the model can pull Summer guidance in-chat.",
  },
  {
    id: "codex",
    label: "Codex",
    aliases: ["codex-cli", "openai-codex"],
    status: "active",
    envOverride: "SUMMER_CODEX_CONFIG_FILE",
    format: "toml",
    remoteMcp: {
      entry: (url) => ({ url }),
      signIn: (name) => `In Codex, run /mcp login ${name} (or \`codex mcp login ${name}\` in a terminal) and sign in.`,
    },
    mcp: {
      // Codex reads its config from $CODEX_HOME (default ~/.codex).
      user: (ctx) => join(ctx.env.CODEX_HOME || join(ctx.home, ".codex"), "config.toml"),
      project: project(".codex", "config.toml"),
      projectNote: "Codex only loads project .codex/config.toml from trusted projects.",
    },
    detect: {
      // The codex CLI (npm or Homebrew) and the Codex desktop app share $CODEX_HOME (default ~/.codex).
      bins: ["codex"],
      macApps: ["Codex.app"],
      dirs: (ctx) => [ctx.env.CODEX_HOME || join(ctx.home, ".codex")],
    },
    restart: "Restart Codex or run /mcp in a new session.",
    skills: sharedSkills(),
  },
  {
    id: "cursor",
    label: "Cursor",
    aliases: [],
    status: "active",
    envOverride: "SUMMER_CURSOR_MCP_CONFIG_FILE",
    format: "json-stdio",
    remoteMcp: {
      entry: (url) => ({ url }),
      signIn: (name) => `In Cursor Settings, open MCP and click Connect (or Authenticate) next to ${name}.`,
    },
    mcp: { user: home(".cursor", "mcp.json"), project: project(".cursor", "mcp.json") },
    detect: {
      bins: ["cursor", "cursor-agent"],
      macApps: ["Cursor.app"],
      winApps: [join("Programs", "cursor", "Cursor.exe")],
      dirs: (ctx) => [join(ctx.home, ".cursor")],
    },
    restart: "Restart Cursor and enable the summer-engine MCP server if prompted.",
    skills: sharedSkills({
      reloadHint: "Cursor loads skills in the next chat. Summer 3.0 wrote rule files to .cursor/rules and 3.1.0 wrote .cursor/skills; `--force` removes both.",
      legacyRules: { user: home(".cursor", "rules"), project: project(".cursor", "rules"), suffix: ".mdc" },
      legacyDirs: { user: home(".cursor", "skills"), project: project(".cursor", "skills") },
    }),
  },
  {
    id: "windsurf",
    label: "Devin Desktop (formerly Windsurf)",
    aliases: ["devin", "devin-desktop", "devindesktop"],
    status: "active",
    envOverride: "SUMMER_WINDSURF_MCP_CONFIG_FILE",
    format: "json",
    remoteMcp: {
      entry: (url) => ({ serverUrl: url }),
      signIn: (name) => `Devin Desktop opens summer.games in your browser the first time ${name} connects; sign in there.`,
    },
    mcp: {
      // docs.devin.ai/desktop/cascade/mcp (2026-10-16): ~/.config/devin (or $XDG_CONFIG_HOME/devin), %APPDATA%\devin on Windows.
      user: (ctx) => join(xdgOrAppData(ctx), "devin", "mcp_config.json"),
      project: null,
      movedFrom: home(".codeium", "windsurf", "mcp_config.json"),
    },
    detect: {
      bins: ["windsurf", "devin"],
      macApps: ["Windsurf.app", "Devin.app"],
      winApps: [join("Programs", "Windsurf", "Windsurf.exe"), join("Programs", "Devin", "Devin.exe")],
      dirs: (ctx) => [join(xdgOrAppData(ctx), "devin"), join(ctx.home, ".codeium", "windsurf")],
    },
    restart: "Restart Devin Desktop (formerly Windsurf) and refresh MCP servers from the agent settings. Devin's docs say mcp_config.json configures the Cascade agent; for the Devin agent add the server in the app's MCP settings with the same command.",
    skills: sharedSkills({ legacyDirs: { user: home(".codeium", "windsurf", "skills"), project: project(".windsurf", "skills") } }),
  },
  {
    id: "antigravity",
    label: "Antigravity",
    aliases: ["agy", "google-antigravity"],
    status: "active",
    envOverride: "SUMMER_ANTIGRAVITY_CONFIG_FILE",
    format: "json",
    remoteMcp: {
      entry: (url) => ({ serverUrl: url }),
      signIn: (name) => `In Antigravity, open Settings > Customizations, choose Authenticate next to ${name}, sign in on summer.games, then paste the code back and choose Submit.`,
    },
    mcp: {
      user: home(".gemini", "config", "mcp_config.json"),
      project: project(".agents", "mcp_config.json"),
    },
    detect: {
      bins: ["antigravity", "agy"],
      macApps: ["Antigravity.app"],
      winApps: [join("Programs", "Antigravity", "Antigravity.exe")],
      dirs: (ctx) => [join(ctx.home, ".gemini", "antigravity"), join(ctx.home, ".gemini", "config")],
    },
    restart: "In Antigravity open the agent panel's MCP servers view and refresh; summer-engine appears in the list (IDE and CLI share this file).",
    skills: skillDirs(home(".gemini", "config", "skills"), project(".agents", "skills")),
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    aliases: ["gemini-cli"],
    status: "legacy",
    legacyNote:
      "Gemini CLI was retired for individual accounts on 2026-06-18 and replaced by Antigravity. Use `summer setup antigravity` unless you are on a Workspace/enterprise Gemini CLI.",
    envOverride: "SUMMER_GEMINI_CONFIG_FILE",
    format: "json-gemini",
    // No Summer Games entry: legacy target; use antigravity.
    mcp: {
      user: home(".gemini", "extensions", "summer-engine", "gemini-extension.json"),
      project: null,
    },
    detect: { bins: ["gemini"], dirs: (ctx) => [join(ctx.home, ".gemini", "extensions")] },
    restart:
      "Run `summer skills install --all --agent gemini` if skills were not installed, then restart Gemini CLI (or `gemini extensions enable summer-engine` if it is disabled).",
    skills: skillDirs(home(".gemini", "extensions", "summer-engine", "skills"), null),
  },
  {
    id: "cline",
    label: "Cline (VS Code)",
    aliases: ["cline-vscode"],
    status: "active",
    envOverride: "SUMMER_CLINE_CONFIG_FILE",
    format: "json",
    remoteMcp: {
      entry: (url) => ({ type: "streamableHttp", url }),
      signIn: (name) => `In Cline, open MCP Servers and click Authenticate next to ${name}.`,
    },
    mcp: {
      user: (ctx) => vsCodeGlobalStorage(ctx, "saoudrizwan.claude-dev", "cline_mcp_settings.json"),
      project: null,
    },
    detect: {
      // A VS Code extension: its install folder, or the storage it makes on first run.
      vscodeExtensions: ["saoudrizwan.claude-dev-"],
      dirs: (ctx) => [join(vsCodeUserDir(ctx), "globalStorage", "saoudrizwan.claude-dev")],
    },
    restart: "Restart VS Code so Cline reloads its MCP config.",
    skills: skillDirs(home(".cline", "skills"), project(".cline", "skills")),
  },
  {
    id: "cline-cli",
    label: "Cline CLI",
    aliases: ["clinecli"],
    status: "active",
    envOverride: "SUMMER_CLINE_CLI_CONFIG_FILE",
    format: "json",
    remoteMcp: {
      entry: (url) => ({ type: "streamableHttp", url }),
      signIn: (name) => `Run \`cline mcp\`, pick ${name} and choose Authorize OAuth.`,
    },
    mcp: { user: home(".cline", "data", "settings", "cline_mcp_settings.json"), project: null },
    detect: { bins: ["cline"], dirs: (ctx) => [join(ctx.home, ".cline", "data")] },
    restart: "Restart the Cline CLI so it reloads its MCP settings.",
    skills: skillDirs(home(".cline", "skills"), project(".cline", "skills")),
  },
  {
    id: "roo-code",
    label: "Roo Code",
    aliases: ["roo", "roocode"],
    status: "legacy",
    legacyNote: "Roo Code shut down on 2026-05-15. The extension may still run, but it is no longer maintained; consider Cline or Kilo Code.",
    envOverride: "SUMMER_ROO_CODE_CONFIG_FILE",
    format: "json",
    // No Summer Games entry: Roo Code has no OAuth sign-in for remote MCP servers.
    mcp: {
      user: (ctx) => vsCodeGlobalStorage(ctx, "rooveterinaryinc.roo-cline", "cline_mcp_settings.json"),
      project: null,
    },
    detect: {
      vscodeExtensions: ["rooveterinaryinc.roo-cline-"],
      dirs: (ctx) => [join(vsCodeUserDir(ctx), "globalStorage", "rooveterinaryinc.roo-cline")],
    },
    restart: "Restart VS Code so Roo Code reloads its MCP config.",
    skills: {
      kind: "cline-rule-dir",
      user: home("Documents", "Roo", "Rules"),
      project: project(".clinerules"),
      defaultScope: "project",
    },
  },
  {
    id: "kilo-code",
    label: "Kilo Code",
    aliases: ["kilo", "kilocode"],
    status: "active",
    envOverride: "SUMMER_KILO_CODE_CONFIG_FILE",
    format: "json-opencode",
    remoteMcp: {
      entry: (url) => ({ type: "remote", url }),
      signIn: (name) => `In Kilo, click the sign-in notice for ${name} (Kilo CLI: \`kilo mcp auth ${name}\`).`,
    },
    mcp: {
      user: (ctx) => join(xdgOrAppData(ctx), "kilo", "kilo.json"),
      project: project("kilo.json"),
    },
    detect: {
      // The kilo CLI, or the VS Code extension.
      bins: ["kilo", "kilocode"],
      vscodeExtensions: ["kilocode.kilo-code-"],
      dirs: (ctx) => [join(xdgOrAppData(ctx), "kilo"), join(ctx.home, ".kilo")],
    },
    restart: "Restart Kilo (CLI or the VS Code extension) so it reloads kilo.json.",
    skills: skillDirs(home(".kilo", "skills"), project(".kilo", "skills")),
  },
  {
    id: "github-copilot",
    label: "GitHub Copilot CLI",
    aliases: ["copilot", "copilot-cli", "github-copilot-cli"],
    status: "active",
    envOverride: "SUMMER_GITHUB_COPILOT_CONFIG_FILE",
    format: "json-copilot",
    remoteMcp: {
      entry: (url) => ({ type: "http", url, tools: ["*"] }),
      signIn: (name) => `Copilot CLI opens summer.games to sign in when ${name} first connects; /mcp signs in again.`,
    },
    mcp: { user: home(".copilot", "mcp-config.json"), project: project(".mcp.json") },
    detect: { bins: ["copilot"], dirs: (ctx) => [join(ctx.home, ".copilot")] },
    restart: "Restart Copilot CLI, or run /mcp reload and /skills reload in the active session.",
    skills: skillDirs(home(".copilot", "skills"), project(".github", "skills")),
  },
  {
    id: "vscode-copilot",
    label: "GitHub Copilot in VS Code",
    aliases: ["vscode", "vs-code", "vs-code-copilot", "github-copilot-vscode"],
    status: "active",
    envOverride: "SUMMER_VSCODE_COPILOT_CONFIG_FILE",
    format: "json-vscode",
    // VS Code Copilot sends at most 128 tools per request; the full surface is over that.
    mcpProfile: "engine",
    remoteMcp: {
      entry: (url) => ({ type: "http", url }),
      signIn: (name) => `In VS Code, click Allow when ${name} asks to authenticate, then sign in on summer.games.`,
    },
    mcp: { user: (ctx) => join(vsCodeUserDir(ctx), "mcp.json"), project: project(".vscode", "mcp.json") },
    detect: {
      // Copilot Chat ships with VS Code, so VS Code itself is the signal.
      bins: ["code"],
      macApps: ["Visual Studio Code.app"],
      winApps: [join("Programs", "Microsoft VS Code", "Code.exe"), join("Microsoft VS Code", "Code.exe")],
      dirs: (ctx) => [vsCodeUserDir(ctx)],
    },
    restart: "Restart VS Code or run MCP: List Servers, then start summer-engine in Copilot Agent mode.",
    skills: sharedSkills({ legacyDirs: { user: home(".copilot", "skills"), project: project(".github", "skills") } }),
  },
  {
    id: "visual-studio",
    label: "GitHub Copilot in Visual Studio",
    aliases: ["vs", "vs2026", "visual-studio-2026", "visualstudio"],
    status: "active",
    envOverride: "SUMMER_VISUAL_STUDIO_CONFIG_FILE",
    format: "json-vscode",
    // No Summer Games entry: Visual Studio's OAuth redirect for MCP is not documented; not checked against api.summer.games.
    mcp: { user: home(".mcp.json"), project: project(".mcp.json") },
    detect: {
      // Windows only (Visual Studio for Mac is retired): the install root under Program Files.
      winApps: [join("Microsoft Visual Studio", "Installer", "vswhere.exe")],
    },
    restart: "Restart Visual Studio, open Copilot Chat in Agent mode, and enable summer-engine in the tools picker.",
    skills: null,
    noSkillsNote: "Visual Studio's Copilot has no skills folder yet; the MCP server ships summer_docs_search and summer_docs_read for in-chat guidance.",
  },
  {
    id: "copilot-jetbrains",
    label: "GitHub Copilot in JetBrains IDEs",
    aliases: ["jetbrains-copilot", "intellij-copilot", "copilot-intellij"],
    status: "active",
    envOverride: "SUMMER_COPILOT_JETBRAINS_CONFIG_FILE",
    format: "json-servers",
    remoteMcp: {
      entry: (url) => ({ url }),
      signIn: (name) => `In your JetBrains IDE, click OK when ${name} asks to authenticate, then sign in on summer.games.`,
    },
    mcp: {
      user: (ctx) => join(xdgOrAppData(ctx), "github-copilot", "intellij", "mcp.json"),
      project: null,
    },
    detect: {
      // The Copilot plugin writes its settings here on first run; the IDE itself can be any JetBrains product.
      dirs: (ctx) => [join(xdgOrAppData(ctx), "github-copilot", "intellij")],
    },
    restart: "Restart the JetBrains IDE and open Copilot Chat in Agent mode; summer-engine shows in the tools list.",
    skills: null,
    noSkillsNote: "Copilot in JetBrains documents no skills folder; the MCP server ships summer_docs_search and summer_docs_read for in-chat guidance.",
  },
  {
    id: "opencode",
    label: "OpenCode",
    aliases: ["open-code"],
    status: "active",
    envOverride: "SUMMER_OPENCODE_CONFIG_FILE",
    format: "json-opencode",
    remoteMcp: {
      entry: (url) => ({ type: "remote", url }),
      signIn: (name) => `Run \`opencode mcp auth ${name}\`; it opens summer.games to sign in.`,
    },
    mcp: {
      user: (ctx) => join(xdgOrAppData(ctx), "opencode", "opencode.json"),
      project: project("opencode.json"),
    },
    detect: {
      // The install script puts opencode in ~/.opencode/bin.
      bins: ["opencode"],
      macApps: ["OpenCode.app"],
      dirs: (ctx) => [join(xdgOrAppData(ctx), "opencode"), join(ctx.home, ".opencode")],
    },
    restart: "Restart OpenCode so it reloads opencode.json.",
    skills: sharedSkills({
      reloadHint: "OpenCode loads skills from this folder on the next session. Summer 3.0 wrote markdown under agents/summer and 3.1.0 wrote opencode/skills; `--force` removes both.",
      legacyRules: { user: (ctx) => join(xdgOrAppData(ctx), "opencode", "agents", "summer"), project: project(".opencode", "agents", "summer"), suffix: ".md" },
      legacyDirs: { user: (ctx) => join(xdgOrAppData(ctx), "opencode", "skills"), project: project(".opencode", "skills") },
    }),
  },
  {
    id: "zed",
    label: "Zed",
    aliases: ["zed-editor"],
    status: "active",
    envOverride: "SUMMER_ZED_CONFIG_FILE",
    format: "json-zed",
    remoteMcp: {
      entry: (url) => ({ url }),
      signIn: (name) => `In Zed, open the agent settings and click Authenticate next to ${name}.`,
    },
    mcp: {
      user: (ctx) => join(xdgOrAppData(ctx), "zed", "settings.json"),
      project: null,
    },
    detect: {
      bins: ["zed"],
      macApps: ["Zed.app", "Zed Preview.app"],
      winApps: [join("Programs", "Zed", "Zed.exe")],
      dirs: (ctx) => [join(xdgOrAppData(ctx), "zed")],
    },
    restart: "Zed reloads settings.json live; open the Agent panel and check summer-engine under MCP servers.",
    skills: sharedSkills(),
  },
  {
    id: "kiro",
    label: "Kiro",
    aliases: ["kiro-ide", "aws-kiro"],
    status: "active",
    envOverride: "SUMMER_KIRO_CONFIG_FILE",
    format: "json",
    remoteMcp: {
      entry: (url) => ({ url }),
      signIn: (name) => `Kiro opens summer.games to sign in when ${name} connects (Kiro CLI: /mcp auth).`,
    },
    mcp: { user: home(".kiro", "settings", "mcp.json"), project: project(".kiro", "settings", "mcp.json") },
    detect: {
      bins: ["kiro", "kiro-cli"],
      macApps: ["Kiro.app"],
      winApps: [join("Programs", "Kiro", "Kiro.exe")],
      dirs: (ctx) => [join(ctx.home, ".kiro")],
    },
    restart: "Kiro reloads MCP config on save; open the MCP Servers view to confirm summer-engine is connected.",
    skills: skillDirs(home(".kiro", "skills"), project(".kiro", "skills")),
  },
  {
    id: "goose",
    label: "Goose",
    aliases: ["block-goose", "codename-goose"],
    status: "active",
    envOverride: "SUMMER_GOOSE_CONFIG_FILE",
    format: "yaml-goose",
    remoteMcp: {
      entry: (url) => ({
        type: "streamable_http",
        name: "summer-games",
        description: "Summer Games: friends, parties and messages as you",
        uri: url,
        enabled: true,
        timeout: 300,
        env_keys: [],
        envs: {},
      }),
      signIn: (name) => `Goose opens summer.games to sign in when the ${name} extension starts.`,
    },
    mcp: {
      user: (ctx) =>
        ctx.os === "win32"
          ? join(appData(ctx), "Block", "goose", "config", "config.yaml")
          : join(xdgConfig(ctx), "goose", "config.yaml"),
      project: null,
    },
    detect: {
      bins: ["goose"],
      macApps: ["Goose.app"],
      winApps: [join("Programs", "Goose", "Goose.exe")],
      dirs: (ctx) => [ctx.os === "win32" ? join(appData(ctx), "Block", "goose") : join(xdgConfig(ctx), "goose")],
    },
    restart: "Restart Goose (CLI or Desktop); summer-engine is listed under Extensions.",
    skills: skillDirs((ctx) => join(xdgConfig(ctx), "agents", "skills"), project(".agents", "skills")),
  },
  {
    id: "hermes",
    label: "Hermes Agent",
    aliases: ["hermes-agent", "nous-hermes"],
    status: "active",
    envOverride: "SUMMER_HERMES_CONFIG_FILE",
    format: "yaml-hermes",
    remoteMcp: {
      entry: (url) => ({ url, auth: "oauth" }),
      signIn: (name) => `Run \`hermes mcp login ${name}\`, or sign in on summer.games when Hermes first connects.`,
    },
    mcp: { user: home(".hermes", "config.yaml"), project: null },
    detect: { bins: ["hermes"], dirs: (ctx) => [join(ctx.home, ".hermes")] },
    restart: "Run /reload-mcp in Hermes Agent (or restart it).",
    skills: skillDirs(home(".hermes", "skills"), SHARED_SKILLS_PROJECT, {
      reloadHint: "Project skills need `hermes skills trust` before Hermes loads them.",
      legacyDirs: { user: home(".hermes", "skills"), project: project(".hermes", "skills") },
    }),
  },
  {
    id: "trae",
    label: "Trae",
    aliases: ["trae-ide", "bytedance-trae"],
    status: "active",
    envOverride: "SUMMER_TRAE_CONFIG_FILE",
    format: "json",
    remoteMcp: {
      entry: (url) => ({ url }),
      signIn: (name) => `Trae opens summer.games to sign in when ${name} connects.`,
    },
    mcp: {
      user: null,
      project: project(".trae", "mcp.json"),
      projectNote: "Trae manages user-level MCP servers in its UI; writing the project file .trae/mcp.json instead.",
    },
    detect: {
      bins: ["trae"],
      macApps: ["Trae.app"],
      winApps: [join("Programs", "Trae", "Trae.exe")],
      dirs: (ctx) => [join(appConfigRoot(ctx), "Trae"), join(ctx.home, ".trae")],
    },
    restart: "Restart Trae and open the MCP settings; summer-engine should show as connected.",
    skills: null,
    noSkillsNote: "Trae documents no skills folder; the MCP server ships summer_docs_search and summer_docs_read for in-chat guidance.",
  },
  {
    id: "qwen-code",
    label: "Qwen Code",
    aliases: ["qwen", "qwencode"],
    status: "active",
    envOverride: "SUMMER_QWEN_CODE_CONFIG_FILE",
    format: "json",
    remoteMcp: {
      entry: (url) => ({ httpUrl: url }),
      signIn: (name) => `In Qwen Code, run /mcp auth ${name} and sign in.`,
    },
    mcp: { user: home(".qwen", "settings.json"), project: project(".qwen", "settings.json") },
    detect: { bins: ["qwen"], dirs: (ctx) => [join(ctx.home, ".qwen")] },
    restart: "Restart Qwen Code or run /mcp in a new session.",
    skills: skillDirs(home(".qwen", "skills"), project(".qwen", "skills")),
  },
  {
    id: "kimi-code",
    label: "Kimi Code CLI",
    aliases: ["kimi", "kimi-cli", "kimicode"],
    status: "active",
    envOverride: "SUMMER_KIMI_CODE_CONFIG_FILE",
    format: "json",
    remoteMcp: {
      entry: (url) => ({ url, auth: "oauth" }),
      signIn: (name) => `Run \`kimi mcp auth ${name}\`; it opens summer.games to sign in.`,
    },
    mcp: { user: home(".kimi-code", "mcp.json"), project: project(".kimi-code", "mcp.json") },
    detect: { bins: ["kimi"], dirs: (ctx) => [join(ctx.home, ".kimi-code"), join(ctx.home, ".kimi")] },
    restart: "Restart Kimi Code CLI so it reconnects its MCP servers.",
    skills: sharedSkills({ legacyDirs: { user: home(".kimi-code", "skills"), project: project(".kimi-code", "skills") } }),
  },
  {
    id: "crush",
    label: "Crush",
    aliases: ["charm-crush"],
    status: "active",
    envOverride: "SUMMER_CRUSH_CONFIG_FILE",
    format: "json-crush",
    remoteMcp: {
      entry: (url) => ({ type: "http", url, oauth: true }),
      signIn: (name) => `Crush opens summer.games to sign in when ${name} connects.`,
    },
    mcp: {
      user: home(".config", "crush", "crushrc"),
      project: project(".crushrc"),
    },
    detect: { bins: ["crush"], dirs: (ctx) => [join(ctx.home, ".config", "crush"), join(ctx.home, ".local", "share", "crush")] },
    restart: "Restart Crush so it reloads crushrc.",
    skills: sharedSkills({ legacyDirs: { user: home(".config", "crush", "skills"), project: project(".crush", "skills") } }),
  },
  {
    id: "amp",
    label: "Amp",
    aliases: ["sourcegraph-amp", "ampcode"],
    status: "active",
    envOverride: "SUMMER_AMP_CONFIG_FILE",
    format: "json-amp",
    remoteMcp: {
      entry: (url) => ({ url }),
      signIn: (name) => `Amp opens summer.games to sign in for ${name} when it starts.`,
    },
    mcp: { user: (ctx) => join(xdgOrAppData(ctx), "amp", "settings.json"), project: null },
    detect: { bins: ["amp"], dirs: (ctx) => [join(xdgOrAppData(ctx), "amp")] },
    restart: "Restart Amp so it reloads settings.json.",
    skills: sharedSkills({ legacyDirs: { user: (ctx) => join(xdgOrAppData(ctx), "amp", "skills"), project: null } }),
  },
  {
    id: "factory",
    label: "Factory Droid",
    aliases: ["droid", "factory-droid"],
    status: "active",
    envOverride: "SUMMER_FACTORY_CONFIG_FILE",
    format: "json-stdio",
    remoteMcp: {
      entry: (url) => ({ type: "http", url }),
      signIn: (name) => `In Droid, run /mcp, choose ${name} and Authenticate.`,
    },
    mcp: { user: home(".factory", "mcp.json"), project: project(".factory", "mcp.json") },
    detect: { bins: ["droid"], dirs: (ctx) => [join(ctx.home, ".factory")] },
    restart: "Restart droid or run /mcp in the active session.",
    skills: sharedSkills({ legacyDirs: { user: home(".factory", "skills"), project: project(".factory", "skills") } }),
  },
  {
    id: "junie",
    label: "Junie",
    aliases: ["jetbrains-junie"],
    status: "active",
    envOverride: "SUMMER_JUNIE_CONFIG_FILE",
    format: "json",
    remoteMcp: {
      entry: (url) => ({ url }),
      signIn: (name) => `In Junie, run /mcp, open ${name} and choose Authorize.`,
    },
    mcp: { user: home(".junie", "mcp", "mcp.json"), project: project(".junie", "mcp", "mcp.json") },
    detect: { bins: ["junie"], dirs: (ctx) => [join(ctx.home, ".junie")] },
    restart: "Restart the JetBrains IDE so Junie reloads its MCP config.",
    skills: null,
    noSkillsNote: "Junie has no skills folder; put project guidance in .junie/guidelines.md. The MCP server ships summer_docs_search and summer_docs_read for in-chat guidance.",
  },
  {
    id: "warp",
    label: "Warp",
    aliases: ["warp-terminal"],
    status: "active",
    envOverride: "SUMMER_WARP_CONFIG_FILE",
    format: "json",
    remoteMcp: {
      entry: (url) => ({ url }),
      signIn: (name) => `Warp opens summer.games to sign in when ${name} starts.`,
    },
    mcp: { user: home(".warp", ".mcp.json"), project: project(".warp", ".mcp.json") },
    detect: {
      macApps: ["Warp.app"],
      winApps: [join("Programs", "Warp", "warp.exe")],
      dirs: (ctx) => [join(ctx.home, ".warp")],
    },
    restart: "Warp detects the file and spawns the server; check Settings > AI > MCP servers.",
    skills: sharedSkills({ legacyDirs: { user: home(".warp", "skills"), project: project(".warp", "skills") } }),
  },
  {
    id: "rovo-dev",
    label: "Rovo Dev CLI",
    aliases: ["rovodev", "rovo", "atlassian-rovo-dev"],
    status: "active",
    envOverride: "SUMMER_ROVO_DEV_CONFIG_FILE",
    format: "json-transport",
    // No Summer Games entry: Rovo Dev CLI has no OAuth sign-in for remote MCP servers (headers only).
    mcp: { user: home(".rovodev", "mcp.json"), project: null },
    detect: {
      // Rovo Dev runs as `acli rovodev`; acli alone is the Atlassian CLI, so the ~/.rovodev folder is the firmer signal.
      bins: ["acli"],
      dirs: (ctx) => [join(ctx.home, ".rovodev")],
    },
    restart: "Restart Rovo Dev CLI so it reconnects its MCP servers.",
    skills: sharedSkills({ legacyDirs: { user: home(".rovodev", "skills"), project: project(".rovodev", "skills") } }),
  },
  {
    id: "qoder",
    label: "Qoder CLI",
    aliases: ["qoder-cli"],
    status: "active",
    envOverride: "SUMMER_QODER_CONFIG_FILE",
    format: "json",
    // No Summer Games entry: Qoder's remote-server fields in settings.json are not documented.
    mcp: { user: home(".qoder", "settings.json"), project: project(".mcp.json") },
    detect: {
      bins: ["qodercli"],
      macApps: ["Qoder.app"],
      winApps: [join("Programs", "Qoder", "Qoder.exe")],
      dirs: (ctx) => [join(ctx.home, ".qoder")],
    },
    restart: "Restart Qoder CLI so it reloads its MCP settings (the Qoder IDE manages servers in its UI).",
    skills: skillDirs(home(".qoder", "skills"), project(".qoder", "skills")),
  },
  {
    id: "grok-build",
    label: "Grok Build",
    aliases: ["grok", "xai-grok"],
    status: "active",
    envOverride: "SUMMER_GROK_BUILD_CONFIG_FILE",
    format: "toml",
    remoteMcp: {
      entry: (url) => ({ url }),
      signIn: (name) => `In Grok Build, run /mcps, select ${name} and press i to sign in.`,
    },
    mcp: { user: home(".grok", "config.toml"), project: project(".grok", "config.toml") },
    detect: { bins: ["grok"], dirs: (ctx) => [join(ctx.home, ".grok")] },
    restart: "Restart Grok Build so it reloads config.toml (it also reads ~/.claude.json and .cursor/mcp.json).",
    skills: sharedSkills({ legacyDirs: { user: home(".grok", "skills"), project: project(".grok", "skills") } }),
  },
  {
    id: "mistral-vibe",
    label: "Mistral Vibe",
    aliases: ["vibe", "mistral"],
    status: "active",
    envOverride: "SUMMER_MISTRAL_VIBE_CONFIG_FILE",
    format: "toml-array",
    remoteMcp: {
      entry: (url) => ({ name: "summer-games", transport: "streamable-http", url, auth: { type: "oauth", scopes: [] } }),
      signIn: (name) => `In Vibe, run /mcp login ${name}.`,
    },
    mcp: { user: home(".vibe", "config.toml"), project: project(".vibe", "config.toml") },
    detect: { bins: ["vibe"], dirs: (ctx) => [join(ctx.home, ".vibe")] },
    restart: "Restart Vibe so it reloads config.toml.",
    skills: skillDirs(home(".vibe", "skills"), SHARED_SKILLS_PROJECT, { legacyDirs: { user: home(".vibe", "skills"), project: project(".vibe", "skills") } }),
  },
  {
    id: "lm-studio",
    label: "LM Studio",
    aliases: ["lmstudio", "lm_studio"],
    status: "active",
    envOverride: "SUMMER_LM_STUDIO_CONFIG_FILE",
    format: "json",
    // No Summer Games entry: LM Studio's MCP client registration is closed and unverified.
    mcp: { user: home(".lmstudio", "mcp.json"), project: null },
    detect: {
      // The app installs the lms command into ~/.lmstudio/bin.
      bins: ["lms"],
      macApps: ["LM Studio.app"],
      winApps: [join("Programs", "LM Studio", "LM Studio.exe"), join("Programs", "lm-studio", "LM Studio.exe")],
      dirs: (ctx) => [join(ctx.home, ".lmstudio")],
    },
    restart:
      "Open LM Studio, toggle on the summer-engine MCP server in the Program tab, and raise the loaded model's context length to 32k or higher.",
    skills: null,
    noSkillsNote:
      "LM Studio has no rules or skills folder. The MCP server ships summer_docs_search and summer_docs_read, so the model can pull Summer guidance in-chat.",
  },
];

const BY_ID = new Map<string, AgentSpec>(SPECS.map((spec) => [spec.id, spec]));

export function agentSpec(id: SupportedAgent): AgentSpec {
  const spec = BY_ID.get(id);
  if (!spec) throw new Error(`Unknown agent: ${id}`);
  return spec;
}

export function allAgentSpecs(): readonly AgentSpec[] {
  return SPECS;
}

/** Ids shown in help and error messages (legacy ids still parse). */
export const supportedAgents: readonly SupportedAgent[] = SPECS.filter((s) => s.status === "active").map((s) => s.id);

/** Ids with a skills/rules home; `AGENT_CLIENTS` in core mirrors this plus "summer". */
export const skillCapableAgents: readonly SupportedAgent[] = SPECS.filter((s) => s.skills !== null).map((s) => s.id);

/** Every spelling → canonical id. Aliases must be unique across the table. */
export function agentAliasMap(): Record<string, SupportedAgent> {
  const map: Record<string, SupportedAgent> = {};
  for (const spec of SPECS) {
    for (const key of [spec.id, ...spec.aliases]) {
      if (map[key] && map[key] !== spec.id) {
        throw new Error(`Agent alias "${key}" is claimed by both ${map[key]} and ${spec.id}`);
      }
      map[key] = spec.id;
    }
  }
  return map;
}

/**
 * Why `summer setup <agent> --cli` cannot set this agent up, or null. --cli
 * installs the skills and no MCP server, so the agent needs a skills folder,
 * and one that takes SKILL.md files: rule files (Roo Code) and the Gemini
 * extension assume the MCP tools.
 */
export function cliSetupRefusal(spec: AgentSpec): string | null {
  if (!spec.skills) {
    return `${spec.label} has no skills folder, so --cli has nothing to install. Run summer setup ${spec.id} without --cli for the MCP server.`;
  }
  if (spec.format === "json-gemini") {
    return `Gemini CLI loads Summer's skills only through its extension, which runs the MCP server. Run summer setup ${spec.id} without --cli, or use antigravity.`;
  }
  if (spec.skills.kind !== "skill-dir" && spec.skills.kind !== "opencode-skill-dir") {
    return `${spec.label} gets Summer's skills as rule files that tell it to use the MCP tools. Run summer setup ${spec.id} without --cli.`;
  }
  return null;
}

export function agentLabel(id: SupportedAgent): string {
  return agentSpec(id).label;
}

export function defaultPathContext(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): PathContext {
  return { home: homedir(), os: platform(), env, cwd };
}

export interface ResolvedMcpPath {
  path: string;
  /** The scope actually written (project requests fall back to user when the agent has no project config). */
  scope: ConfigScope;
  warnings: string[];
}

/** Where the MCP config goes for an agent and requested scope, with the warnings to show. */
export function resolveMcpPath(spec: AgentSpec, scope: ConfigScope, ctx: PathContext): ResolvedMcpPath {
  const warnings: string[] = [];
  if (spec.status === "legacy" && spec.legacyNote) warnings.push(spec.legacyNote);
  if (scope === "project" || spec.mcp.user === null) {
    if (spec.mcp.project) {
      if (spec.mcp.projectNote && (scope === "project" || spec.mcp.user === null)) warnings.push(spec.mcp.projectNote);
      return { path: spec.mcp.project(ctx), scope: "project", warnings };
    }
    warnings.push(
      spec.mcp.projectNote ??
        `${spec.label} reads MCP config from one user-level file only; writing user scope instead.`
    );
  }
  if (spec.mcp.user === null) throw new Error(`${spec.label} has neither a user nor a project MCP config path.`);
  return { path: spec.mcp.user(ctx), scope: "user", warnings };
}

/** Rule files a pre-3.1 Summer wrote for this agent at this scope; `null` when the agent never had any. */
export function legacyRuleFiles(spec: AgentSpec, scope: ConfigScope, ctx: PathContext, skillNames: Iterable<string>): string[] | null {
  const legacy = spec.skills?.legacyRules;
  if (!legacy) return null;
  const dir = scope === "project" && legacy.project ? legacy.project(ctx) : legacy.user(ctx);
  const prefix = spec.id === "opencode" ? "" : "summer-";
  return [...skillNames].map((name) => join(dir, `${prefix}${name}${legacy.suffix}`));
}

/** Skill dirs a Summer 3.1.0 install may have written at this agent's old native location; `null` when it never moved. */
export function legacySkillDirs(spec: AgentSpec, scope: ConfigScope, ctx: PathContext, skillNames: Iterable<string>): string[] | null {
  const legacy = spec.skills?.legacyDirs;
  if (!legacy) return null;
  const dir = scope === "project" ? (legacy.project ? legacy.project(ctx) : null) : legacy.user(ctx);
  if (!dir) return [];
  const current = resolveSkillPath(spec, scope, ctx)?.path;
  if (current === dir) return [];
  return [...skillNames].map((name) => join(dir, name));
}

export interface ResolvedSkillPath {
  kind: SkillLocationKind;
  path: string;
  scope: ConfigScope;
}

/** Where skills go for an agent with a skills home. */
export function resolveSkillPath(spec: AgentSpec, scope: ConfigScope, ctx: PathContext): ResolvedSkillPath | null {
  if (!spec.skills) return null;
  if (scope === "project" && spec.skills.project) {
    return { kind: spec.skills.kind, path: spec.skills.project(ctx), scope };
  }
  return { kind: spec.skills.kind, path: spec.skills.user(ctx), scope: "user" };
}
