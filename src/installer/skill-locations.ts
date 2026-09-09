/**
 * Where `summer skills install` puts skills for each agent client.
 *
 * Lives in the installer layer (not cli/) so `summer setup` can report the
 * destination and count without importing the CLI (import-direction contract
 * §2: shared layers never import cli or mcp).
 */

import { join } from "path";
import { homedir, platform } from "os";
import { AGENT_CLIENTS, type AgentClient } from "../core/skills-registry.js";
import { tildeify } from "../core/format.js";

export const SKILL_SCOPES = ["user", "project"] as const;
export type SkillScope = (typeof SKILL_SCOPES)[number];

/** The agent/scope flags `summer skills install` accepts (legacy aliases included). */
export interface SkillInstallSelection {
  agent?: string;
  scope?: string;
  asClaudeSkill?: boolean;
  asCursorSkill?: boolean;
}

function isAgentClient(value: string): value is AgentClient {
  return (AGENT_CLIENTS as readonly string[]).includes(value);
}

function isSkillScope(value: string): value is SkillScope {
  return (SKILL_SCOPES as readonly string[]).includes(value);
}

/** Throws with a user-facing message on an unknown agent. */
export function parseSkillAgent(value: string): AgentClient {
  if (isAgentClient(value)) return value;
  throw new Error(`Unknown agent: ${value}. Use one of: ${AGENT_CLIENTS.join(", ")}.`);
}

/** Throws with a user-facing message on an unknown scope. */
export function parseSkillScope(value: string): SkillScope {
  if (isSkillScope(value)) return value;
  throw new Error(`Unknown scope: ${value}. Use user or project.`);
}

/** Pick the agent from --agent / legacy --as-claude-skill / --as-cursor-skill
 *  (default "summer"); throws on conflicting flags. */
export function resolveSkillAgent(opts: SkillInstallSelection): AgentClient {
  if (opts.asClaudeSkill && opts.asCursorSkill) {
    throw new Error("Use only one legacy alias: --as-claude-skill or --as-cursor-skill.");
  }

  const legacyAgent = opts.asClaudeSkill
    ? "claude-code"
    : opts.asCursorSkill
      ? "cursor"
      : undefined;

  if (opts.agent && legacyAgent && opts.agent !== legacyAgent) {
    throw new Error(
      `Conflicting agent options: --agent ${opts.agent} with legacy alias for ${legacyAgent}.`
    );
  }

  return parseSkillAgent(opts.agent ?? legacyAgent ?? "summer");
}

/** Explicit --scope wins; otherwise project-rooted agents default to "project". */
export function resolveSkillScope(agent: AgentClient, opts: SkillInstallSelection): SkillScope {
  if (opts.scope) return parseSkillScope(opts.scope);
  if (
    agent === "cursor" ||
    agent === "windsurf" ||
    agent === "cline" ||
    agent === "roo-code" ||
    agent === "kilo-code"
  ) {
    return "project";
  }
  return "user";
}

export type InstallLocation =
  | { kind: "skill-dir"; path: string }
  | { kind: "cursor-rule-dir"; path: string }
  | { kind: "windsurf-rule-file"; path: string }
  | { kind: "cline-rule-dir"; path: string }
  | { kind: "opencode-skill-dir"; path: string };

export function resolveInstallLocation(
  agent: AgentClient,
  scope: SkillScope
): InstallLocation {
  const overrideDir = process.env.SUMMER_SKILLS_DIR;
  if (overrideDir) {
    if (agent === "cursor") return { kind: "cursor-rule-dir", path: overrideDir };
    if (agent === "windsurf") {
      return { kind: "windsurf-rule-file", path: join(overrideDir, ".windsurfrules") };
    }
    if (agent === "cline" || agent === "roo-code" || agent === "kilo-code") {
      return { kind: "cline-rule-dir", path: overrideDir };
    }
    if (agent === "gemini") {
      return { kind: "skill-dir", path: overrideDir };
    }
    if (agent === "opencode") {
      return { kind: "opencode-skill-dir", path: overrideDir };
    }
    return { kind: "skill-dir", path: overrideDir };
  }

  const root = scope === "user" ? homedir() : process.cwd();
  switch (agent) {
    case "codex":
      return { kind: "skill-dir", path: join(root, ".agents", "skills") };
    case "claude-code":
      return { kind: "skill-dir", path: join(root, ".claude", "skills") };
    case "cursor":
      return { kind: "cursor-rule-dir", path: join(root, ".cursor", "rules") };
    case "windsurf":
      return { kind: "windsurf-rule-file", path: join(root, ".windsurfrules") };
    case "cline":
      return {
        kind: "cline-rule-dir",
        path:
          scope === "user"
            ? clineUserRulesDir()
            : join(process.cwd(), ".clinerules"),
      };
    case "roo-code":
      return {
        kind: "cline-rule-dir",
        path:
          scope === "user"
            ? rooCodeUserRulesDir()
            : join(process.cwd(), ".clinerules"),
      };
    case "kilo-code":
      return {
        kind: "cline-rule-dir",
        path:
          scope === "user"
            ? join(homedir(), ".kilocode", "rules")
            : join(process.cwd(), ".kilocode", "rules"),
      };
    case "gemini":
      // Gemini discovers extension skills from <extension>/skills/<name>/SKILL.md
      // (geminicli.com/docs/extensions/reference), so copy the skill directories
      // as-is. The extension dir itself is written by `summer setup gemini`.
      return {
        kind: "skill-dir",
        path: join(homedir(), ".gemini", "extensions", "summer-engine", "skills"),
      };
    case "github-copilot":
    case "vscode-copilot":
      return {
        kind: "skill-dir",
        path:
          scope === "user"
            ? join(homedir(), ".copilot", "skills")
            : join(process.cwd(), ".github", "skills"),
      };
    case "opencode":
      return {
        kind: "opencode-skill-dir",
        path:
          scope === "user"
            ? opencodeUserAgentsDir()
            : join(process.cwd(), ".opencode", "agents", "summer"),
      };
    case "summer":
      return { kind: "skill-dir", path: join(root, ".summer", "skills") };
  }
}

function clineUserRulesDir(): string {
  // Cline reads global rules from the user's Documents/Cline/Rules folder.
  return join(homedir(), "Documents", "Cline", "Rules");
}

function rooCodeUserRulesDir(): string {
  // Roo Code reads global rules from the user's Documents/Roo/Rules folder.
  return join(homedir(), "Documents", "Roo", "Rules");
}

function opencodeUserAgentsDir(): string {
  // OpenCode's user-scope agent definition directory varies by OS.
  // On Windows, OpenCode reads from %APPDATA%/opencode/agents/summer.
  // On Linux/macOS, it reads from $XDG_CONFIG_HOME or ~/.config/opencode/agents/summer.
  if (platform() === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "opencode", "agents", "summer");
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdg, "opencode", "agents", "summer");
}

/** One-line, human path pattern for where an install location puts skills. */
export function describeInstallLocation(location: InstallLocation): string {
  const p = tildeify(location.path);
  switch (location.kind) {
    case "skill-dir":
      return `${p}/<skill>/SKILL.md`;
    case "cursor-rule-dir":
      return `${p}/summer-<skill>.mdc`;
    case "cline-rule-dir":
    case "opencode-skill-dir":
      return `${p}/summer-<skill>.md`;
    case "windsurf-rule-file":
      return p;
  }
}
