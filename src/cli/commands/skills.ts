import { Command, Option } from "commander";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  cpSync,
  rmSync,
  writeFileSync,
  readdirSync,
  copyFileSync,
} from "fs";
import { join, dirname } from "path";
import { homedir, platform } from "os";
import {
  AGENT_CLIENTS,
  getSkillRegistry,
  resolveSkillDir,
  selectSkillsForBulkInstall,
  type AgentClient,
  type SkillRegistryEntry,
} from "../../core/skills-registry.js";
import { tildeify } from "../../core/format.js";
import { writeSkillMarker } from "../../installer/version-check.js";
import {
  resolveInstallLocation,
  resolveSkillAgent,
  resolveSkillScope,
  type InstallLocation,
  type SkillScope,
} from "../../installer/skill-locations.js";

import { PACKAGE_ROOT } from "../../core/package-root.js";
import { TOOLKIT_VERSION as cliVersion } from "../../core/version.js";

// Skill files live in library/skills/<slug>/ and are resolved through the
// generated registry (registry/generated/skills-registry.json).
// Resolve commands dir: from dist/cli/commands/skills.js -> ../../../commands.
// Used by Claude Code installs to also copy
// slash commands (e.g. /gameskill) to ~/.claude/commands/. Other agents don't
// have an equivalent today, so the copy is gated to claude-code.
const commandsDir = join(PACKAGE_ROOT, "commands");


type SkillMeta = SkillRegistryEntry;

interface InstallOptions {
  all?: boolean;
  recommended?: boolean;
  stableOnly?: boolean;
  /** Hidden no-op alias kept for one release; preview skills install by default now. */
  includePreview?: boolean;
  agent?: string;
  scope?: string;
  asClaudeSkill?: boolean;
  asCursorSkill?: boolean;
  force?: boolean;
}

interface InstallResult {
  action: "Installed" | "Updated" | "Generated";
  path: string;
}

function getBuiltinSkills(): SkillMeta[] {
  return getSkillRegistry().filter((entry) =>
    existsSync(join(resolveSkillDir(entry), "SKILL.md"))
  );
}

function getSkillMeta(name: string): SkillMeta | null {
  return getBuiltinSkills().find((skill) => skill.name === name) ?? null;
}

function getSkillPath(name: string): string | null {
  const entry = getSkillRegistry().find((s) => s.name === name);
  if (!entry) return null;
  const path = resolveSkillDir(entry);
  if (!existsSync(path) || !existsSync(join(path, "SKILL.md"))) return null;
  return path;
}

function getSkillBody(name: string): string {
  const path = getSkillPath(name);
  if (!path) throw new Error(`Unknown skill: ${name}`);
  const content = readFileSync(join(path, "SKILL.md"), "utf-8");
  return content.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "").trim();
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Run an installer-layer option parser; its Error message becomes the CLI's exit line. */
function orDie<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
}

function agentLabel(agent: AgentClient): string {
  switch (agent) {
    case "claude-code":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
    case "windsurf":
      return "Devin Desktop (Windsurf)";
    case "cline":
      return "Cline";
    case "roo-code":
      return "Roo Code";
    case "kilo-code":
      return "Kilo Code";
    case "gemini":
      return "Gemini CLI";
    case "github-copilot":
      return "GitHub Copilot CLI";
    case "vscode-copilot":
      return "GitHub Copilot in VS Code";
    case "opencode":
      return "OpenCode";
    case "summer":
      return "Summer";
  }
}

function previewSkippedLine(count: number): string {
  return `  Skipped ${count} preview skill${count === 1 ? "" : "s"} (--stable-only).`;
}

function previewIncludedLine(count: number): string {
  return `  ${count} preview skill${count === 1 ? "" : "s"} included — labelled in ${count === 1 ? "its" : "each skill's"} guidance; add --stable-only to skip.`;
}

function selectSkills(
  name: string | undefined,
  opts: InstallOptions
): { skills: SkillMeta[]; previewIncluded: number; previewSkipped: number } {
  if (opts.all && opts.recommended) {
    die("Use only one bulk option: --all or --recommended.");
  }
  if (name && (opts.all || opts.recommended)) {
    die("Specify either a skill name or a bulk option, not both.");
  }

  const skills = getBuiltinSkills();
  if (opts.all || opts.recommended) {
    // Bulk installs take stable and preview skills (preview is a label, not a
    // gate); --stable-only skips preview. An explicit name below installs
    // regardless of status.
    const { selected, previewIncluded, previewSkipped } = selectSkillsForBulkInstall(skills, {
      recommended: Boolean(opts.recommended),
      stableOnly: Boolean(opts.stableOnly),
    });
    return { skills: selected, previewIncluded, previewSkipped };
  }

  if (!name) {
    console.error(
      "Specify a skill name, --recommended, or --all."
    );
    printAvailableSkillNames();
    process.exit(1);
  }

  const skill = skills.find((candidate) => candidate.name === name);
  if (!skill) {
    console.error(`Unknown skill: ${name}`);
    printAvailableSkillNames();
    process.exit(1);
  }

  return { skills: [skill], previewIncluded: 0, previewSkipped: 0 };
}

function printAvailableSkillNames(): void {
  const skills = getBuiltinSkills();
  if (skills.length === 0) return;
  console.log("\nAvailable skills:");
  for (const skill of skills) {
    console.log(`  ${skill.name}`);
  }
}

function installSkill(
  skill: SkillMeta,
  agent: AgentClient,
  location: InstallLocation,
  options: { force: boolean }
): InstallResult {
  // Every library skill supports every agent client (registry clients: "all").
  switch (location.kind) {
    case "skill-dir":
      return copySkillDirectory(skill, location.path, options);
    case "cursor-rule-dir":
      return writeCursorRule(skill, location.path);
    case "windsurf-rule-file":
      return upsertWindsurfRule(skill, location.path);
    case "cline-rule-dir":
      return writeClineRule(skill, location.path);
    case "opencode-skill-dir":
      return writeOpencodeSkill(skill, location.path);
  }
}

function copySkillDirectory(
  skill: SkillMeta,
  targetDir: string,
  options: { force: boolean }
): InstallResult {
  const src = getSkillPath(skill.name);
  if (!src) die(`Skill files missing: ${skill.name}`);
  mkdirSync(targetDir, { recursive: true });
  const dest = join(targetDir, skill.name);
  const existed = existsSync(dest);
  if (options.force && existed) {
    // Wipe stale skill content so re-installs overwrite cleanly even if files
    // were renamed or removed upstream.
    rmSync(dest, { recursive: true, force: true });
  }
  cpSync(src, dest, { recursive: true, force: true });
  return { action: existed ? "Updated" : "Installed", path: dest };
}

function writeCursorRule(skill: SkillMeta, rulesDir: string): InstallResult {
  mkdirSync(rulesDir, { recursive: true });
  const rulePath = join(rulesDir, `summer-${skill.name}.mdc`);
  writeFileSync(rulePath, renderCursorRule(skill), "utf-8");
  return { action: "Generated", path: rulePath };
}

function upsertWindsurfRule(skill: SkillMeta, rulePath: string): InstallResult {
  mkdirSync(dirname(rulePath), { recursive: true });
  const start = `<!-- summer-skill:start:${skill.name} -->`;
  const end = `<!-- summer-skill:end:${skill.name} -->`;
  const block = `${start}\n${renderWindsurfRule(skill)}\n${end}`;
  const existing = existsSync(rulePath) ? readFileSync(rulePath, "utf-8") : "";
  const pattern = new RegExp(
    `${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`
  );
  const next = pattern.test(existing)
    ? existing.replace(pattern, block)
    : `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${block}\n`;

  writeFileSync(rulePath, next, "utf-8");
  return { action: "Generated", path: rulePath };
}

function writeClineRule(skill: SkillMeta, rulesDir: string): InstallResult {
  // Cline + Roo Code read project rules from .clinerules/ and global rules
  // from Documents/Cline (or Roo)/Rules. Both expect plain markdown files.
  // SKILL.md isn't recognized as a special filename, so we name files <skill>.md.
  mkdirSync(rulesDir, { recursive: true });
  const rulePath = join(rulesDir, `summer-${skill.name}.md`);
  writeFileSync(rulePath, renderRuleBody(skill) + "\n", "utf-8");
  return { action: "Generated", path: rulePath };
}

function writeOpencodeSkill(skill: SkillMeta, skillsDir: string): InstallResult {
  // OpenCode supports agent markdown definitions; the exact discovery
  // convention for ad-hoc skills isn't fully documented. We write each skill
  // as a markdown file under agents/summer/ so OpenCode can reference them
  // directly. The install summary shows the path.
  mkdirSync(skillsDir, { recursive: true });
  const rulePath = join(skillsDir, `${skill.name}.md`);
  writeFileSync(rulePath, renderRuleBody(skill) + "\n", "utf-8");
  return { action: "Generated", path: rulePath };
}

function renderCursorRule(skill: SkillMeta): string {
  const description = `Summer skill ${skill.name}: ${skill.description}`;
  return `---\ndescription: ${JSON.stringify(description)}\nglobs: []\nalwaysApply: false\n---\n\n${renderRuleBody(skill)}\n`;
}

function renderWindsurfRule(skill: SkillMeta): string {
  return renderRuleBody(skill);
}

function renderRuleBody(skill: SkillMeta): string {
  return `# Summer skill: ${skill.name}

${skill.description}

Use Summer MCP tools for project files, scenes, editor state, assets, play, and diagnostics. Read project text with summer_read_file and mutate it with summer_replace_text or guarded summer_write_file.

## Skill

${getSkillBody(skill.name)}
`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function printInstallSummary(
  count: number,
  agent: AgentClient,
  scope: SkillScope,
  location: InstallLocation
): void {
  const label = agentLabel(agent);
  const tildeified = tildeify(location.path);
  console.log(`\n${count} skill${count === 1 ? "" : "s"} ready for ${label} (${scope} scope).`);

  if (location.kind === "skill-dir") {
    console.log(`${label} can read skills from ${tildeified}/<skill>/SKILL.md`);
    if (agent === "gemini") {
      console.log(
        "Gemini loads them as extension skills; run `summer setup gemini` once so the extension manifest exists, then restart Gemini CLI."
      );
    }
  } else if (location.kind === "cursor-rule-dir") {
    console.log(`Cursor rules are in ${tildeified}/summer-<skill>.mdc`);
  } else if (location.kind === "cline-rule-dir") {
    console.log(`${label} rules are in ${tildeified}/summer-<skill>.md`);
    console.log("Restart VS Code to pick up new rules.");
  } else if (location.kind === "opencode-skill-dir") {
    console.log(`Skill files are in ${tildeified}/<skill>.md`);
    console.log("Restart OpenCode so it picks up the new agent definitions.");
  } else {
    console.log(`Devin Desktop (formerly Windsurf) rules are in ${tildeified}`);
  }
}

export const skillsCommand = new Command("skills")
  .description("Install and manage best-practice guides for AI agents building games")
  .action(() => {
    skillsCommand.outputHelp();
  });

skillsCommand
  .command("list")
  .description("List available skills")
  .action(() => {
    const skills = getBuiltinSkills();
    if (skills.length === 0) {
      console.log("No skills found.");
      return;
    }
    console.log("Available public skills:\n");
    for (const s of skills) {
      const badge = s.recommended ? "recommended" : "optional";
      const tag = s.status === "preview" ? "[preview] " : "";
      console.log(
        `  ${s.name.padEnd(24)} ${badge.padEnd(11)} ${tag}${s.description}`
      );
    }
    const previewCount = skills.filter((s) => s.status === "preview").length;
    if (previewCount > 0) {
      console.log(
        `\n[preview] = not yet exercised in-engine by the Summer team (${previewCount}); labelled in the skill's guidance. --all / --recommended and summer setup install these like any other skill — add --stable-only to skip them.`
      );
    }
    console.log("\nInstall recommended: summer skills install --recommended");
    console.log("Install one:         summer skills install <name>");
    console.log(`Agents:              ${AGENT_CLIENTS.join(", ")}`);
  });

skillsCommand
  .command("install [name]")
  .description("Install Summer skills for a target agent")
  .option("--all", "Install all available skills")
  .option(
    "--recommended",
    "Install only the recommended skill subset (summer setup installs all by default)"
  )
  .option(
    "--stable-only",
    "With --all / --recommended, skip preview skills (installed by default; labelled preview in their guidance)"
  )
  .option(
    "--agent <agent>",
    `Target agent: ${AGENT_CLIENTS.join("|")}`
  )
  .option(
    "--scope <scope>",
    "Install scope: user or project"
  )
  // Legacy aliases: still accepted for old scripts, hidden from --help.
  .addOption(new Option("--as-claude-skill", "Legacy alias for --agent claude-code").hideHelp())
  .addOption(new Option("--as-cursor-skill", "Legacy alias for --agent cursor").hideHelp())
  // Pre-reversal opt-in, kept one release as a hidden no-op so old scripts still parse.
  .addOption(new Option("--include-preview", "No-op: preview skills install by default").hideHelp())
  .option(
    "--force",
    "Overwrite existing skill files (wipe stale skill dirs before copying)"
  )
  .action((name: string | undefined, opts: InstallOptions) => {
    const agent = orDie(() => resolveSkillAgent(opts));
    const scope = orDie(() => resolveSkillScope(agent, opts));
    const location = resolveInstallLocation(agent, scope);
    const { skills, previewIncluded, previewSkipped } = selectSkills(name, opts);

    if (skills.length === 0) {
      console.log("No skills found.");
      if (previewSkipped > 0) console.log(previewSkippedLine(previewSkipped));
      return;
    }

    for (const skill of skills) {
      const result = installSkill(skill, agent, location, {
        force: Boolean(opts.force),
      });
      // Keep this line's shape: setup tallies it (Installed|Updated|Generated <name> -> <path>).
      console.log(`  ${result.action} ${skill.name} -> ${result.path}`);
    }
    if (name && skills[0]?.status === "preview") {
      console.log(
        `  Note: ${name} is a preview skill — not yet exercised in-engine by the Summer team; its guidance says so.`
      );
    }
    if (previewIncluded > 0) console.log(previewIncludedLine(previewIncluded));
    if (previewSkipped > 0) console.log(previewSkippedLine(previewSkipped));

    // Claude Code: also install slash commands (`tools/summer-cli/commands/*.md`)
    // into `~/.claude/commands/`. Other agents don't have an equivalent today.
    if (agent === "claude-code") {
      const commandResults = installClaudeCommands(scope, Boolean(opts.force));
      for (const r of commandResults) {
        console.log(`  ${r.action} command ${r.name} -> ${r.path}`);
      }
    }

    writeMarkerForLocation(location);
    printInstallSummary(skills.length, agent, scope, location);
  });

/**
 * Copy every `.md` file in `tools/summer-cli/commands/` to the user's
 * `~/.claude/commands/` directory so the slash commands (e.g. `/gameskill`)
 * are available on every machine that runs `summer skills install`.
 *
 * Project-scope installs go to `<cwd>/.claude/commands/`. Returns one result
 * per command file copied. Silent no-op if no commands directory exists in
 * the package (older summer-cli releases didn't ship one).
 */
function installClaudeCommands(
  scope: SkillScope,
  force: boolean
): Array<{ action: string; name: string; path: string }> {
  if (!existsSync(commandsDir)) return [];
  const root = scope === "user" ? homedir() : process.cwd();
  const targetDir = join(root, ".claude", "commands");
  mkdirSync(targetDir, { recursive: true });
  const results: Array<{ action: string; name: string; path: string }> = [];
  for (const entry of readdirSync(commandsDir)) {
    if (!entry.endsWith(".md")) continue;
    const src = join(commandsDir, entry);
    const dest = join(targetDir, entry);
    if (existsSync(dest) && !force) {
      results.push({ action: "Kept", name: entry, path: dest });
      continue;
    }
    copyFileSync(src, dest);
    results.push({ action: "Installed", name: entry, path: dest });
  }
  return results;
}

/**
 * Drop a `.summer-version` marker into the install dir so doctor's
 * `skills-version-stale` check can detect drift later. Devin Desktop (formerly Windsurf) writes a
 * single rules file with no surrounding dir, so we skip it there.
 */
function writeMarkerForLocation(location: InstallLocation): void {
  if (location.kind === "windsurf-rule-file") return;
  try {
    mkdirSync(location.path, { recursive: true });
    writeSkillMarker(location.path, cliVersion);
  } catch {
    // Marker is purely informational. If the FS rejects it (e.g. permission
    // surprises on locked-down corp machines) we don't want to fail the install.
  }
}

skillsCommand
  .command("info <name>")
  .description("Show skill description and preview")
  .action((name: string) => {
    const meta = getSkillMeta(name);
    if (!meta) {
      console.error(`Unknown skill: ${name}`);
      process.exit(1);
    }
    const src = getSkillPath(name);
    if (!src) die(`Skill files missing: ${name}`);
    const skillPath = join(src, "SKILL.md");
    const content = readFileSync(skillPath, "utf-8");
    console.log(`\n${meta.name}`);
    console.log("-".repeat(40));
    console.log(meta.description);
    console.log(`Id: ${meta.id}`);
    console.log(`Recommended: ${meta.recommended ? "yes" : "no"}`);
    console.log(`Status: ${meta.status}`);
    console.log(`Agents: ${AGENT_CLIENTS.join(", ")}`);
    console.log("\n" + "-".repeat(40));
    const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "");
    const preview = body.split("\n").slice(0, 30).join("\n");
    console.log(preview);
    if (body.split("\n").length > 30) {
      console.log("\n...");
    }
  });
