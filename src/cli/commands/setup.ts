import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { relative } from "path";
import { Command, Option } from "commander";
import {
  ConfigScope,
  SupportedAgent,
  configureAgentMcp,
  configureSummerGamesMcp,
  resolveAgentSelection,
  resolveBundledRuntime,
  type AgentConfigResult,
  type RemoteMcpResult,
  resolveConfigScope,
  supportedAgents,
} from "../../installer/agent-config.js";
import { SkillSetupResult, previewNote, setupSkills } from "../../installer/setup.js";
import { detectAgents } from "../../installer/agent-detect.js";
import { SetupError, toStepError, type SetupStepError } from "../../installer/setup-error.js";
import { DoctorResult, printDoctorResult, runDoctor } from "../../core/capabilities/doctor.js";
import { brandLine, c, sym, tildeify } from "../../core/format.js";

import { TOOLKIT_VERSION as cliVersion } from "../../core/version.js";
import { listsSummerEngine, resolveDefaultChannel } from "../../installer/version-check.js";
import { findShadowingSummer, shadowWarning } from "../../installer/path-shadow.js";
import { agentLabel, agentSpec, cliSetupRefusal, defaultPathContext } from "../../installer/agent-table.js";
import { addAllowRules, allowRulesPath, removeAllowRules, supportsAllowRules, type AllowRulesResult } from "../../installer/cli-permissions.js";
import { PROFILES, parseProfile, type Profile } from "../../core/tool-profiles.js";
import { findSetupProjectRoot, writeAgentInstructions, type InstructionFileResult } from "../../project-memory/agent-instructions.js";

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
  /** --cli: the skills and no MCP server. */
  cli?: boolean;
  /** false with --no-mcp, the same as --cli. */
  mcp?: boolean;
  /** --allow-rules (with --cli): let Claude Code or Codex run read-only and dry-run summer commands without asking. */
  allowRules?: boolean;
  /** --remove-allow-rules: take exactly those rules out again. */
  removeAllowRules?: boolean;
  /** false with --no-project-files: leave the project's AGENTS.md and CLAUDE.md alone. */
  projectFiles?: boolean;
  /** --runtime <node>: the entry runs this node executable instead of npx (with --package-dir). */
  runtime?: string;
  /** --package-dir <dir>: the summer-engine package folder the bundled runtime runs. */
  packageDir?: string;
  /** --detect: list every agent, whether it is installed and linked; writes nothing. */
  detect?: boolean;
}

/** The project's AGENTS.md and CLAUDE.md: what setup did, or would do without --yes. */
interface ProjectFiles {
  root: string;
  /** false: planned only (no --yes, or --dry-run). */
  written: boolean;
  dryRun: boolean;
  files: InstructionFileResult[];
}

/** The options that only shape the MCP entry, which --cli does not write. */
const MCP_ENTRY_FLAGS: ReadonlyArray<[keyof SetupCommandOptions, string]> = [
  ["print", "--print"],
  ["localDev", "--local-dev"],
  ["channel", "--channel"],
  ["profile", "--profile"],
  ["runtime", "--runtime"],
  ["packageDir", "--package-dir"],
];

export const setupCommand = new Command("setup")
  .description(
    "Configure Summer Engine for an AI agent and run diagnostics. For agents that can sign in to it, it also adds Summer Games (summer-games). --cli installs the skills only: the agent runs summer commands in its shell, with no MCP server."
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
    "--runtime <node>",
    "Run the MCP server with this node executable instead of npx: <node> <package-dir>/dist/bin/summer.js mcp. Needs --package-dir. For installers that ship their own Node.js"
  )
  .option("--package-dir <dir>", "The summer-engine package folder (package.json and dist/bin/summer.js) that --runtime runs")
  .option(
    "--detect",
    "List every supported agent: installed or not, its MCP config file, and whether it already lists summer-engine. Writes nothing; takes no agent. Use with --json"
  )
  .option(
    "--channel <dist-tag>",
    "npm dist-tag or exact version the agent's MCP entry runs: npx -y summer-engine@<dist-tag> mcp (default latest; a CLI newer than npm latest pins next when next is this version, else this version). SUMMER_CHANNEL does the same."
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
  .option(
    "--cli",
    "CLI only: install the skills and no MCP server (and no Summer Games). The agent runs Summer as summer <area> <action> commands in its shell; the summer-cli skill teaches it"
  )
  .option("--no-mcp", "Same as --cli")
  .option(
    "--allow-rules",
    "With --cli, for Claude Code and Codex: let the agent run read-only summer commands, and dry runs of spends, without asking. Prints every rule; written only with --yes"
  )
  .option("--remove-allow-rules", "Remove the allow rules --allow-rules added (Claude Code, Codex), and nothing else")
  .option(
    "--no-project-files",
    "Inside a Summer project, do not add the Summer instructions to its AGENTS.md and CLAUDE.md (added with --yes by default)"
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
    if (opts.detect) {
      runDetect(agentArg, opts);
      return;
    }
    if (!opts.json) {
      await setupAgent(agentArg, opts);
      return;
    }
    // --json: one JSON document on stdout, also when setup cannot start.
    try {
      await setupAgent(agentArg, opts);
    } catch (error) {
      console.log(JSON.stringify({ ok: false, error: toStepError(error, "setup_failed"), steps: [] }, null, 2));
      process.exit(1);
    }
  });

/** One setup step in --json: ok, what it did, and a coded error when it failed. */
interface SetupStep {
  step: "mcp_entry" | "summer_games" | "skills" | "project_files" | "doctor";
  ok: boolean;
  /** mcp_entry, summer_games: written | unchanged | planned | printed | exists | not_supported | skipped.
   *  skills: installed | planned | skipped | failed. project_files: written | planned | not_in_project | skipped.
   *  doctor: passed | failed. Every step that did not fail is ok, planned and skipped ones too. */
  status: string;
  path?: string;
  error?: SetupStepError;
  warnings?: string[];
}

/**
 * Runs one step. With --json a throw becomes the step's coded error and the
 * other steps still run; without it the throw ends setup as it always did.
 */
async function runStep<T>(json: boolean, fallbackCode: string, run: () => Promise<T> | T): Promise<{ value: T | null; error?: SetupStepError }> {
  if (!json) return { value: await run() };
  try {
    return { value: await run() };
  } catch (error) {
    return { value: null, error: toStepError(error, fallbackCode) };
  }
}

async function setupAgent(agentArg: string | undefined, opts: SetupCommandOptions): Promise<void> {
  let agent: SupportedAgent;
  try {
    agent = resolveAgentSelection(agentArg, opts.agent);
  } catch (error) {
    throw new SetupError("unknown_agent", error instanceof Error ? error.message : String(error));
  }
  let scope: ConfigScope;
  try {
    scope = resolveConfigScope(opts.scope);
  } catch (error) {
    throw new SetupError("invalid_scope", error instanceof Error ? error.message : String(error));
  }
  if (opts.removeAllowRules) {
    await removeCliAllowRules(agent, scope, opts);
    return;
  }
  if (opts.cli || opts.mcp === false) {
    await setupCliOnly(agent, scope, opts);
    return;
  }
  // On stderr, so --json output stays one JSON document.
  if (opts.allowRules) console.error(`  ${sym.warn()}  ${c.yellow("--allow-rules works with --cli only (the MCP server asks through the agent's own tool approvals); no rules were added.")}`);
  const profile = resolveSetupProfile(opts);
  const runtime = resolveBundledRuntime(opts.runtime, opts.packageDir);
  if (runtime && (opts.localDev || opts.channel)) {
    throw new SetupError("invalid_option", `--runtime runs a bundled summer-engine; leave out ${opts.localDev ? "--local-dev" : "--channel"}.`);
  }
  const json = Boolean(opts.json);

  // A bundled runtime runs the package beside it, so npm's tags do not matter (and no network call is made).
  const defaultChannel: { channel: string; note?: string } = runtime ? { channel: "latest" } : await resolveDefaultChannel(cliVersion);
  const mcp = await runStep(json, "mcp_entry_failed", () =>
    configureAgentMcp({
      agent,
      scope,
      dryRun: opts.dryRun,
      print: opts.print,
      localDev: Boolean(opts.localDev) || process.env.SUMMER_DEV === "1",
      channel: opts.channel ?? process.env.SUMMER_CHANNEL ?? defaultChannel.channel,
      profile,
      runtime: runtime ?? undefined,
    })
  );
  const config = mcp.value;
  const gamesSkipped = opts.games === false || opts.assetsOnly || opts.print;
  const gamesStep = gamesSkipped
    ? { value: null }
    : await runStep(json, "summer_games_failed", () => configureSummerGamesMcp({ agent, scope, dryRun: opts.dryRun }));
  const games = gamesStep.value;
  if (!runtime && !opts.channel && !process.env.SUMMER_CHANNEL && defaultChannel.note && !opts.print) {
    // On stderr with --json, so stdout stays one JSON document.
    (json ? console.error : console.log)(`  ${c.dim(defaultChannel.note)}`);
  }

  const skillsStep = await runStep(json, "skills_install_failed", () =>
    setupSkills(agent, {
      dryRun: Boolean(opts.dryRun || opts.print),
      yes: Boolean(opts.yes),
      force: Boolean(opts.force),
      scope,
      recommended: Boolean(opts.recommended),
      stableOnly: Boolean(opts.stableOnly),
      assetsOnly: Boolean(opts.assetsOnly),
    })
  );
  const skills: SkillSetupResult = skillsStep.value ?? { status: "failed", message: skillsStep.error?.message ?? "Skill install failed." };
  const projectStep = await runStep(json, "project_files_failed", () => setupProjectInstructions(opts));
  const projectFiles = projectStep.value;

  const doctor = await runDoctor({ quiet: true });
  const shadow = opts.print ? null : staleSummerOnPath();

  if (json) {
    const steps: SetupStep[] = [
      mcpEntryStep(config, mcp.error),
      summerGamesStep(agent, games, gamesSkipped ? "skipped" : null, gamesStep.error, Boolean(opts.dryRun)),
      skillsStepResult(skills, skillsStep.error),
      projectFilesStep(projectFiles, projectStep.error, opts),
      doctorStep(doctor),
    ];
    const ok = steps.every((step) => step.ok);
    console.log(JSON.stringify({ ok, agent, scope, steps, config, games, skills, projectFiles, doctor, ...(shadow ? { warnings: [shadow] } : {}) }, null, 2));
    if (!ok) process.exit(1);
    return;
  }

  printSetupResult(config!, games, skills, doctor, projectFiles, shadow);
  if (!doctor.ok || skills.status === "failed") {
    process.exit(1);
  }
}

function mcpEntryStep(config: AgentConfigResult | null, error: SetupStepError | undefined): SetupStep {
  if (!config) return { step: "mcp_entry", ok: false, status: "failed", error: error ?? { code: "mcp_entry_failed", message: "The MCP entry was not written." } };
  const status = config.print ? "printed" : config.dryRun ? (config.changed ? "planned" : "unchanged") : config.wrote ? "written" : "unchanged";
  return { step: "mcp_entry", ok: true, status, path: config.path, ...(config.warnings.length ? { warnings: config.warnings } : {}) };
}

function summerGamesStep(
  agent: SupportedAgent,
  games: RemoteMcpResult | null,
  skipped: "skipped" | null,
  error: SetupStepError | undefined,
  dryRun: boolean
): SetupStep {
  if (error) return { step: "summer_games", ok: false, status: "failed", error };
  if (skipped) return { step: "summer_games", ok: true, status: "skipped" };
  // configureSummerGamesMcp returns null only for agents without a Summer Games entry shape.
  if (!games) return { step: "summer_games", ok: true, status: "not_supported", warnings: [`${agentLabel(agent)} gets no Summer Games entry from setup.`] };
  const status = games.existingName ? "exists" : dryRun ? (games.changed ? "planned" : "unchanged") : games.wrote ? "written" : "unchanged";
  return { step: "summer_games", ok: true, status, path: games.path };
}

function skillsStepResult(skills: SkillSetupResult, error: SetupStepError | undefined): SetupStep {
  if (skills.status === "failed") {
    return {
      step: "skills",
      ok: false,
      status: "failed",
      error: error ?? { code: "skills_install_failed", message: [skills.message, skills.stderr].filter(Boolean).join(" ") },
    };
  }
  return { step: "skills", ok: true, status: skills.status, ...(skills.destination ? { path: skills.destination } : {}) };
}

function projectFilesStep(project: ProjectFiles | null, error: SetupStepError | undefined, opts: SetupCommandOptions): SetupStep {
  if (error) return { step: "project_files", ok: false, status: "failed", error };
  if (!project) {
    const skipped = opts.projectFiles === false || opts.print || opts.assetsOnly;
    return { step: "project_files", ok: true, status: skipped ? "skipped" : "not_in_project" };
  }
  // A file setup leaves alone (a link out of the project, a broken Summer block) is a warning, as in the human output.
  const warnings = project.files.filter((file) => file.reason).map((file) => `${file.path}: ${file.reason}`);
  return { step: "project_files", ok: true, status: project.written ? "written" : "planned", path: project.root, ...(warnings.length ? { warnings } : {}) };
}

function doctorStep(doctor: DoctorResult): SetupStep {
  if (doctor.ok) return { step: "doctor", ok: true, status: "passed" };
  const failed = doctor.checks.filter((check) => check.status === "fail");
  return {
    step: "doctor",
    ok: false,
    status: "failed",
    error: { code: "doctor_failed", message: failed.map((check) => `${check.label}: ${check.message}`).join("; ") || "Doctor found a problem." },
  };
}

/** `summer setup --detect`: every agent, installed or not, and whether it is linked. Writes nothing. */
function runDetect(agentArg: string | undefined, opts: SetupCommandOptions): void {
  if (agentArg || opts.agent) {
    const message = "--detect lists every agent; leave out the agent name.";
    if (!opts.json) throw new Error(message);
    console.log(JSON.stringify({ ok: false, error: { code: "invalid_option", message }, agents: [] }, null, 2));
    process.exit(1);
    return;
  }
  const agents = detectAgents();
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, os: process.platform, agents }, null, 2));
    return;
  }
  console.log("");
  for (const agent of agents) {
    if (agent.status === "legacy" && !agent.installed) continue;
    const mark = agent.installed ? sym.ok() : c.dim("-");
    const linked = agent.mcpEntry ? c.dim(`linked  ${tildeify(agent.configPath)}`) : agent.installed ? c.dim(`not linked: summer setup ${agent.id}`) : c.dim("not found");
    console.log(`  ${mark}  ${agent.label}  ${linked}`);
  }
}

/**
 * `summer setup <agent> --cli`: the skills (the asset skills with --assets-only)
 * and no MCP server, so the agent runs Summer as `summer <area> <action>` in its
 * shell. Writes no agent config file; an existing summer-engine entry from an
 * earlier setup is left as it is and named in a warning.
 */
async function setupCliOnly(agent: SupportedAgent, scope: ConfigScope, opts: SetupCommandOptions): Promise<void> {
  const spec = agentSpec(agent);
  const mcpFlags = MCP_ENTRY_FLAGS.filter(([key]) => opts[key] !== undefined && opts[key] !== false).map(([, flag]) => flag);
  if (mcpFlags.length > 0) {
    throw new SetupError("invalid_option", `${mcpFlags.join(", ")} sets up the MCP entry, and --cli writes none. Leave ${mcpFlags.length === 1 ? "it" : "them"} out, or leave out --cli.`);
  }
  const refusal = cliSetupRefusal(spec);
  if (refusal) throw new Error(refusal);

  const warnings = spec.status === "legacy" && spec.legacyNote ? [spec.legacyNote] : [];
  const existing = await recordedMcpEntry(agent, scope);
  if (existing) {
    warnings.push(`${tildeify(existing)} still lists the summer-engine MCP server from an earlier setup. Remove that entry to use the CLI only.`);
  }
  const shadow = staleSummerOnPath();
  if (shadow) warnings.push(shadow);

  const dryRun = Boolean(opts.dryRun);
  const skills = setupSkills(agent, {
    dryRun,
    yes: Boolean(opts.yes),
    force: Boolean(opts.force),
    scope,
    recommended: Boolean(opts.recommended),
    stableOnly: Boolean(opts.stableOnly),
    assetsOnly: Boolean(opts.assetsOnly),
    commands: false,
  });
  // Read-only and dry-run summer commands run without asking, where the agent has clean allow rules.
  // Opt-in: the flag is in the command the person approves.
  let allowRules: AllowRulesResult | null = null;
  if (opts.allowRules && !supportsAllowRules(agent)) {
    warnings.push(`--allow-rules is for Claude Code and Codex; ${agentLabel(agent)} manages command approvals in its own settings.`);
  } else if (opts.allowRules) {
    try {
      allowRules = await addAllowRules(agent, allowRulesPath(agent, scope, defaultPathContext()), Boolean(opts.yes) && !dryRun);
      const shared = agent === "claude-code" && scope === "project" ? notGitIgnored(allowRules.path) : false;
      if (shared) warnings.push(`${tildeify(allowRules.path)} is not in .gitignore, so git would share these personal allow rules. Add .claude/settings.local.json to .gitignore.`);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }
  const projectFiles = setupProjectInstructions(opts);
  const doctor = await runDoctor({ quiet: true });
  const ok = doctor.ok && skills.status !== "failed";

  if (opts.json) {
    console.log(JSON.stringify({ ok, mcp: false, agent, scope, config: null, games: null, existingMcpEntry: existing, skills, allowRules, projectFiles, doctor, warnings }, null, 2));
  } else {
    const label = agentLabel(agent);
    console.log("");
    console.log(brandLine(cliVersion));
    console.log("");
    console.log(`  ${dryRun ? c.dim("(dry run)") : sym.ok()}  ${c.bold(`CLI only for ${label}`)}: no MCP server`);
    console.log(`     ${c.dim("The agent runs Summer in its shell: summer <area> <action>, or npx -y summer-engine@latest <area> <action>. The summer-cli skill teaches it.")}`);
    printSkillsLine(skills, dryRun);
    if (allowRules) printAllowRules(allowRules, label, Boolean(opts.yes) && !dryRun);
    else if (supportsAllowRules(agent) && !opts.allowRules) {
      console.log(`  ${sym.arrow()}  ${c.dim(`${label} asks before each summer command. To run read-only and dry-run ones without asking: summer setup ${agent} --cli --allow-rules --yes (it prints every rule).`)}`);
    }
    printProjectFiles(projectFiles);
    for (const warning of warnings) console.log(`  ${sym.warn()}  ${c.yellow(warning)}`);
    console.log("");
    printDoctorResult(doctor);
    if (ok && !dryRun) printTryIt(label, Boolean(opts.assetsOnly));
  }
  if (!ok) process.exit(1);
}

/** The allow rules, each on its line: what the agent now runs without asking, or would with --yes. */
function printAllowRules(result: AllowRulesResult, label: string, write: boolean): void {
  const where = c.dim(tildeify(result.path));
  if (!write) {
    console.log(`  ${sym.arrow()}  ${label} would run these summer commands without asking. Add them: run the same command with --yes.  ${where}`);
  } else if (result.changed.length === 0) {
    console.log(`  ${sym.ok()}  ${label} already runs read-only and dry-run summer commands without asking  ${where}`);
    return;
  } else {
    console.log(`  ${sym.ok()}  ${label} runs these summer commands without asking (${result.changed.length} rules added)  ${where}`);
  }
  for (const rule of result.rules) console.log(`     ${c.dim(rule)}`);
  console.log(`     ${c.dim("Changes, publishing, prices, deletes and messages still ask. jobs wait and assets get save the files they name. Put --dry-run right after the action: summer assets generate-image --dry-run --prompt ... Undo: --remove-allow-rules")}`);
}

/** True when `path` sits in a git repository that does not ignore it (false outside git, or without git). */
export function notGitIgnored(path: string, cwd: string = process.cwd()): boolean {
  const run = (args: string[]) => spawnSync("git", args, { cwd, stdio: "ignore" }).status;
  if (run(["rev-parse", "--is-inside-work-tree"]) !== 0) return false;
  return run(["check-ignore", "-q", relative(cwd, path)]) === 1;
}

/** `summer setup <agent> --remove-allow-rules`: take out exactly the rules --allow-rules added. */
async function removeCliAllowRules(agent: SupportedAgent, scope: ConfigScope, opts: SetupCommandOptions): Promise<void> {
  if (!supportsAllowRules(agent)) throw new Error(`--remove-allow-rules is for Claude Code and Codex; Summer adds no allow rules for ${agentLabel(agent)}.`);
  const result = await removeAllowRules(agent, allowRulesPath(agent, scope, defaultPathContext()), !opts.dryRun);
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, agent, scope, allowRules: result }, null, 2));
    return;
  }
  const where = c.dim(tildeify(result.path));
  if (result.changed.length === 0) console.log(`  ${sym.ok()}  No Summer allow rules for ${agentLabel(agent)}  ${where}`);
  else console.log(`  ${opts.dryRun ? c.dim("(dry run)") : sym.ok()}  ${opts.dryRun ? "Would remove" : "Removed"} ${result.changed.length} Summer allow rules for ${agentLabel(agent)}  ${where}`);
}

/**
 * Inside a Summer project (findSetupProjectRoot: project.godot at or above the
 * working directory, no higher than the git top level, never home): its
 * AGENTS.md and CLAUDE.md, added when missing and never overwritten
 * (project-memory/agent-instructions.ts). Like the skills, they are only
 * planned without --yes. Null outside a project, with --no-project-files,
 * --print, and --assets-only (the block is about building in Summer Engine).
 */
function setupProjectInstructions(opts: SetupCommandOptions): ProjectFiles | null {
  if (opts.projectFiles === false || opts.print || opts.assetsOnly) return null;
  const root = findSetupProjectRoot();
  if (!root) return null;
  const dryRun = Boolean(opts.dryRun);
  const written = Boolean(opts.yes) && !dryRun;
  return { root, written, dryRun, files: writeAgentInstructions(root, { dryRun: !written }) };
}

function printProjectFiles(project: ProjectFiles | null): void {
  if (!project) return;
  const changed = project.files.filter((file) => file.action === "created" || file.action === "added" || file.action === "updated");
  if (changed.length) {
    const where = c.dim(changed.map((file) => tildeify(file.path)).join(", "));
    if (project.written) console.log(`  ${sym.ok()}  Added the Summer instructions for agents  ${where}`);
    else if (project.dryRun) console.log(`  ${c.dim("(dry run)")}  Would add the Summer instructions for agents  ${where}`);
    else console.log(`  ${sym.warn()}  Instructions for agents not added. Run the same setup command again with --yes to add them  ${where}`);
  }
  for (const file of project.files) {
    if (!file.reason) continue;
    const what = file.action === "skipped" ? "not written" : "left as it is";
    console.log(`  ${sym.warn()}  ${c.yellow(`${tildeify(file.path)} ${what}: ${file.reason}`)}`);
  }
}

/** An older summer-engine first on PATH would run instead of this one after setup (`summer login`). */
function staleSummerOnPath(): string | null {
  try {
    const found = findShadowingSummer(cliVersion);
    return found ? shadowWarning(found, cliVersion) : null;
  } catch {
    return null;
  }
}

/** The config file that already lists summer-engine for this agent and scope, or null. */
async function recordedMcpEntry(agent: SupportedAgent, scope: ConfigScope): Promise<string | null> {
  try {
    const target = await configureAgentMcp({ agent, scope, print: true });
    if (!existsSync(target.path)) return null;
    return listsSummerEngine(readFileSync(target.path, "utf-8"), target.format) ? target.path : null;
  } catch {
    return null;
  }
}

/** --assets-only means the assets profile; --profile must name a profile and agree with it. */
function resolveSetupProfile(opts: SetupCommandOptions): Profile | undefined {
  const profile = opts.profile === undefined ? undefined : parseProfile(opts.profile);
  if (profile === null) {
    throw new SetupError("invalid_option", `Unknown --profile "${opts.profile}". Use one of: ${Object.keys(PROFILES).join(", ")}.`);
  }
  if (opts.assetsOnly) {
    if (profile && profile !== "assets") throw new SetupError("invalid_option", "--assets-only uses the assets profile; leave out --profile.");
    return "assets";
  }
  return profile;
}

function printSetupResult(
  config: Awaited<ReturnType<typeof configureAgentMcp>>,
  games: Awaited<ReturnType<typeof configureSummerGamesMcp>>,
  skills: SkillSetupResult,
  doctor: DoctorResult,
  projectFiles: ProjectFiles | null,
  shadow: string | null = null
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
  if (config.runtime) {
    console.log(
      `  ${c.dim("(bundled runtime)")}  MCP server command: ${c.dim(`${config.server.command} ${config.server.args.join(" ")}`)}`
    );
  } else if (config.localDev) {
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

  printSkillsLine(skills, config.dryRun);
  printProjectFiles(projectFiles);

  for (const warning of shadow ? [...config.warnings, shadow] : config.warnings) {
    console.log(`  ${sym.warn()}  ${c.yellow(warning)}`);
  }

  console.log("");
  printDoctorResult(doctor);

  if (doctor.ok && skills.status !== "failed" && !config.dryRun) printTryIt(label, config.profile === "assets");
}

function printTryIt(label: string, assets: boolean): void {
  console.log("");
  const ask = assets ? "make a sword clash sound effect" : "add a DirectionalLight3D and Camera3D to my scene";
  console.log(`${c.dim("Try it:")} open ${label} and ask: ${c.bold(`"${ask}"`)}`);
}

function printSkillsLine(skills: SkillSetupResult, dryRun: boolean): void {
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
  } else if (skills.status === "planned" && dryRun) {
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
