import { Command, Option } from "commander";
import {
  SupportedAgent,
  configureAgentMcp,
  configureSummerGamesMcp,
  resolveAgentSelection,
  resolveConfigScope,
  supportedAgents,
} from "../../installer/agent-config.js";
import { SkillSetupResult, previewNote, setupSkills } from "../../installer/setup.js";
import { DoctorResult, printDoctorResult, runDoctor } from "../../core/capabilities/doctor.js";
import { brandLine, c, sym, tildeify } from "../../core/format.js";

import { TOOLKIT_VERSION as cliVersion } from "../../core/version.js";
import { resolveDefaultChannel } from "../../installer/version-check.js";
import { agentLabel } from "../../installer/agent-table.js";
import { PROFILES, parseProfile, type Profile } from "../../core/tool-profiles.js";

const PROFILE_NOTES: Record<Profile, string> = {
  full: "Every Summer tool.",
  engine: "Engine, generation and store tools. Every tool: summer setup <agent> --profile full",
  assets: "Generation and asset tools, no engine tools. Every tool: summer setup <agent> --profile full",
};

interface SetupCommandOptions {
  agent?: string;
  scope?: string;
  dryRun?: boolean;
  print?: boolean;
  localDev?: boolean;
  channel?: string;
  yes?: boolean;
  json?: boolean;
  /** false with --no-games: link the engine only. */
  games?: boolean;
  profile?: string;
  assetsOnly?: boolean;
  force?: boolean;
  recommended?: boolean;
  stableOnly?: boolean;
  /** Hidden no-op alias kept for one release; preview skills install by default now. */
  includePreview?: boolean;
}

export const setupCommand = new Command("setup")
  .description(
    "Configure Summer Engine for an AI agent and run diagnostics. For agents that can sign in to it, it also adds Summer Games (summer-games)."
  )
  .argument("[agent]", `Agent to configure: ${supportedAgents.join(", ")}`)
  .option("--agent <agent>", `Agent to configure: ${supportedAgents.join(", ")}`)
  .option("--scope <scope>", "Configuration scope: user or project", "user")
  .option("--dry-run", "Show planned changes without writing files")
  .option("--print", "Print the MCP config snippet instead of writing files")
  .option(
    "--local-dev",
    "Point the agent at this checkout's built CLI (node <repo>/dist/bin/summer.js mcp) instead of npx summer-engine@latest — for testing unpublished builds. SUMMER_DEV=1 does the same."
  )
  .option(
    "--channel <dist-tag>",
    "npm dist-tag the agent's MCP entry runs: npx -y summer-engine@<dist-tag> mcp (default latest; use next while a release soaks on the next tag). SUMMER_CHANNEL does the same."
  )
  .option("--yes", "Apply practical setup steps without prompting")
  .option(
    "--no-games",
    "Do not add the Summer Games MCP (summer-games: friends, parties and messages as you, signed in through summer.games)"
  )
  .option(
    "--profile <profile>",
    "MCP tool profile: full (every tool, the default), engine (engine, generation and the store; under 128 tools; the default for VS Code Copilot), assets (generation and the asset library, no engine tools)"
  )
  .option(
    "--assets-only",
    "Set up for making assets without Summer Engine: the assets profile, only the asset skills, and no Summer Games"
  )
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
    const profile = resolveSetupProfile(opts);

    const defaultChannel = await resolveDefaultChannel(cliVersion);
    const config = await configureAgentMcp({
      agent,
      scope,
      dryRun: opts.dryRun,
      print: opts.print,
      localDev: Boolean(opts.localDev) || process.env.SUMMER_DEV === "1",
      channel: opts.channel ?? process.env.SUMMER_CHANNEL ?? defaultChannel.channel,
      profile,
    });
    const games =
      opts.games === false || opts.assetsOnly || opts.print
        ? null
        : await configureSummerGamesMcp({ agent, scope, dryRun: opts.dryRun });
    if (!opts.channel && !process.env.SUMMER_CHANNEL && defaultChannel.note && !opts.print) {
      console.log(`  ${c.dim(defaultChannel.note)}`);
    }

    const skills = setupSkills(agent, {
      dryRun: Boolean(opts.dryRun || opts.print),
      yes: Boolean(opts.yes),
      force: Boolean(opts.force),
      scope,
      recommended: Boolean(opts.recommended),
      stableOnly: Boolean(opts.stableOnly),
      assetsOnly: Boolean(opts.assetsOnly),
    });

    const doctor = await runDoctor({ quiet: true });

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ok: doctor.ok && skills.status !== "failed",
            config,
            games,
            skills,
            doctor,
          },
          null,
          2
        )
      );
    } else {
      printSetupResult(config, games, skills, doctor);
    }

    if (!doctor.ok || skills.status === "failed") {
      process.exit(1);
    }
  });

/** --assets-only means the assets profile; --profile must name a profile and agree with it. */
function resolveSetupProfile(opts: SetupCommandOptions): Profile | undefined {
  const profile = opts.profile === undefined ? undefined : parseProfile(opts.profile);
  if (profile === null) {
    throw new Error(`Unknown --profile "${opts.profile}". Use one of: ${Object.keys(PROFILES).join(", ")}.`);
  }
  if (opts.assetsOnly) {
    if (profile && profile !== "assets") throw new Error("--assets-only uses the assets profile; leave out --profile.");
    return "assets";
  }
  return profile;
}

function printSetupResult(
  config: Awaited<ReturnType<typeof configureAgentMcp>>,
  games: Awaited<ReturnType<typeof configureSummerGamesMcp>>,
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

  const label = agentLabel(config.agent);

  if (config.dryRun) {
    console.log(`  ${c.dim("(dry run)")}  Would link to ${label}  ${c.dim(tildeify(config.path))}`);
  } else if (config.wrote) {
    console.log(`  ${sym.ok()}  Linked to ${c.bold(label)}  ${c.dim(tildeify(config.path))}`);
  } else {
    console.log(`  ${sym.ok()}  Already linked to ${c.bold(label)}  ${c.dim(tildeify(config.path))}`);
  }
  if (config.localDev) {
    console.log(
      `  ${c.dim("(local dev)")}  MCP server command: ${c.dim(`${config.server.command} ${config.server.args.join(" ")}`)}`
    );
  } else if (config.channel !== "latest") {
    console.log(
      `  ${c.dim(`(channel ${config.channel})`)}  MCP server command: ${c.dim(`${config.server.command} ${config.server.args.join(" ")}`)}`
    );
  }
  if (config.profile !== "full") {
    console.log(`  ${c.dim(`(profile ${config.profile})`)}  ${c.dim(PROFILE_NOTES[config.profile])}`);
  }

  if (games) {
    const name = c.bold("Summer Games");
    const url = c.dim(games.url);
    if (games.existingName) {
      console.log(`  ${sym.ok()}  ${name} already added as ${c.bold(games.existingName)}  ${url}`);
    } else if (config.dryRun) {
      console.log(`  ${c.dim("(dry run)")}  ${games.changed ? "Would add" : "Already added"} ${name}  ${url}`);
    } else {
      console.log(`  ${sym.ok()}  ${games.wrote ? "Added" : "Already added"} ${name}  ${url}`);
    }
    if (!config.dryRun) console.log(`     ${c.dim(`Sign in once: ${games.signIn}`)}`);
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
      console.log(`     ${c.dim(skillNamesSample(installed))}`);
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
    const ask = config.profile === "assets" ? "make a sword clash sound effect" : "add a DirectionalLight3D and Camera3D to my scene";
    console.log(`${c.dim("Try it:")} open ${label} and ask: ${c.bold(`"${ask}"`)}`);
  }
}

/** One line instead of a row per three skills: the first few names and how many more. `--json` keeps the full list. */
export function skillNamesSample(names: readonly string[], max = 8): string {
  const shown = names.slice(0, max).join(" · ");
  return names.length > max ? `${shown} · and ${names.length - max} more` : shown;
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
