/**
 * Where `summer skills install` puts skills for each agent client.
 *
 * Lives in the installer layer (not cli/) so `summer setup` can report the
 * destination and count without importing the CLI (import-direction contract
 * §2: shared layers never import cli or mcp).
 */

import { join } from "path";
import { homedir, platform } from "os";
import type { AgentClient } from "../core/skills-registry.js";
import { tildeify } from "../core/format.js";

export const SKILL_SCOPES = ["user", "project"] as const;
export type SkillScope = (typeof SKILL_SCOPES)[number];

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
