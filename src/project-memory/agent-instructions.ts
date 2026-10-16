import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { PACKAGE_ROOT } from "../core/package-root.js";

/**
 * AGENTS.md and CLAUDE.md in a Summer project. AGENTS.md is the one file
 * most agents read in every session (Codex, Cursor, Copilot, Gemini, Amp
 * and more); Claude Code reads CLAUDE.md, which here only imports AGENTS.md.
 * `summer create` writes both; `summer setup` inside a project adds them
 * when missing.
 *
 * An existing file is never overwritten: Summer adds one marked block once,
 * and later runs replace only that block. The five commands are the list in
 * the summer-cli skill (between its project-commands markers), so the two
 * cannot drift; the skill's test runs every command both of them teach.
 */

export const SUMMER_BLOCK_START = "<!-- summer-engine:start. summer setup updates only this block; write your own notes outside it. -->";
export const SUMMER_BLOCK_END = "<!-- summer-engine:end -->";
const CLAUDE_IMPORT = "@AGENTS.md";

const SKILL_PATH = ["library", "skills", "summer-cli", "SKILL.md"];
const COMMANDS = /<!-- project-commands[^>]*-->\n([\s\S]*?)\n<!-- \/project-commands -->/;

/** The numbered command list from the summer-cli skill. */
export function projectCommands(skill: string = readFileSync(join(PACKAGE_ROOT, ...SKILL_PATH), "utf-8")): string {
  const match = COMMANDS.exec(skill);
  if (!match) throw new Error("The summer-cli skill has no project-commands list.");
  return match[1]!.trim();
}

/** The Summer block of AGENTS.md, markers included. */
export function renderAgentsBlock(commands: string = projectCommands()): string {
  return [
    SUMMER_BLOCK_START,
    "# Summer Engine game",
    "",
    "This is a game made with Summer Engine, the game engine built for AI. Game code is GDScript (`.gd`), scenes are `.tscn`, resources are `.tres`, and `project.godot` is the project file.",
    "",
    "## How to work on it",
    "",
    "- Change scenes through Summer while Summer Engine has the project open. The editor rewrites `.tscn` files when it saves, so hand edits get lost.",
    "- With Summer's MCP server, call the `summer_*` tools and start with `summer_get_project_context`. Without it, run the same operations as `summer` commands in the shell (the `summer-cli` skill). If `summer` is missing or older than 4.0, use `npx -y summer-engine@latest` in its place.",
    "- Summer's skills teach each part of a game. `npx -y summer-engine@latest setup <agent> --yes` installs them for your agent (add `--cli` for no MCP server). Start with `using-summer`, and find the right one with `summer docs search --query \"<the task>\"`.",
    "- `.summer/` is the project's memory: `GameSoul.md` says what the game is, `memory/` holds the decisions to keep. Read them before you change the game's look, sound or story.",
    "- Check your own work: script errors, a screenshot, a play run. Ask the person to play only for feel and fun.",
    "",
    "## The five commands",
    "",
    commands,
    "",
    "## Publishing",
    "",
    "`summer store publish` sends the game to Summer's store review. The game's owner approves it: give them the link the command prints. Nothing goes live until they approve.",
    SUMMER_BLOCK_END,
  ].join("\n");
}

export type InstructionAction = "created" | "added" | "updated" | "unchanged" | "skipped";

export interface InstructionFileResult {
  file: "AGENTS.md" | "CLAUDE.md";
  path: string;
  action: InstructionAction;
  /** Why a file was skipped. */
  reason?: string;
}

/** `text` with the Summer block set to `block`: replaced where it is, else appended once. */
function withBlock(text: string, block: string): { text: string; action: InstructionAction; reason?: string } {
  const start = text.indexOf(SUMMER_BLOCK_START);
  const end = text.indexOf(SUMMER_BLOCK_END, start);
  if (start !== -1 && end === -1) return { text, action: "skipped", reason: "its Summer block has no end marker" };
  if (start === -1) return { text: `${text.trimEnd()}\n\n${block}\n`, action: "added" };
  const next = `${text.slice(0, start)}${block}${text.slice(end + SUMMER_BLOCK_END.length)}`;
  return { text: next, action: next === text ? "unchanged" : "updated" };
}

/**
 * Write or update AGENTS.md and CLAUDE.md in the project root. A new
 * AGENTS.md is the Summer block; a new CLAUDE.md is `@AGENTS.md` only. An
 * existing CLAUDE.md that already imports AGENTS.md is left as it is.
 */
export function writeAgentInstructions(projectDir: string, options: { dryRun?: boolean; block?: string } = {}): InstructionFileResult[] {
  const block = options.block ?? renderAgentsBlock();
  const write = (path: string, text: string) => {
    if (!options.dryRun) writeFileSync(path, text, "utf-8");
  };
  const results: InstructionFileResult[] = [];

  const agents = join(projectDir, "AGENTS.md");
  if (!existsSync(agents)) {
    write(agents, `${block}\n`);
    results.push({ file: "AGENTS.md", path: agents, action: "created" });
  } else {
    const next = withBlock(readFileSync(agents, "utf-8"), block);
    if (next.action === "added" || next.action === "updated") write(agents, next.text);
    results.push({ file: "AGENTS.md", path: agents, action: next.action, ...(next.reason ? { reason: next.reason } : {}) });
  }

  const claude = join(projectDir, "CLAUDE.md");
  if (!existsSync(claude)) {
    write(claude, `${CLAUDE_IMPORT}\n`);
    results.push({ file: "CLAUDE.md", path: claude, action: "created" });
  } else {
    const text = readFileSync(claude, "utf-8");
    const imports = text.split(/\r?\n/).some((line) => line.trim() === CLAUDE_IMPORT);
    const next = imports && !text.includes(SUMMER_BLOCK_START) ? { text, action: "unchanged" as const } : withBlock(text, `${SUMMER_BLOCK_START}\n${CLAUDE_IMPORT}\n${SUMMER_BLOCK_END}`);
    if (next.action === "added" || next.action === "updated") write(claude, next.text);
    results.push({ file: "CLAUDE.md", path: claude, action: next.action, ...("reason" in next && next.reason ? { reason: next.reason } : {}) });
  }
  return results;
}
