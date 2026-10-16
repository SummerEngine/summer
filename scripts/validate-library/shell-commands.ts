/**
 * The "From a shell" section of a skill: each MCP tool and operation the
 * skill names, with the `summer <area> <action>` command that runs the same
 * operation (src/cli/commands/ops.ts). An agent set up without MCP
 * (`summer setup <agent> --cli`) follows the skill from its shell with it.
 *
 * Written from the operation catalog, never by hand, so it cannot drift: a
 * 3.x tool name maps through registry/operations/legacy-names.json, a 4.0
 * name by the naming rule (`summer_<area>_<action>` runs `area.action`),
 * and an operation written in code (`assets.generate_image`) counts when the
 * catalog knows it. validate-library fails when a SKILL.md section is not the
 * one rendered here, and when a skill names a 4.0 tool whose operation the
 * catalog does not have; `npm run generate:registry` rewrites the section.
 *
 * Names come from every markdown file in the skill folder (SKILL.md and its
 * references/); the section goes at the end of SKILL.md. A root without
 * legacy-names.json (a test fixture) has no catalog, so nothing is checked.
 */

import fs from "node:fs";
import path from "node:path";
import { CLI_AREAS, isLocalOp } from "../../src/core/ops/areas.ts";

export const SHELL_SECTION_START =
  "<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->";
export const SHELL_SECTION_END = "<!-- /shell-commands -->";

const LEGACY_NAMES = path.join("registry", "operations", "legacy-names.json");
/** The skill every section points at; it teaches the commands itself, so it has no section. */
export const SHELL_GUIDE_SKILL = "summer-cli";
const AREAS: ReadonlySet<string> = new Set(CLI_AREAS);
/** 4.0 operations no 3.x tool became, so legacy-names.json has no row for them. */
export const V4_ONLY_OPS: readonly string[] = ["jobs.wait"];

const TOOL_NAME = /\bsummer_[a-z0-9_]*[a-z0-9]\b/g;
/** An operation in code: `assets.generate_image` or `assets.search({ ... })`. */
const OP_IN_CODE = /`([a-z]+\.[a-z][a-z0-9_]*)(?=[`(])/g;
/** An operation as summer_call's op: `op: "docs.workflows"`, `{"op":"docs.feedback"}`. */
const OP_FIELD = /\bop"?\s*:\s*"([a-z]+\.[a-z][a-z0-9_]*)"/g;
const V4_TOOL = /^summer_([a-z]+)_([a-z][a-z0-9_]*)$/;

export interface ShellCatalog {
  /**
   * 3.x tool name -> what it runs, one per action of a split tool: `area.action`
   * plus a fixed input as flags, or `tool <slug>` for the 3.x tool itself.
   */
  tools: Map<string, string[]>;
  /** The operations the catalog has: legacy-names.json and V4_ONLY_OPS. */
  ops: Set<string>;
}

export interface ShellRow {
  /** The names as the skill writes them. */
  names: string[];
  commands: string[];
}

type LegacyRow = { op: string; note?: string };

/** A merged 3.x tool whose note fixes one input (`assets.search {scope: mine}`) runs with that flag. */
const FIXED_INPUT = /^([a-z]+\.[a-z][a-z0-9_]*)\s*\{\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*([\w./:-]+)\s*\}$/;

function callOf(tool: string, row: LegacyRow): string {
  const fixed = FIXED_INPUT.exec(row.note?.trim() ?? "");
  if (!fixed || fixed[1] !== row.op) return row.op;
  // A local operation checks its input here, and the note's may not be one it
  // takes (no library entry is reference/agent-playbook): run the 3.x tool itself.
  return isLocalOp(row.op) ? `tool ${tool.slice("summer_".length).replace(/_/g, "-")}` : `${row.op} --${kebab(fixed[2]!)} ${fixed[3]}`;
}

const kebab = (name: string) => name.replace(/_/g, "-").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

/** The catalog under rootDir, or null when it has none. */
export function loadShellCatalog(rootDir: string): ShellCatalog | null {
  const file = path.join(rootDir, LEGACY_NAMES);
  if (!fs.existsSync(file)) return null;
  const names = (JSON.parse(fs.readFileSync(file, "utf8")) as { names?: Record<string, LegacyRow> }).names ?? {};
  const tools = new Map<string, string[]>();
  for (const [name, row] of Object.entries(names)) {
    const tool = name.split("#")[0]!;
    const calls = tools.get(tool) ?? [];
    if (!calls.includes(callOf(tool, row))) calls.push(callOf(tool, row));
    tools.set(tool, calls);
  }
  return { tools, ops: new Set([...Object.values(names).map((row) => row.op), ...V4_ONLY_OPS]) };
}

/** The operation a 4.0 tool name runs (`summer_assets_get` runs `assets.get`), known to the catalog or not; null for other names. */
function v4OpOf(name: string): string | null {
  const v4 = V4_TOOL.exec(name);
  return v4 && AREAS.has(v4[1]!) ? `${v4[1]}.${v4[2]}` : null;
}

/** What an MCP tool name runs (`area.action`, maybe with flags); empty for summer_call and for names that are no tool. */
export function callsOfTool(name: string, catalog: ShellCatalog): string[] {
  if (name === "summer_search") return ["ops.search"];
  if (name === "summer_whoami") return ["whoami"];
  const legacy = catalog.tools.get(name);
  if (legacy) return legacy;
  const op = v4OpOf(name);
  return op && catalog.ops.has(op) ? [op] : [];
}

/** 4.0 tool names in the texts whose operation the catalog does not have: a typo, or an operation missing from it. */
export function unknownTools(texts: readonly string[], catalog: ShellCatalog): string[] {
  const names = texts.flatMap((text) => [...withoutShellSection(text).matchAll(TOOL_NAME)].map((match) => match[0]));
  return [...new Set(names)].filter((name) => !catalog.tools.has(name) && v4OpOf(name) !== null && !catalog.ops.has(v4OpOf(name)!)).sort();
}

/** `assets.generate_image` -> `summer assets generate-image` (flags after the operation stay); null when no command runs it. */
export function shellCommandOf(call: string): string | null {
  if (call.startsWith("tool ")) return `summer ${call}`;
  const [op, ...flags] = call.split(" ");
  const tail = flags.length ? ` ${flags.join(" ")}` : "";
  if (op === "whoami") return `summer whoami${tail}`;
  if (op === "ops.search") return 'summer ops search "<what you want>"';
  if (op === "ops.describe") return "summer ops describe <op>";
  const [area, action] = op!.split(".");
  return action && AREAS.has(area!) ? `summer ${area} ${action.replace(/_/g, "-")}${tail}` : null;
}

/** The markdown without its generated section. */
export function withoutShellSection(markdown: string): string {
  const start = markdown.indexOf(SHELL_SECTION_START);
  if (start === -1) return markdown;
  const end = markdown.indexOf(SHELL_SECTION_END, start);
  const rest = end === -1 ? "" : markdown.slice(end + SHELL_SECTION_END.length).replace(/^\n+/, "");
  const head = markdown.slice(0, start).trimEnd();
  return rest ? `${head}\n\n${rest}` : `${head}\n`;
}

/** One row per command set: the tools and operations the texts name, with their commands. */
export function shellRows(texts: readonly string[], catalog: ShellCatalog): ShellRow[] {
  const rows = new Map<string, ShellRow>();
  const add = (name: string, calls: string[]) => {
    const commands = calls.map(shellCommandOf).filter((command): command is string => command !== null);
    if (commands.length === 0) return;
    const key = commands.join("\n");
    const row = rows.get(key) ?? { names: [], commands };
    if (!row.names.includes(name)) row.names.push(name);
    rows.set(key, row);
  };
  for (const raw of texts) {
    const text = withoutShellSection(raw);
    for (const match of text.matchAll(TOOL_NAME)) add(match[0], callsOfTool(match[0], catalog));
    for (const pattern of [OP_IN_CODE, OP_FIELD]) {
      for (const match of text.matchAll(pattern)) {
        if (catalog.ops.has(match[1]!)) add(match[1]!, [match[1]!]);
      }
    }
  }
  return [...rows.values()]
    .map((row) => ({ ...row, names: [...row.names].sort() }))
    .sort((a, b) => (a.commands[0]! < b.commands[0]! ? -1 : a.commands[0]! > b.commands[0]! ? 1 : 0));
}

export function renderShellSection(rows: readonly ShellRow[]): string {
  const code = (value: string) => `\`${value}\``;
  return [
    SHELL_SECTION_START,
    "## From a shell",
    "",
    "No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@latest` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.",
    "",
    "| In this skill | Command |",
    "|---|---|",
    ...rows.map((row) => `| ${row.names.map(code).join(", ")} | ${row.commands.map(code).join(", ")} |`),
    SHELL_SECTION_END,
  ].join("\n");
}

/** SKILL.md with its section rendered from these rows at the end; without one when there are none. */
export function withShellSection(markdown: string, rows: readonly ShellRow[]): string {
  const base = withoutShellSection(markdown);
  return rows.length === 0 ? base : `${base.trimEnd()}\n\n${renderShellSection(rows)}\n`;
}

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(abs));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(abs);
  }
  return out.sort();
}

function skillDirs(rootDir: string): string[] {
  const skills = path.join(rootDir, "library", "skills");
  if (!fs.existsSync(skills)) return [];
  return fs
    .readdirSync(skills, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(skills, entry.name, "SKILL.md")))
    .map((entry) => path.join(skills, entry.name))
    .sort();
}

export interface ShellSectionPlan {
  /** library/skills/<slug>/SKILL.md */
  file: string;
  current: string;
  expected: string;
  /** 4.0 tool names the skill uses that the catalog does not have (unknownTools). */
  unknown: string[];
}

/** Every SKILL.md with the text it should have; empty without a catalog. */
export function planShellSections(rootDir: string): ShellSectionPlan[] {
  const catalog = loadShellCatalog(rootDir);
  if (!catalog) return [];
  return skillDirs(rootDir).map((dir) => {
    const texts = markdownFiles(dir).map((file) => fs.readFileSync(file, "utf8"));
    const file = path.join(dir, "SKILL.md");
    const current = fs.readFileSync(file, "utf8");
    const rows = path.basename(dir) === SHELL_GUIDE_SKILL ? [] : shellRows(texts, catalog);
    return { file: path.relative(rootDir, file).split(path.sep).join("/"), current, expected: withShellSection(current, rows), unknown: unknownTools(texts, catalog) };
  });
}

/** Rewrite the sections that are not current; returns the files written. */
export function writeShellSections(rootDir: string): string[] {
  const written: string[] = [];
  for (const plan of planShellSections(rootDir)) {
    if (plan.current === plan.expected) continue;
    fs.writeFileSync(path.join(rootDir, plan.file), plan.expected, "utf8");
    written.push(plan.file);
  }
  return written;
}
