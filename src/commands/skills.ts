import { Command } from "commander";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  cpSync,
  writeFileSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import {
  AGENT_CLIENTS,
  SKILL_REGISTRY,
  type AgentClient,
  type SkillRegistryEntry,
} from "../lib/skills-registry.js";
import { tildeify } from "../lib/format.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve skills dir: from dist/commands/skills.js -> ../../skills
const skillsDir = join(__dirname, "..", "..", "skills");

const SKILL_SCOPES = ["user", "project"] as const;
type SkillScope = (typeof SKILL_SCOPES)[number];

interface SkillMeta extends SkillRegistryEntry {
  name: string;
  description: string;
}

interface ParsedSkillFrontmatter {
  name: string;
  description: string;
}

interface InstallOptions {
  all?: boolean;
  recommended?: boolean;
  agent?: string;
  scope?: string;
  asClaudeSkill?: boolean;
  asCursorSkill?: boolean;
}

type InstallLocation =
  | { kind: "skill-dir"; path: string }
  | { kind: "cursor-rule-dir"; path: string }
  | { kind: "windsurf-rule-file"; path: string };

interface InstallResult {
  action: "Installed" | "Generated";
  path: string;
}

function getBuiltinSkills(): SkillMeta[] {
  const skills: SkillMeta[] = [];
  for (const entry of SKILL_REGISTRY) {
    if (!entry.public) continue;
    const skillPath = join(skillsDir, entry.category, entry.name, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    const frontmatter = parseSkillFrontmatter(skillPath);
    if (!frontmatter) continue;
    skills.push({
      ...entry,
      name: entry.name,
      description: frontmatter.description,
    });
  }
  return skills;
}

function parseSkillFrontmatter(skillPath: string): ParsedSkillFrontmatter | null {
  try {
    const content = readFileSync(skillPath, "utf-8");
    const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match) return null;
    const front = match[1];
    const name = front.match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const description = front.match(/^description:\s*(.+)$/m)?.[1]?.trim();
    if (!name || !description) return null;
    return { name, description };
  } catch {
    return null;
  }
}

function getSkillMeta(name: string): SkillMeta | null {
  return getBuiltinSkills().find((skill) => skill.name === name) ?? null;
}

function getSkillPath(name: string): string | null {
  const entry = SKILL_REGISTRY.find((s) => s.name === name);
  if (!entry) return null;
  const path = join(skillsDir, entry.category, entry.name);
  if (!existsSync(path) || !existsSync(join(path, "SKILL.md"))) return null;
  return path;
}

function getSkillBody(name: string): string {
  const entry = SKILL_REGISTRY.find((s) => s.name === name);
  if (!entry) throw new Error(`Unknown skill: ${name}`);
  const skillPath = join(skillsDir, entry.category, entry.name, "SKILL.md");
  const content = readFileSync(skillPath, "utf-8");
  return content.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "").trim();
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

function isAgentClient(value: string): value is AgentClient {
  return (AGENT_CLIENTS as readonly string[]).includes(value);
}

function isSkillScope(value: string): value is SkillScope {
  return (SKILL_SCOPES as readonly string[]).includes(value);
}

function parseAgent(value: string): AgentClient {
  if (isAgentClient(value)) return value;
  die(
    `Unknown agent: ${value}. Use one of: ${AGENT_CLIENTS.join(", ")}.`
  );
}

function parseScope(value: string): SkillScope {
  if (isSkillScope(value)) return value;
  die(`Unknown scope: ${value}. Use user or project.`);
}

function resolveAgent(opts: InstallOptions): AgentClient {
  if (opts.asClaudeSkill && opts.asCursorSkill) {
    die("Use only one legacy alias: --as-claude-skill or --as-cursor-skill.");
  }

  const legacyAgent = opts.asClaudeSkill
    ? "claude-code"
    : opts.asCursorSkill
      ? "cursor"
      : undefined;

  if (opts.agent && legacyAgent && opts.agent !== legacyAgent) {
    die(
      `Conflicting agent options: --agent ${opts.agent} with legacy alias for ${legacyAgent}.`
    );
  }

  return parseAgent(opts.agent ?? legacyAgent ?? "summer");
}

function resolveScope(agent: AgentClient, opts: InstallOptions): SkillScope {
  if (opts.scope) return parseScope(opts.scope);
  if (agent === "cursor" || agent === "windsurf") return "project";
  return "user";
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
      return "Windsurf";
    case "summer":
      return "Summer";
  }
}

function resolveInstallLocation(
  agent: AgentClient,
  scope: SkillScope
): InstallLocation {
  const overrideDir = process.env.SUMMER_SKILLS_DIR;
  if (overrideDir) {
    if (agent === "cursor") return { kind: "cursor-rule-dir", path: overrideDir };
    if (agent === "windsurf") {
      return { kind: "windsurf-rule-file", path: join(overrideDir, ".windsurfrules") };
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
    case "summer":
      return { kind: "skill-dir", path: join(root, ".summer", "skills") };
  }
}

function selectSkills(name: string | undefined, opts: InstallOptions): SkillMeta[] {
  if (opts.all && opts.recommended) {
    die("Use only one bulk option: --all or --recommended.");
  }
  if (name && (opts.all || opts.recommended)) {
    die("Specify either a skill name or a bulk option, not both.");
  }

  const skills = getBuiltinSkills();
  if (opts.all) return skills;
  if (opts.recommended) return skills.filter((skill) => skill.recommended);

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

  return [skill];
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
  location: InstallLocation
): InstallResult {
  if (!skill.clients.includes(agent)) {
    die(`${skill.name} does not support ${agentLabel(agent)}.`);
  }

  switch (location.kind) {
    case "skill-dir":
      return copySkillDirectory(skill, location.path);
    case "cursor-rule-dir":
      return writeCursorRule(skill, location.path);
    case "windsurf-rule-file":
      return upsertWindsurfRule(skill, location.path);
  }
}

function copySkillDirectory(skill: SkillMeta, targetDir: string): InstallResult {
  const src = getSkillPath(skill.name);
  if (!src) die(`Skill files missing: ${skill.name}`);
  mkdirSync(targetDir, { recursive: true });
  const dest = join(targetDir, skill.name);
  cpSync(src, dest, { recursive: true });
  return { action: "Installed", path: dest };
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

Use Summer MCP tools for scene, editor, asset, play, and diagnostics operations. Use the host agent's normal file editing tools for scripts and other text files.

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
  } else if (location.kind === "cursor-rule-dir") {
    console.log(`Cursor rules are in ${tildeified}/summer-<skill>.mdc`);
  } else {
    console.log(`Windsurf rules are in ${tildeified}`);
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
      console.log(
        `  ${s.name.padEnd(20)} ${s.category.padEnd(10)} ${badge.padEnd(11)} ${s.description}`
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
    "Install recommended public skills (excludes make-game)"
  )
  .option(
    "--agent <agent>",
    `Target agent: ${AGENT_CLIENTS.join("|")}`
  )
  .option(
    "--scope <scope>",
    "Install scope: user or project"
  )
  .option(
    "--as-claude-skill",
    "Legacy alias for --agent claude-code"
  )
  .option(
    "--as-cursor-skill",
    "Legacy alias for --agent cursor"
  )
  .action((name: string | undefined, opts: InstallOptions) => {
    const agent = resolveAgent(opts);
    const scope = resolveScope(agent, opts);
    const location = resolveInstallLocation(agent, scope);
    const skills = selectSkills(name, opts);

    if (skills.length === 0) {
      console.log("No skills found.");
      return;
    }

    for (const skill of skills) {
      const result = installSkill(skill, agent, location);
      console.log(`  ${result.action} ${skill.name} -> ${result.path}`);
    }

    printInstallSummary(skills.length, agent, scope, location);
  });

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
    console.log(`Category: ${meta.category}`);
    console.log(`Recommended: ${meta.recommended ? "yes" : "no"}`);
    console.log(`Agents: ${meta.clients.join(", ")}`);
    console.log(
      `MCP tools: ${meta.requiresMcpTools.length > 0 ? meta.requiresMcpTools.join(", ") : "none"}`
    );
    console.log(`Test scenario: ${meta.testScenario}`);
    console.log("\n" + "-".repeat(40));
    const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "");
    const preview = body.split("\n").slice(0, 30).join("\n");
    console.log(preview);
    if (body.split("\n").length > 30) {
      console.log("\n...");
    }
  });
