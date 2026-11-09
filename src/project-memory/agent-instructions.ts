import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, parse, relative, resolve, isAbsolute } from "path";
import { PACKAGE_ROOT } from "../core/package-root.js";

/**
 * AGENTS.md and CLAUDE.md in a Summer project. AGENTS.md is the one file
 * Codex, Cursor, Copilot, Amp and other agents read in every session;
 * Claude Code reads CLAUDE.md, which here only imports AGENTS.md.
 * `summer create` writes both; `summer setup --yes` inside a project adds
 * them when missing.
 *
 * An existing file is never overwritten: Summer adds one marked block once,
 * and later runs replace only that block. A link is followed only to a file
 * inside the project, and a CLAUDE.md that is the same file as AGENTS.md
 * gets the AGENTS.md block only. The five commands are the list in the
 * summer-cli skill (between its project-commands markers), so the two
 * cannot drift; the skill's test runs every command both of them teach.
 */

export const SUMMER_BLOCK_START = "<!-- summer-engine:start. summer setup updates only this block; write your own notes outside it. -->";
export const SUMMER_BLOCK_END = "<!-- summer-engine:end -->";
const CLAUDE_IMPORTS = new Set(["@AGENTS.md", "@./AGENTS.md"]);

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
    "## First game: make it look finished",
    "",
    "People judge Summer by the first frame of their first game, so make it look finished even when they ask for a quick prototype. Keep the features they asked for and raise the look:",
    "- sky and sun with shadows, tonemapping, a little fog;",
    "- a texture on every surface, and real models for the player, characters and main props (the starter project and the Summer asset library first), never capsules or boxes as final art;",
    "- one colour palette and a styled UI font.",
    "Before you say it is ready, play it and look at a screenshot of the running game, not the editor: the editor shows a preview sky and sun that the game does not have.",
    "",
    "## How to work on it",
    "",
    "- Write GDScript (`.gd`) files directly. Create and change scenes and import assets through Summer while Summer Engine has the project open: it imports new files, and the editor rewrites `.tscn` files when it saves, so hand edits to an open scene get lost.",
    "- With Summer's MCP server, use the `summer_*` tools; `summer_get_project_context` tells you which project you are connected to. Without it, run the same operations as `summer` commands in the shell (the `summer-cli` skill). If `summer` is missing or older than 4.0, use `npx -y summer-engine@latest` in its place.",
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
    "The `publish-your-game` skill has the steps; `summer ops search \"publish my game\"` finds each operation. Going live needs the game owner's yes. A game goes live as soon as Summer's automated checks pass; Summer's staff review it after it is live, so never tell anyone to wait for a review.",
    SUMMER_BLOCK_END,
  ].join("\n");
}

export type InstructionAction = "created" | "added" | "updated" | "unchanged" | "skipped";

export interface InstructionFileResult {
  file: "AGENTS.md" | "CLAUDE.md";
  path: string;
  action: InstructionAction;
  /** Why a file was skipped or left as it is. */
  reason?: string;
}

/** The text with `block` as its Summer block: replaced where it is, else appended. Keeps the file's line endings. */
function withBlock(text: string, block: string): { text: string; action: InstructionAction; reason?: string } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const ours = block.replace(/\r?\n/g, eol);
  const start = text.indexOf(SUMMER_BLOCK_START);
  if (start === -1) {
    // Only trailing line breaks change outside the block; an empty file is the block alone.
    return { text: text.trim() ? `${text.replace(/(\r?\n)*$/, eol)}${eol}${ours}${eol}` : `${ours}${eol}`, action: "added" };
  }
  const end = text.indexOf(SUMMER_BLOCK_END, start);
  if (end === -1) return { text, action: "skipped", reason: "its Summer block has no end marker" };
  // Two blocks (a merge, or the markers quoted in the person's text): which
  // one is Summer's is not knowable, so the person picks; nothing is deleted.
  if (text.indexOf(SUMMER_BLOCK_START, end) !== -1) return { text, action: "skipped", reason: "it has two Summer blocks; delete one and run setup again" };
  const next = `${text.slice(0, start)}${ours}${text.slice(end + SUMMER_BLOCK_END.length)}`;
  return { text: next, action: next === text ? "unchanged" : "updated" };
}

/** Does the text import AGENTS.md on a line of its own, outside code fences? */
function importsAgents(text: string): boolean {
  let fence = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) fence = !fence;
    else if (!fence && CLAUDE_IMPORTS.has(trimmed)) return true;
  }
  return false;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Where a file may be written, and `real`, the file a write lands in:
 * "missing" (create it: here, or the missing target of a link inside the
 * project), "file" (a file, or a link to one inside the project), or a
 * reason to leave it alone (a link that points nowhere or out of the
 * project). `real` is known before anything is written, so a link from one
 * name to the other counts as one file even when its target is missing.
 */
function locate(path: string, realRoot: string): { kind: "missing" | "file"; real: string } | { kind: "skip"; reason: string } {
  let isLink = false;
  try {
    isLink = lstatSync(path).isSymbolicLink();
  } catch {
    return { kind: "missing", real: join(realRoot, basename(path)) };
  }
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    const target = resolve(realRoot, readlinkSync(path));
    return inside(realRoot, target) ? { kind: "missing", real: target } : { kind: "skip", reason: "it is a link to a file that does not exist" };
  }
  if (isLink && !inside(realRoot, real)) return { kind: "skip", reason: "it is a link to a file outside the project" };
  return { kind: "file", real };
}

/**
 * Write or update AGENTS.md and CLAUDE.md in the project root. A new
 * AGENTS.md is the Summer block; a new CLAUDE.md is `@AGENTS.md` only. An
 * existing CLAUDE.md that already imports AGENTS.md is left as it is. Each
 * file is its own step: a file that cannot be read or written is skipped
 * with the reason, and the other is still done.
 */
export function writeAgentInstructions(projectDir: string, options: { dryRun?: boolean; block?: string } = {}): InstructionFileResult[] {
  const agents = join(projectDir, "AGENTS.md");
  const claude = join(projectDir, "CLAUDE.md");
  let block: string;
  let realRoot: string;
  try {
    block = options.block ?? renderAgentsBlock();
    realRoot = realpathSync(projectDir);
  } catch (error) {
    const reason = messageOf(error);
    return [
      { file: "AGENTS.md", path: agents, action: "skipped", reason },
      { file: "CLAUDE.md", path: claude, action: "skipped", reason },
    ];
  }
  const write = (path: string, text: string) => {
    if (!options.dryRun) writeFileSync(path, text, "utf-8");
  };
  const step = (file: InstructionFileResult["file"], path: string, run: () => Omit<InstructionFileResult, "file" | "path">): InstructionFileResult => {
    try {
      return { file, path, ...run() };
    } catch (error) {
      return { file, path, action: "skipped", reason: messageOf(error) };
    }
  };

  const agentsAt = locate(agents, realRoot);
  const agentsResult = step("AGENTS.md", agents, () => {
    if (agentsAt.kind === "skip") return { action: "skipped", reason: agentsAt.reason };
    if (agentsAt.kind === "missing") {
      write(agents, `${block}\n`);
      return { action: "created" };
    }
    const next = withBlock(readFileSync(agents, "utf-8"), block);
    if (next.action === "added" || next.action === "updated") write(agents, next.text);
    return { action: next.action, ...(next.reason ? { reason: next.reason } : {}) };
  });

  const claudeAt = locate(claude, realRoot);
  const claudeResult = step("CLAUDE.md", claude, () => {
    if (claudeAt.kind === "skip") return { action: "skipped", reason: claudeAt.reason };
    // CLAUDE.md -> AGENTS.md (or the reverse): one file, which already has the AGENTS.md block.
    if (agentsAt.kind !== "skip" && claudeAt.real === agentsAt.real) {
      return { action: "unchanged", reason: "it is the same file as AGENTS.md" };
    }
    if (claudeAt.kind === "missing") {
      write(claude, "@AGENTS.md\n");
      return { action: "created" };
    }
    const text = readFileSync(claude, "utf-8");
    if (importsAgents(text) && !text.includes(SUMMER_BLOCK_START)) return { action: "unchanged" };
    const next = withBlock(text, `${SUMMER_BLOCK_START}\n@AGENTS.md\n${SUMMER_BLOCK_END}`);
    if (next.action === "added" || next.action === "updated") write(claude, next.text);
    return { action: next.action, ...(next.reason ? { reason: next.reason } : {}) };
  });

  return [agentsResult, claudeResult];
}

/**
 * The Summer project the working directory is in, for `summer setup`: the
 * nearest folder with project.godot, looking up no further than the git
 * top level, and never the home folder or the filesystem root (a stray
 * project.godot there must not put an AGENTS.md or CLAUDE.md in every
 * session). Null when there is none.
 */
export function findSetupProjectRoot(cwd: string = process.cwd()): string | null {
  let current: string;
  try {
    current = realpathSync(resolve(cwd));
  } catch {
    return null;
  }
  let home: string;
  try {
    home = realpathSync(homedir());
  } catch {
    home = homedir();
  }
  while (current !== home && current !== parse(current).root) {
    if (existsSync(join(current, "project.godot"))) return current;
    if (existsSync(join(current, ".git"))) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
