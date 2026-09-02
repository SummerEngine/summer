import { spawnSync } from "child_process";
import { SupportedAgent } from "./agent-config.js";
import {
  AGENT_CLIENTS,
  getSkillRegistry,
  selectSkillsForBulkInstall,
  type AgentClient,
} from "../core/skills-registry.js";
import { describeInstallLocation, resolveInstallLocation } from "./skill-locations.js";

export interface SkillSetupResult {
  status: "installed" | "planned" | "skipped" | "failed";
  message: string;
  command?: string[];
  stdout?: string;
  stderr?: string;
  /** Number of skills selected for install (all, or the recommended subset). */
  count?: number;
  /** Preview skills installed alongside the stable ones (the default). */
  previewIncluded?: number;
  /** Preview skills left out because --stable-only was given. */
  previewSkipped?: number;
  /** Where the skills land, e.g. "~/.claude/skills/<skill>/SKILL.md". */
  destination?: string;
  /** Post-install tallies parsed from `skills install` output. */
  installed?: { total: number; added: number; updated: number };
}

export interface SkillInstallInvocation {
  command: string;
  args: string[];
  display: string[];
}

export interface SkillSetupOptions {
  dryRun: boolean;
  yes: boolean;
  force: boolean;
  /** Skills scope; defaults to the MCP scope so both land in the same place. */
  scope?: "user" | "project";
  /** Install only `recommended: true` skills instead of the whole library. */
  recommended?: boolean;
  /** Skip `status: preview` skills. By default they install like any other
   *  skill — preview is a label carried in the skill's guidance, not a gate. */
  stableOnly?: boolean;
}

/**
 * The preview clause of the setup summary — one wording for the result message
 * and the CLI line, e.g. "10 preview — labelled in each skill's guidance; use
 * --stable-only to skip". Empty when there is nothing to say.
 */
export function previewNote(result: { previewIncluded?: number; previewSkipped?: number }): string {
  if (result.previewIncluded) {
    return `${result.previewIncluded} preview — labelled in each skill's guidance; use --stable-only to skip`;
  }
  if (result.previewSkipped) {
    return `${result.previewSkipped} preview skipped by --stable-only`;
  }
  return "";
}

/**
 * Install the Summer skill library for an agent as part of `summer setup`.
 *
 * Installs EVERY library skill by default: skills are progressive-disclosure
 * (name + description in context, body on activation), and the session entry
 * skill `using-summer` is not in the recommended subset, so a
 * recommended-only default left the documented starting point uninstalled.
 * `--recommended` keeps the smaller subset as an opt-in; `--stable-only` drops
 * the preview skills (installed by default, labelled in their guidance).
 */
export function setupSkills(
  agent: SupportedAgent,
  options: SkillSetupOptions
): SkillSetupResult {
  if (agent === "lm-studio") {
    return {
      status: "skipped",
      message:
        "LM Studio has no rules or skills folder. The MCP server ships summer_get_agent_playbook, so the model can pull Summer guidance in-chat.",
    };
  }

  const scope = options.scope ?? "user";
  const recommended = Boolean(options.recommended);
  const stableOnly = Boolean(options.stableOnly);
  const invocation = skillInstallInvocation(agent, {
    force: options.force,
    scope,
    recommended,
    stableOnly,
  });

  if (!invocation) {
    return {
      status: "skipped",
      message:
        "No automatic skill installer is available for this agent yet. Run `summer skills install --all` and point the agent at the installed SKILL.md files.",
    };
  }

  const { selected, previewIncluded, previewSkipped } = selectSkillsForBulkInstall(
    getSkillRegistry(),
    { recommended, stableOnly }
  );
  const count = selected.length;
  const note = previewNote({ previewIncluded, previewSkipped });
  const destination = isAgentClient(agent)
    ? describeInstallLocation(resolveInstallLocation(agent, scope))
    : undefined;
  const subset = recommended ? "recommended " : "";

  if (options.dryRun || !options.yes) {
    return {
      status: "planned",
      command: invocation.display,
      count,
      previewIncluded,
      previewSkipped,
      destination,
      message: `Would install ${count} ${subset}skills${note ? ` (${note})` : ""} to ${destination ?? "the agent's skills directory"} with: ${invocation.display.join(" ")}`,
    };
  }

  const result = spawnSync(invocation.command, invocation.args, {
    env: process.env,
    encoding: "utf-8",
  });

  if (result.status === 0) {
    const installed = tallyInstallOutput(result.stdout);
    return {
      status: "installed",
      command: invocation.display,
      count,
      previewIncluded,
      previewSkipped,
      destination,
      installed,
      message: `Installed ${installed.total} ${subset}skills (${installed.added} new, ${installed.updated} updated${note ? `; ${note}` : ""}).`,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  }

  return {
    status: "failed",
    command: invocation.display,
    count,
    destination,
    message: `Skill install failed with exit code ${result.status ?? "unknown"}.`,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

/** @deprecated use setupSkills; kept for older callers. */
export const setupRecommendedSkills = (
  agent: SupportedAgent,
  options: { dryRun: boolean; yes: boolean; force: boolean }
): SkillSetupResult => setupSkills(agent, { ...options, recommended: true });

function isAgentClient(agent: SupportedAgent): agent is SupportedAgent & AgentClient {
  return (AGENT_CLIENTS as readonly string[]).includes(agent);
}

/**
 * Count `skills install` result lines. Directory installs print
 * "Installed <skill> -> <path>" for new copies and "Updated <skill> -> <path>"
 * for re-installs; rule-file agents (Cursor, Cline, ...) always print
 * "Generated <skill> -> <path>" and are counted as updated-or-new (added).
 */
export function tallyInstallOutput(stdout: string): {
  total: number;
  added: number;
  updated: number;
} {
  let added = 0;
  let updated = 0;
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(Installed|Updated|Generated)\s+([a-z0-9-]+)\s+->/i);
    if (!m) continue;
    if (m[1].toLowerCase() === "updated") updated += 1;
    else added += 1;
  }
  return { total: added + updated, added, updated };
}

function skillInstallInvocation(
  agent: SupportedAgent,
  opts: { force: boolean; scope: "user" | "project"; recommended: boolean; stableOnly: boolean }
): SkillInstallInvocation | null {
  const cliPath = process.argv[1];
  if (!cliPath) return null;

  const command = cliPath.endsWith(".js") ? process.execPath : cliPath;
  const prefix = cliPath.endsWith(".js") ? [cliPath] : [];

  const baseArgs = [
    "skills",
    "install",
    opts.recommended ? "--recommended" : "--all",
    "--agent",
    agent,
    "--scope",
    opts.scope,
  ];
  if (opts.force) baseArgs.push("--force");
  if (opts.stableOnly) baseArgs.push("--stable-only");
  return {
    command,
    args: [...prefix, ...baseArgs],
    display: [cliPath, ...baseArgs],
  };
}
