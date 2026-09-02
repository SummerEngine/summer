import { Command, Option } from "commander";
import {
  SupportedAgent,
  configureAgentMcp,
  resolveAgentSelection,
  resolveConfigScope,
  supportedAgents,
} from "../../installer/agent-config.js";
import { SkillSetupResult, previewNote, setupSkills } from "../../installer/setup.js";
import { DoctorResult, printDoctorResult, runDoctor } from "../../core/capabilities/doctor.js";
import { brandLine, c, sym, tildeify } from "../../core/format.js";

import { TOOLKIT_VERSION as cliVersion } from "../../core/version.js";

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
  localDev?: boolean;
  yes?: boolean;
  json?: boolean;
  force?: boolean;
  recommended?: boolean;
  stableOnly?: boolean;
  /** Hidden no-op alias kept for one release; preview skills install by default now. */
  includePreview?: boolean;
}

export const setupCommand = new Command("setup")
  .description("Configure Summer Engine for an AI agent and run diagnostics")
  .argument("[agent]", `Agent to configure: ${supportedAgents.join(", ")}`)
  .option("--agent <agent>", `Agent to configure: ${supportedAgents.join(", ")}`)
  .option("--scope <scope>", "Configuration scope: user or project", "user")
  .option("--dry-run", "Show planned changes without writing files")
  .option("--print", "Print the MCP config snippet instead of writing files")
  .option(
    "--local-dev",
    "Point the agent at this checkout's built CLI (node <repo>/dist/bin/summer.js mcp) instead of npx summer-engine@latest — for testing unpublished builds. SUMMER_DEV=1 does the same."
  )
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
  .option(
    "--stable-only",
    "Skip preview skills (installed by default; each is labelled preview in its guidance)"
  )
  // Pre-reversal opt-in, kept one release as a hidden no-op so old scripts still parse.
  .addOption(new Option("--include-preview", "No-op: preview skills install by default").hideHelp())
  .action(async (agentArg: string | undefined, opts: SetupCommandOptions) => {
    const agent = resolveAgentSelection(agentArg, opts.agent);
    const scope = resolveConfigScope(opts.scope);

    const config = await configureAgentMcp({
      agent,
      scope,
      dryRun: opts.dryRun,
      print: opts.print,
      localDev: Boolean(opts.localDev) || process.env.SUMMER_DEV === "1",
    });

    const skills = setupSkills(agent, {
      dryRun: Boolean(opts.dryRun || opts.print),
      yes: Boolean(opts.yes),
      force: Boolean(opts.force),
      scope,
      recommended: Boolean(opts.recommended),
      stableOnly: Boolean(opts.stableOnly),
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
  if (config.localDev) {
    console.log(
      `  ${c.dim("(local dev)")}  MCP server command: ${c.dim(`${config.server.command} ${config.server.args.join(" ")}`)}`
    );
  }

  if (skills.status === "installed") {
    const installed = parseInstalledSkills(skills.stdout);
    if (installed.length > 0) {
      const where = parseSkillTargetDir(skills.stdout);
      const note = previewNote(skills);
      const tally = skills.installed
        ? c.dim(` (${skills.installed.added} new, ${skills.installed.updated} updated${note ? `; ${note}` : ""})`)
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
    const note = previewNote(skills);
    console.log(
      `  ${c.dim("(dry run)")}  Would install ${c.bold(String(skills.count ?? "?") + " skills")}${
        note ? c.dim(` (${note})`) : ""
      }  ${c.dim(skills.destination ?? "")}`
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
