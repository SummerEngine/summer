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

export type RemoteMcpFormat = "json-http" | "json-url" | "toml-url";

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
  /**
   * How this agent lists a remote MCP server that signs in with OAuth on its
   * own (the Summer Games player MCP). Absent: setup links the engine only.
   *  json-http { mcpServers: { <name>: { type: "http", url } } }   (Claude Code)
   *  json-url  { mcpServers: { <name>: { url } } }                 (Cursor)
   *  toml-url  [mcp_servers.<name>] url                            (Codex)
   */
  remoteMcp?: { format: RemoteMcpFormat; signIn: string };
  mcp: {
    /** null: user-level servers are managed in the app's UI; a user request writes the project file with a warning. */
    user: ((ctx: PathContext) => string) | null;
    /** null: user-only config; a project request falls back to user with a warning. */
    project: ((ctx: PathContext) => string) | null;
    /** Extra warning printed when project scope is requested (also when it is honoured). */
    projectNote?: string;
  };
  /** What to do after the config is written. */
  restart: string;
  /** null: no skills/rules mechanism — MCP only. */
  skills: SkillHome | null;
  noSkillsNote?: string;
}

// ---- path helpers ---------------------------------------------------------

function appData(ctx: PathContext): string {
  return ctx.env.APPDATA ?? join(ctx.home, "AppData", "Roaming");
}

function xdgConfig(ctx: PathContext): string {
  return ctx.env.XDG_CONFIG_HOME ?? join(ctx.home, ".config");
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
    remoteMcp: { format: "json-http", signIn: "In Claude Code, run /mcp, choose summer-games and sign in." },
    mcp: { user: home(".claude.json"), project: project(".mcp.json") },
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
    mcp: {
      user: (ctx) => join(appConfigRoot(ctx), "Claude", "claude_desktop_config.json"),
      project: null,
    },
    restart: "Quit and reopen Claude Desktop; the summer-engine tools appear under the tools menu in a new chat.",
    skills: null,
    noSkillsNote:
      "Claude Desktop has no skills folder. The MCP server ships summer_get_agent_playbook, so the model can pull Summer guidance in-chat.",
  },
  {
    id: "codex",
    label: "Codex",
    aliases: ["codex-cli", "openai-codex"],
    status: "active",
    envOverride: "SUMMER_CODEX_CONFIG_FILE",
    format: "toml",
    remoteMcp: { format: "toml-url", signIn: "Run `codex mcp login summer-games`; it opens summer.games to sign in." },
    mcp: {
      user: home(".codex", "config.toml"),
      project: project(".codex", "config.toml"),
      projectNote: "Codex only loads project .codex/config.toml from trusted projects.",
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
    remoteMcp: { format: "json-url", signIn: "In Cursor Settings, open MCP and choose Connect next to summer-games." },
    mcp: { user: home(".cursor", "mcp.json"), project: project(".cursor", "mcp.json") },
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
    mcp: {
      user: home(".codeium", "windsurf", "mcp_config.json"),
      project: null,
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
    mcp: {
      user: home(".gemini", "config", "mcp_config.json"),
      project: project(".agents", "mcp_config.json"),
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
    mcp: {
      user: home(".gemini", "extensions", "summer-engine", "gemini-extension.json"),
      project: null,
    },
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
    mcp: {
      user: (ctx) => vsCodeGlobalStorage(ctx, "saoudrizwan.claude-dev", "cline_mcp_settings.json"),
      project: null,
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
    mcp: { user: home(".cline", "data", "settings", "cline_mcp_settings.json"), project: null },
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
    mcp: {
      user: (ctx) => vsCodeGlobalStorage(ctx, "rooveterinaryinc.roo-cline", "cline_mcp_settings.json"),
      project: null,
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
    mcp: {
      user: (ctx) => join(xdgOrAppData(ctx), "kilo", "kilo.json"),
      project: project("kilo.json"),
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
    mcp: { user: home(".copilot", "mcp-config.json"), project: project(".mcp.json") },
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
    mcp: { user: (ctx) => join(vsCodeUserDir(ctx), "mcp.json"), project: project(".vscode", "mcp.json") },
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
    mcp: { user: home(".mcp.json"), project: project(".mcp.json") },
    restart: "Restart Visual Studio, open Copilot Chat in Agent mode, and enable summer-engine in the tools picker.",
    skills: null,
    noSkillsNote: "Visual Studio's Copilot has no skills folder yet; the MCP server ships summer_get_agent_playbook for in-chat guidance.",
  },
  {
    id: "copilot-jetbrains",
    label: "GitHub Copilot in JetBrains IDEs",
    aliases: ["jetbrains-copilot", "intellij-copilot", "copilot-intellij"],
    status: "active",
    envOverride: "SUMMER_COPILOT_JETBRAINS_CONFIG_FILE",
    format: "json-servers",
    mcp: {
      user: (ctx) => join(xdgOrAppData(ctx), "github-copilot", "intellij", "mcp.json"),
      project: null,
    },
    restart: "Restart the JetBrains IDE and open Copilot Chat in Agent mode; summer-engine shows in the tools list.",
    skills: null,
    noSkillsNote: "Copilot in JetBrains documents no skills folder; the MCP server ships summer_get_agent_playbook for in-chat guidance.",
  },
  {
    id: "opencode",
    label: "OpenCode",
    aliases: ["open-code"],
    status: "active",
    envOverride: "SUMMER_OPENCODE_CONFIG_FILE",
    format: "json-opencode",
    mcp: {
      user: (ctx) => join(xdgOrAppData(ctx), "opencode", "opencode.json"),
      project: project("opencode.json"),
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
    mcp: {
      user: (ctx) => join(xdgOrAppData(ctx), "zed", "settings.json"),
      project: null,
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
    mcp: { user: home(".kiro", "settings", "mcp.json"), project: project(".kiro", "settings", "mcp.json") },
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
    mcp: {
      user: (ctx) =>
        ctx.os === "win32"
          ? join(appData(ctx), "Block", "goose", "config", "config.yaml")
          : join(xdgConfig(ctx), "goose", "config.yaml"),
      project: null,
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
    mcp: { user: home(".hermes", "config.yaml"), project: null },
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
    mcp: {
      user: null,
      project: project(".trae", "mcp.json"),
      projectNote: "Trae manages user-level MCP servers in its UI; writing the project file .trae/mcp.json instead.",
    },
    restart: "Restart Trae and open the MCP settings; summer-engine should show as connected.",
    skills: null,
    noSkillsNote: "Trae documents no skills folder; the MCP server ships summer_get_agent_playbook for in-chat guidance.",
  },
  {
    id: "qwen-code",
    label: "Qwen Code",
    aliases: ["qwen", "qwencode"],
    status: "active",
    envOverride: "SUMMER_QWEN_CODE_CONFIG_FILE",
    format: "json",
    mcp: { user: home(".qwen", "settings.json"), project: project(".qwen", "settings.json") },
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
    mcp: { user: home(".kimi-code", "mcp.json"), project: project(".kimi-code", "mcp.json") },
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
    mcp: {
      user: home(".config", "crush", "crushrc"),
      project: project(".crushrc"),
    },
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
    mcp: { user: (ctx) => join(xdgOrAppData(ctx), "amp", "settings.json"), project: null },
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
    mcp: { user: home(".factory", "mcp.json"), project: project(".factory", "mcp.json") },
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
    mcp: { user: home(".junie", "mcp", "mcp.json"), project: project(".junie", "mcp", "mcp.json") },
    restart: "Restart the JetBrains IDE so Junie reloads its MCP config.",
    skills: null,
    noSkillsNote: "Junie has no skills folder; put project guidance in .junie/guidelines.md. The MCP server ships summer_get_agent_playbook for in-chat guidance.",
  },
  {
    id: "warp",
    label: "Warp",
    aliases: ["warp-terminal"],
    status: "active",
    envOverride: "SUMMER_WARP_CONFIG_FILE",
    format: "json",
    mcp: { user: home(".warp", ".mcp.json"), project: project(".warp", ".mcp.json") },
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
    mcp: { user: home(".rovodev", "mcp.json"), project: null },
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
    mcp: { user: home(".qoder", "settings.json"), project: project(".mcp.json") },
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
    mcp: { user: home(".grok", "config.toml"), project: project(".grok", "config.toml") },
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
    mcp: { user: home(".vibe", "config.toml"), project: project(".vibe", "config.toml") },
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
    mcp: { user: home(".lmstudio", "mcp.json"), project: null },
    restart:
      "Open LM Studio, toggle on the summer-engine MCP server in the Program tab, and raise the loaded model's context length to 32k or higher.",
    skills: null,
    noSkillsNote:
      "LM Studio has no rules or skills folder. The MCP server ships summer_get_agent_playbook, so the model can pull Summer guidance in-chat.",
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
