import { spawnSync } from "child_process";
import { SupportedAgent } from "./agent-config.js";

export interface SkillSetupResult {
  status: "installed" | "planned" | "skipped" | "failed";
  message: string;
  command?: string[];
  stdout?: string;
  stderr?: string;
}

export interface SkillInstallInvocation {
  command: string;
  args: string[];
  display: string[];
}

export function setupRecommendedSkills(
  agent: SupportedAgent,
  options: { dryRun: boolean; yes: boolean; force: boolean }
): SkillSetupResult {
  if (agent === "lm-studio") {
    return {
      status: "skipped",
      message:
        "LM Studio has no rules or skills folder. The MCP server ships summer_get_agent_playbook, so the model can pull Summer guidance in-chat.",
    };
  }

  const invocation = skillInstallInvocation(agent, { force: options.force });

  if (!invocation) {
    return {
      status: "skipped",
      message:
        "No automatic skill installer is available for this agent yet. Run `summer skills install --all` and point the agent at the installed SKILL.md files.",
    };
  }

  if (options.dryRun || !options.yes) {
    return {
      status: "planned",
      command: invocation.display,
      message: `Recommended skills can be installed with: ${invocation.display.join(" ")}`,
    };
  }

  const result = spawnSync(invocation.command, invocation.args, {
    env: process.env,
    encoding: "utf-8",
  });

  if (result.status === 0) {
    return {
      status: "installed",
      command: invocation.display,
      message: "Recommended Summer skills installed.",
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  }

  return {
    status: "failed",
    command: invocation.display,
    message: `Recommended skill install failed with exit code ${result.status ?? "unknown"}.`,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function skillInstallInvocation(
  agent: SupportedAgent,
  opts: { force: boolean } = { force: false }
): SkillInstallInvocation | null {
  const cliPath = process.argv[1];
  if (!cliPath) return null;

  const command = cliPath.endsWith(".js") ? process.execPath : cliPath;
  const prefix = cliPath.endsWith(".js") ? [cliPath] : [];

  const baseArgs = ["skills", "install", "--recommended", "--agent", agent];
  if (opts.force) baseArgs.push("--force");
  return {
    command,
    args: [...prefix, ...baseArgs],
    display: [cliPath, ...baseArgs],
  };
}
