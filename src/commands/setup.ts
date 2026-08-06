import { spawnSync } from "child_process";
import { createRequire } from "node:module";
import { Command } from "commander";
import {
  ConfigScope,
  SupportedAgent,
  configureAgentMcp,
  parseAgent,
  resolveAgentConfigScope,
  supportedAgents,
} from "../lib/agent-config.js";
import { DoctorResult, printDoctorResult, runDoctor } from "./doctor.js";
import { brandLine, c, sym, tildeify } from "../lib/format.js";

const requireFromHere = createRequire(import.meta.url);
const { version: cliVersion } = requireFromHere("../../package.json") as {
  version: string;
};

const AGENT_LABEL: Record<SupportedAgent, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  windsurf: "Devin Desktop (Windsurf)",
  cline: "Cline",
  "roo-code": "Roo Code",
  "kilo-code": "Kilo Code",
  gemini: "Gemini CLI",
  "github-copilot": "GitHub Copilot CLI",
  "vscode-copilot": "GitHub Copilot in VS Code",
  opencode: "OpenCode",
  "lm-studio": "LM Studio",
  antigravity: "Antigravity",
};

interface SetupCommandOptions {
  agent?: string;
  scope?: string;
  dryRun?: boolean;
  print?: boolean;
  yes?: boolean;
  json?: boolean;
  force?: boolean;
  project?: string;
  lmStudioModel?: string;
  lmStudioUrl?: string;
  lmStudioVision?: boolean;
}

interface SkillSetupResult {
  status: "installed" | "planned" | "skipped" | "failed";
  message: string;
  command?: string[];
  stdout?: string;
  stderr?: string;
}

interface SkillInstallInvocation {
  command: string;
  args: string[];
  display: string[];
  cwd?: string;
}

export const setupCommand = new Command("setup")
  .description("Configure Summer Engine for an AI agent and run diagnostics")
  .argument("[agent]", `Agent to configure: ${supportedAgents.join(", ")}`)
  .option("--agent <agent>", `Agent to configure: ${supportedAgents.join(", ")}`)
  .option(
    "--scope <scope>",
    "Configuration scope: user or project (OpenCode/Antigravity + --project default to project)"
  )
  .option("--dry-run", "Show planned changes without writing files")
  .option("--print", "Print the MCP config snippet instead of writing files")
  .option("--yes", "Apply practical setup steps without prompting")
  .option("--json", "Print setup result as JSON")
  .option("--project <path>", "Bind the MCP server entry to one Summer project")
  .option(
    "--lm-studio-model <id>",
    "Configure OpenCode to use this loaded LM Studio model ID"
  )
  .option(
    "--lm-studio-url <url>",
    "LM Studio OpenAI-compatible base URL",
    "http://127.0.0.1:1234/v1"
  )
  .option(
    "--lm-studio-vision",
    "Declare image input support for a vision-capable LM Studio model"
  )
  .option(
    "--force",
    "Overwrite existing skill content (passes --force through to skills install)"
  )
  .action(async (agentArg: string | undefined, opts: SetupCommandOptions) => {
    const agent = resolveAgent(agentArg, opts.agent);
    const scope = resolveScope(agent, opts.scope, opts.project);
    if (opts.lmStudioModel && agent !== "opencode") {
      throw new Error("--lm-studio-model is only supported with `summer setup opencode`.");
    }

    const config = await configureAgentMcp({
      agent,
      scope,
      dryRun: opts.dryRun,
      print: opts.print,
      projectPath: opts.project,
      opencodeLmStudio: opts.lmStudioModel
        ? {
            modelId: opts.lmStudioModel,
            baseUrl: opts.lmStudioUrl,
            vision: opts.lmStudioVision,
          }
        : undefined,
    });

    const skills = setupRecommendedSkills(agent, {
      dryRun: Boolean(opts.dryRun || opts.print),
      yes: Boolean(opts.yes),
      force: Boolean(opts.force),
      scope,
      projectPath: config.projectPath,
    });

    const installedSkillsDir =
      skills.status === "installed" ? parseSkillTargetDir(skills.stdout) : null;
    const doctor = await runDoctor({
      quiet: true,
      // Setup should validate the skills it just installed, not fail because an
      // unrelated agent has an older global skill marker elsewhere on disk.
      skillCandidates: installedSkillsDir
        ? [{ agent, dir: installedSkillsDir }]
        : [],
    });

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ok: doctor.ok && skills.status !== "failed",
            config,
            skills,
            doctor,
          },
          null,
          2
        )
      );
    } else {
      printSetupResult(config, skills, doctor);
    }

    if (!doctor.ok || skills.status === "failed") {
      process.exit(1);
    }
  });

function resolveAgent(agentArg: string | undefined, agentOpt: string | undefined): SupportedAgent {
  if (agentArg && agentOpt && parseAgent(agentArg) !== parseAgent(agentOpt)) {
    throw new Error("Specify the agent either positionally or with --agent, not both.");
  }

  const parsed = parseAgent(agentOpt ?? agentArg);
  if (!parsed) {
    throw new Error(`Specify an agent: ${supportedAgents.join(", ")}`);
  }

  return parsed;
}

function resolveScope(
  agent: SupportedAgent,
  scopeOpt: string | undefined,
  projectPath: string | undefined
): ConfigScope {
  const parsed = resolveAgentConfigScope(agent, scopeOpt, projectPath);
  if (!parsed) {
    throw new Error("Invalid --scope. Use user or project.");
  }
  return parsed;
}

function setupRecommendedSkills(
  agent: SupportedAgent,
  options: {
    dryRun: boolean;
    yes: boolean;
    force: boolean;
    scope: ConfigScope;
    projectPath: string | null;
  }
): SkillSetupResult {
  if (agent === "lm-studio") {
    return {
      status: "skipped",
      message:
        "LM Studio has no rules or skills folder. The MCP server ships summer_get_agent_playbook, so the model can pull Summer guidance in-chat.",
    };
  }

  const invocation = skillInstallInvocation(agent, {
    force: options.force,
    scope: options.scope,
    projectPath: options.projectPath,
  });

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
    cwd: invocation.cwd,
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
  opts: {
    force: boolean;
    scope: ConfigScope;
    projectPath: string | null;
  }
): SkillInstallInvocation | null {
  const cliPath = process.argv[1];
  if (!cliPath) return null;

  const command = cliPath.endsWith(".js") ? process.execPath : cliPath;
  const prefix = cliPath.endsWith(".js") ? [cliPath] : [];

  const baseArgs = [
    "skills",
    "install",
    "--recommended",
    "--agent",
    agent,
    "--scope",
    opts.scope,
  ];
  if (opts.force) baseArgs.push("--force");
  return {
    command,
    args: [...prefix, ...baseArgs],
    display: [cliPath, ...baseArgs],
    cwd:
      opts.scope === "project" && opts.projectPath
        ? opts.projectPath
        : undefined,
  };
}

function printSetupResult(
  config: Awaited<ReturnType<typeof configureAgentMcp>>,
  skills: SkillSetupResult,
  doctor: DoctorResult
): void {
  if (config.print) {
    console.log(config.snippet.trimEnd());
    return;
  }

  console.log("");
  console.log(brandLine(cliVersion));
  console.log("");

  const agentLabel = AGENT_LABEL[config.agent] ?? config.agent;

  if (config.dryRun) {
    console.log(`  ${c.dim("(dry run)")}  Would link to ${agentLabel}  ${c.dim(tildeify(config.path))}`);
  } else if (config.wrote) {
    console.log(`  ${sym.ok()}  Linked to ${c.bold(agentLabel)}  ${c.dim(tildeify(config.path))}`);
  } else {
    console.log(`  ${sym.ok()}  Already linked to ${c.bold(agentLabel)}  ${c.dim(tildeify(config.path))}`);
  }

  if (skills.status === "installed") {
    const installed = parseInstalledSkills(skills.stdout);
    if (installed.length > 0) {
      const where = parseSkillTargetDir(skills.stdout);
      console.log(`  ${sym.ok()}  Installed ${c.bold(String(installed.length) + " skills")}  ${where ? c.dim(tildeify(where)) : ""}`);
      const grouped = installed.reduce<string[][]>((rows, name, i) => {
        const row = Math.floor(i / 3);
        rows[row] = rows[row] ?? [];
        rows[row].push(name);
        return rows;
      }, []);
      for (const row of grouped) {
        console.log(`     ${c.dim(row.join(" · "))}`);
      }
    } else {
      console.log(`  ${sym.ok()}  Installed recommended skills`);
    }
  } else if (skills.status === "planned" || skills.status === "skipped") {
    console.log(`  ${sym.warn()}  Skills: ${c.dim(skills.message)}`);
  } else if (skills.status === "failed") {
    console.log(`  ${sym.fail()}  Skills install failed`);
    if (skills.stderr) console.log(`     ${c.dim(skills.stderr)}`);
  }

  for (const warning of config.warnings) {
    console.log(`  ${sym.warn()}  ${c.yellow(warning)}`);
  }

  console.log("");
  printDoctorResult(doctor);

  if (config.agent === "lm-studio" && !config.dryRun) {
    console.log("");
    console.log(`  ${c.bold("LM Studio next steps")}`);
    for (const step of config.nextSteps) {
      console.log(`  - ${step}`);
    }
    console.log(
      "  - Manual setup and first prompt: https://github.com/SummerEngine/summer-engine-agent/blob/main/references/lm-studio.md"
    );
  }

  if (doctor.ok && skills.status !== "failed" && !config.dryRun) {
    console.log("");
    if (config.agent === "lm-studio") {
      console.log(
        `${c.dim("Safe first chat:")} ask: ${c.bold("\"call summer_get_agent_playbook, read its result, then inspect my project without changing it\"")}`
      );
    } else {
      console.log(
        `${c.dim("Safe first chat:")} open ${AGENT_LABEL[config.agent] ?? config.agent} and ask: ${c.bold("\"call summer_get_agent_playbook, read it, then report my exact project and scene without changing anything\"")}`
      );
    }
  }
}

function parseInstalledSkills(stdout: string | undefined): string[] {
  if (!stdout) return [];
  // Lines look like: "  Installed fps-controller -> /path/.../fps-controller"
  const names: string[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*Installed\s+([a-z0-9-]+)\s+->/i);
    if (m) names.push(m[1]);
  }
  return names;
}

function parseSkillTargetDir(stdout: string | undefined): string | null {
  if (!stdout) return null;
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*Installed\s+[a-z0-9-]+\s+->\s+(.+)$/i);
    if (m) {
      const path = m[1].trim();
      // Strip trailing /<skill-name> to get the parent dir
      const parent = path.replace(/\/[a-z0-9-]+$/i, "/");
      return parent;
    }
  }
  return null;
}
