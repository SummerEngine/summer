import { createRequire } from "node:module";
import { Command } from "commander";
import {
  ConfigScope,
  SupportedAgent,
  configureAgentMcp,
  parseAgent,
  parseScope,
  supportedAgents,
} from "../../installer/agent-config.js";
import { SkillSetupResult, setupSkills } from "../../installer/setup.js";
import { DoctorResult, printDoctorResult, runDoctor } from "../../core/capabilities/doctor.js";
import { brandLine, c, sym, tildeify } from "../../core/format.js";

const requireFromHere = createRequire(import.meta.url);
const { version: cliVersion } = requireFromHere("../../../package.json") as {
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
};

interface SetupCommandOptions {
  agent?: string;
  scope?: string;
  dryRun?: boolean;
  print?: boolean;
  yes?: boolean;
  json?: boolean;
  force?: boolean;
  recommended?: boolean;
}

export const setupCommand = new Command("setup")
  .description("Configure Summer Engine for an AI agent and run diagnostics")
  .argument("[agent]", `Agent to configure: ${supportedAgents.join(", ")}`)
  .option("--agent <agent>", `Agent to configure: ${supportedAgents.join(", ")}`)
  .option("--scope <scope>", "Configuration scope: user or project", "user")
  .option("--dry-run", "Show planned changes without writing files")
  .option("--print", "Print the MCP config snippet instead of writing files")
  .option("--yes", "Apply practical setup steps without prompting")
  .option("--json", "Print setup result as JSON")
  .option(
    "--force",
    "Overwrite existing skill content (passes --force through to skills install)"
  )
  .option(
    "--recommended",
    "Install only the recommended skill subset instead of the whole library"
  )
  .action(async (agentArg: string | undefined, opts: SetupCommandOptions) => {
    const agent = resolveAgent(agentArg, opts.agent);
    const scope = resolveScope(opts.scope);

    const config = await configureAgentMcp({
      agent,
      scope,
      dryRun: opts.dryRun,
      print: opts.print,
    });

    const skills = setupSkills(agent, {
      dryRun: Boolean(opts.dryRun || opts.print),
      yes: Boolean(opts.yes),
      force: Boolean(opts.force),
      scope,
      recommended: Boolean(opts.recommended),
    });

    const doctor = await runDoctor({ quiet: true });

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

function resolveScope(scopeOpt: string | undefined): ConfigScope {
  const parsed = parseScope(scopeOpt);
  if (!parsed) {
    throw new Error("Invalid --scope. Use user or project.");
  }
  return parsed;
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
      const tally = skills.installed
        ? c.dim(` (${skills.installed.added} new, ${skills.installed.updated} updated)`)
        : "";
      console.log(`  ${sym.ok()}  Installed ${c.bold(String(installed.length) + " skills")}${tally}  ${where ? c.dim(tildeify(where)) : ""}`);
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
      console.log(`  ${sym.ok()}  ${skills.message}`);
    }
  } else if (skills.status === "planned" && config.dryRun) {
    console.log(
      `  ${c.dim("(dry run)")}  Would install ${c.bold(String(skills.count ?? "?") + " skills")}  ${c.dim(skills.destination ?? "")}`
    );
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

  if (doctor.ok && skills.status !== "failed" && !config.dryRun) {
    console.log("");
    console.log(
      `${c.dim("Try it:")} open ${AGENT_LABEL[config.agent] ?? config.agent} and ask: ${c.bold("\"add a DirectionalLight3D and Camera3D to my scene\"")}`
    );
  }
}

function parseInstalledSkills(stdout: string | undefined): string[] {
  if (!stdout) return [];
  // Lines look like: "  Installed fps-controller -> /path/.../fps-controller"
  const names: string[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(?:Installed|Updated|Generated)\s+([a-z0-9-]+)\s+->/i);
    if (m) names.push(m[1]);
  }
  return names;
}

function parseSkillTargetDir(stdout: string | undefined): string | null {
  if (!stdout) return null;
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(?:Installed|Updated|Generated)\s+[a-z0-9-]+\s+->\s+(.+)$/i);
    if (m) {
      const path = m[1].trim();
      // Strip trailing /<skill-name> to get the parent dir
      const parent = path.replace(/\/[a-z0-9-]+$/i, "/");
      return parent;
    }
  }
  return null;
}
