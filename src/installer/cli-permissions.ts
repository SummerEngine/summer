import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, sep } from "node:path";
import { CLI_AREAS } from "../core/ops/areas.js";
import { localEntries } from "../core/ops/catalog.js";
import { shippedCloudEntries } from "../core/ops/public-catalog.js";
import type { ConfigScope, PathContext, SupportedAgent } from "./agent-table.js";

/**
 * Allow rules for the CLI path (`summer setup <agent> --cli`), so the agent's
 * read-only and dry-run summer commands do not each ask for permission:
 *
 * - every read operation (`summer jobs wait`, `summer engine screenshot`,
 *   `summer ops search`, ...), as it is;
 * - every spend (generation and the rest) only as a dry run, `--dry-run`
 *   right after the action. A call with that flag is a dry run whatever else
 *   it says (parseCallFlags), so the rule cannot let a real spend through.
 *
 * Changes, publishing, prices, deletes and messages keep asking. Claude Code
 * matches the command text (`Bash(summer jobs wait *)` matches the bare
 * command and `summer jobs wait --job-id x`, not `summer jobs waitx`); Codex
 * matches argument lists, in a rules file of Summer's own.
 */

export type CliCommand = { words: string[]; dryRun: boolean };

/** The shell words of a command, after the launcher: `assets.generate_image` -> `assets generate-image`. */
const wordsOf = (op: string) => (op.includes(".") ? [op.split(".")[0], op.split(".")[1].replace(/_/g, "-")] : [op]);

/** The commands allowed without asking, from the operation catalog. */
export function allowedCliCommands(): CliCommand[] {
  const areas = new Set<string>(CLI_AREAS);
  const runnable = (op: string) => op === "whoami" || op === "ops.search" || op === "ops.describe" || areas.has(op.split(".")[0]);
  const entries = [...localEntries(), ...shippedCloudEntries()].filter((entry) => entry.status !== "deprecated" && runnable(entry.name));
  const commands = new Map<string, CliCommand>([["status", { words: ["status"], dryRun: false }]]);
  for (const entry of entries) {
    if (entry.effect === "read") commands.set(entry.name, { words: wordsOf(entry.name), dryRun: false });
    else if (entry.effect === "spend") commands.set(entry.name, { words: wordsOf(entry.name), dryRun: true });
  }
  return [...commands.values()].sort((a, b) => a.words.join(" ").localeCompare(b.words.join(" ")) || Number(a.dryRun) - Number(b.dryRun));
}

export const SUMMER_LAUNCHER = ["summer"];
export const NPX_LAUNCHER = ["npx", "-y", "summer-engine@latest"];

/**
 * The launcher the agent will type: `summer` when it is on PATH outside an
 * npx cache (a global npm or Homebrew install), else the npx form the
 * summer-cli skill falls back to.
 */
export function cliLauncher(env: NodeJS.ProcessEnv = process.env, os: NodeJS.Platform = process.platform): string[] {
  const names = os === "win32" ? ["summer.cmd", "summer.exe", "summer"] : ["summer"];
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter((dir) => dir && !dir.includes(`${sep}_npx${sep}`));
  return dirs.some((dir) => names.some((name) => existsSync(join(dir, name)))) ? SUMMER_LAUNCHER : NPX_LAUNCHER;
}

/** Claude Code `permissions.allow` rules for one launcher. */
export function claudeAllowRules(launcher: readonly string[]): string[] {
  return allowedCliCommands().map(({ words, dryRun }) => `Bash(${[...launcher, ...words, ...(dryRun ? ["--dry-run"] : [])].join(" ")} *)`);
}

const starlark = (value: string | readonly string[]): string => (typeof value === "string" ? JSON.stringify(value) : `[${value.map((item) => JSON.stringify(item)).join(", ")}]`);

/** Codex rules: one prefix_rule per launcher, area and kind, the actions as a union. */
export function codexRules(): string {
  const groups = new Map<string, { launcher: readonly string[]; head: string[]; actions: string[]; dryRun: boolean }>();
  for (const launcher of [SUMMER_LAUNCHER, NPX_LAUNCHER]) {
    for (const { words, dryRun } of allowedCliCommands()) {
      const head = words.length > 1 ? words.slice(0, 1) : [];
      const key = `${launcher.join(" ")}|${head.join(" ")}|${dryRun}`;
      const group = groups.get(key) ?? { launcher, head, actions: [], dryRun };
      group.actions.push(words[words.length - 1]);
      groups.set(key, group);
    }
  }
  const rules = [...groups.values()].map(({ launcher, head, actions, dryRun }) => {
    const pattern = [...launcher.map(starlark), ...head.map(starlark), starlark(actions.length === 1 ? actions[0] : actions), ...(dryRun ? [starlark("--dry-run")] : [])];
    const example = [...launcher, ...head, actions[0], ...(dryRun ? ["--dry-run"] : [])].join(" ");
    return `prefix_rule(\n    pattern = [${pattern.join(", ")}],\n    decision = "allow",\n    justification = ${starlark(dryRun ? "Summer dry run: checks the input, spends nothing" : "Summer read: changes nothing")},\n    match = [${starlark(example)}],\n)`;
  });
  return `# Written by summer setup codex --cli; it rewrites this file. Delete it to ask again for every summer command.\n# Read operations, and spends only as dry runs. Changes, publishing, deletes and messages still ask.\n\n${rules.join("\n\n")}\n`;
}

export interface AllowRulesResult {
  agent: SupportedAgent;
  path: string;
  /** Every rule Summer wants there. */
  rules: string[];
  /** The ones the file did not have yet (Claude Code); all of them for a Codex file that changed. */
  added: string[];
  wrote: boolean;
}

/** The agents with clean per-command allow rules: Claude Code (settings.json) and Codex (rules files). */
export function supportsAllowRules(agent: SupportedAgent): boolean {
  return agent === "claude-code" || agent === "codex";
}

/** Where the rules go: Claude Code's user settings or the project's personal settings; Codex's rules folder. */
export function allowRulesPath(agent: SupportedAgent, scope: ConfigScope, ctx: PathContext): string {
  if (agent === "codex") {
    const root = scope === "project" ? join(ctx.cwd, ".codex") : ctx.env.CODEX_HOME || join(ctx.home, ".codex");
    return ctx.env.SUMMER_CODEX_RULES_FILE || join(root, "rules", "summer.rules");
  }
  return ctx.env.SUMMER_CLAUDE_SETTINGS_FILE || (scope === "project" ? join(ctx.cwd, ".claude", "settings.local.json") : join(ctx.home, ".claude", "settings.json"));
}

/**
 * Add the allow rules for an agent. Claude Code: merged into
 * `permissions.allow`, nothing removed, every other setting kept. Codex:
 * Summer's own rules file, rewritten. Writes nothing unless `write`.
 */
export async function addAllowRules(agent: SupportedAgent, path: string, write: boolean, env: NodeJS.ProcessEnv = process.env): Promise<AllowRulesResult> {
  if (agent === "codex") {
    const text = codexRules();
    const current = existsSync(path) ? await readFile(path, "utf8") : "";
    const rules = text.split("\n").filter((line) => line.startsWith("    pattern = ")).map((line) => line.trim());
    const changed = current !== text;
    if (write && changed) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    }
    return { agent, path, rules, added: changed ? rules : [], wrote: write && changed };
  }
  const rules = claudeAllowRules(cliLauncher(env));
  let settings: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      settings = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    } catch {
      throw new Error(`${path} is not valid JSON, so Summer did not add its allow rules. Fix the file, then run setup again.`);
    }
  }
  const permissions = (settings.permissions && typeof settings.permissions === "object" ? settings.permissions : {}) as Record<string, unknown>;
  const allow = Array.isArray(permissions.allow) ? (permissions.allow as unknown[]) : [];
  const added = rules.filter((rule) => !allow.includes(rule));
  if (write && added.length > 0) {
    const next = { ...settings, permissions: { ...permissions, allow: [...allow, ...added] } };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(next, null, 2)}\n`);
  }
  return { agent, path, rules, added, wrote: write && added.length > 0 };
}
