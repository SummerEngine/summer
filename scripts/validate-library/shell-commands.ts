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
 * one rendered here; `npm run generate:registry` rewrites it.
 *
 * Names come from every markdown file in the skill folder (SKILL.md and its
 * references/); the section goes at the end of SKILL.md. A root without
 * legacy-names.json (a test fixture) has no catalog, so nothing is checked.
 */

import fs from "node:fs";
import path from "node:path";
import { CLI_AREAS } from "../../src/core/ops/areas.ts";

export const SHELL_SECTION_START =
  "<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->";
export const SHELL_SECTION_END = "<!-- /shell-commands -->";

const LEGACY_NAMES = path.join("registry", "operations", "legacy-names.json");
/** The skill every section points at; it teaches the commands itself, so it has no section. */
export const SHELL_GUIDE_SKILL = "summer-cli";
const AREAS: ReadonlySet<string> = new Set(CLI_AREAS);

const TOOL_NAME = /\bsummer_[a-z0-9_]*[a-z0-9]\b/g;
/** An operation in code: `assets.generate_image` or `assets.search({ ... })`. */
const OP_IN_CODE = /`([a-z]+\.[a-z][a-z0-9_]*)(?=[`(])/g;
/** An operation as summer_call's op: `op: "docs.workflows"`, `{"op":"docs.feedback"}`. */
const OP_FIELD = /\bop"?\s*:\s*"([a-z]+\.[a-z][a-z0-9_]*)"/g;
const V4_TOOL = /^summer_([a-z]+)_([a-z][a-z0-9_]*)$/;

export interface ShellCatalog {
  /** 3.x tool name -> what it runs, one per action of a split tool: `area.action`, plus a fixed input as flags. */
  tools: Map<string, string[]>;
  /** Operations named in prose that get a command: the catalog's, and those a 4.0 tool name in the library runs. */
  ops: Set<string>;
}

export interface ShellRow {
  /** The names as the skill writes them. */
  names: string[];
  commands: string[];
}

type LegacyRow = { op: string; note?: string };

/** A merged 3.x tool whose note fixes one input (`docs.read {id: reference/agent-playbook}`) runs with that flag. */
const FIXED_INPUT = /^([a-z]+\.[a-z][a-z0-9_]*)\s*\{\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*([\w./:-]+)\s*\}$/;

function callOf(row: LegacyRow): string {
  const fixed = FIXED_INPUT.exec(row.note?.trim() ?? "");
  return fixed && fixed[1] === row.op ? `${row.op} --${kebab(fixed[2]!)} ${fixed[3]}` : row.op;
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
    if (!calls.includes(callOf(row))) calls.push(callOf(row));
    tools.set(tool, calls);
  }
  return { tools, ops: new Set(Object.values(names).map((row) => row.op)) };
}

/** What an MCP tool name runs (`area.action`, maybe with flags); empty for summer_call and for names that are no tool. */
export function callsOfTool(name: string, catalog: ShellCatalog): string[] {
  if (name === "summer_search") return ["ops.search"];
  if (name === "summer_whoami") return ["whoami"];
  const legacy = catalog.tools.get(name);
  if (legacy) return legacy;
  const v4 = V4_TOOL.exec(name);
  return v4 && AREAS.has(v4[1]!) ? [`${v4[1]}.${v4[2]}`] : [];
}

/** `assets.generate_image` -> `summer assets generate-image` (flags after the operation stay); null when no command runs it. */
export function shellCommandOf(call: string): string | null {
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

/** Operations a 4.0 tool name in this text runs: they are known operations even where legacy-names.json has no row. */
export function v4OpsIn(markdown: string): string[] {
  return [...markdown.matchAll(TOOL_NAME)]
    .map((match) => V4_TOOL.exec(match[0]))
    .filter((v4): v4 is RegExpExecArray => v4 !== null && AREAS.has(v4[1]!))
    .map((v4) => `${v4[1]}.${v4[2]}`);
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
    "No Summer MCP tools in this session? Run each one as a command, with the same fields as flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`. `summer ops describe <op>` prints the exact input; the `summer-cli` skill has the rest.",
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
}

/** Every SKILL.md with the text it should have; empty without a catalog. */
export function planShellSections(rootDir: string): ShellSectionPlan[] {
  const catalog = loadShellCatalog(rootDir);
  if (!catalog) return [];
  const dirs = skillDirs(rootDir);
  const texts = new Map(dirs.map((dir) => [dir, markdownFiles(dir).map((file) => fs.readFileSync(file, "utf8"))]));
  const known: ShellCatalog = { tools: catalog.tools, ops: new Set([...catalog.ops, ...[...texts.values()].flat().flatMap(v4OpsIn)]) };
  return dirs.map((dir) => {
    const file = path.join(dir, "SKILL.md");
    const current = fs.readFileSync(file, "utf8");
    const rows = path.basename(dir) === SHELL_GUIDE_SKILL ? [] : shellRows(texts.get(dir)!, known);
    return { file: path.relative(rootDir, file).split(path.sep).join("/"), current, expected: withShellSection(current, rows) };
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
