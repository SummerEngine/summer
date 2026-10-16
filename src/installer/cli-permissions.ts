import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CLI_AREAS } from "../core/ops/areas.js";
import { localEntries } from "../core/ops/catalog.js";
import { shippedCloudEntries } from "../core/ops/public-catalog.js";
import type { PathContext, SupportedAgent } from "./agent-table.js";

/**
 * Allow rules for the CLI path, added only with `summer setup <agent> --cli
 * --allow-rules --yes` (the flag is in the command the person approves), so
 * the agent's read-only and dry-run summer commands do not each ask:
 *
 * - the reads in AUTO_ALLOWED_READS, as they are. The list is reviewed by
 *   hand: a new read operation in the catalog does not join it, and
 *   cli-permissions.test.ts fails until someone adds it on purpose;
 * - every spend (generation and the rest) only as a dry run, `--dry-run`
 *   right after the action. A call with that flag is a dry run whatever else
 *   it says (parseCallFlags), so the rule cannot let a real spend through.
 *
 * Changes, publishing, prices, deletes and messages keep asking. Claude Code
 * matches the command text (`Bash(summer jobs wait *)` matches the bare
 * command and `summer jobs wait --job-id x`, not `summer jobs waitx`); Codex
 * matches argument lists, in a rules file of Summer's own. Both get the
 * `summer` and the `npx -y summer-engine@latest` forms.
 */

/**
 * Reads that run without asking. Each one reads Summer data or the open
 * editor's state; `jobs wait` and `assets get` also save the files a finished
 * job names (media files only, never over an existing file). Left out on
 * purpose: `engine capture-gameplay` (it starts Summer Engine on a project, so
 * the project's own code runs, and writes to any --out folder) and
 * `studio open` (it opens a page in the browser).
 */
export const AUTO_ALLOWED_READS: readonly string[] = [
  "whoami", "ops.search", "ops.describe",
  "docs.search", "docs.read", "docs.engine_api", "docs.plan",
  "jobs.get", "jobs.list", "jobs.wait",
  "account.permissions", "profile.get", "team.list", "chats.list", "plugins.search",
  "games.get", "games.list", "games.members", "jams.list", "pricing.get",
  "store.get_listing", "store.status", "experiments.list", "experiments.results",
  "analytics.event_limit", "analytics.events", "analytics.funnel", "analytics.overview", "analytics.summary", "analytics.trend",
  "assets.choices", "assets.get", "assets.get_icon_collection", "assets.get_pack", "assets.list_comments", "assets.list_folders", "assets.list_icon_collections", "assets.search",
  "apps.events", "apps.get", "apps.guide", "apps.list", "apps.page", "apps.read_data", "apps.screenshot", "apps.tools",
  "plans.changes", "plans.chat", "plans.directions", "plans.get", "plans.links", "plans.list", "plans.presence", "plans.show",
  "projects.builds", "projects.get", "projects.list", "projects.open_in_engine", "projects.preview_build",
  "stories.get", "stories.list", "studio.map", "studio.page", "studio.read_form",
  "marketing.applications", "marketing.content_feed", "marketing.content_videos", "marketing.get_brand_pack", "marketing.list_content_games",
  "engine.debug_views", "engine.game_probe", "engine.get_console", "engine.get_debugger_errors", "engine.get_debugger_warnings", "engine.get_diagnostics",
  "engine.get_project_context", "engine.get_runtime_tree", "engine.get_scene_tree", "engine.get_script_errors", "engine.grep", "engine.inspect_asset",
  "engine.inspect_node", "engine.inspect_resource", "engine.inspect_runtime_node", "engine.is_running", "engine.list_camera_bookmarks", "engine.list_ui_actions",
  "engine.measure", "engine.navigation_probe", "engine.raycast", "engine.read_file", "engine.recent_events", "engine.scene_audit", "engine.screenshot",
  "engine.shot_sheet", "engine.snapshot_diff", "engine.starcast", "engine.test_placement", "engine.ui_screenshot", "engine.ui_tree", "engine.wait_for_event",
  "engine.world_snapshot", "engine.zoom",
];

export type CliCommand = { words: string[]; dryRun: boolean };

/** The shell words of a command, after the launcher: `assets.generate_image` -> `assets generate-image`. */
const wordsOf = (op: string) => (op.includes(".") ? [op.split(".")[0], op.split(".")[1].replace(/_/g, "-")] : [op]);

/** The commands allowed without asking: `summer status`, the reviewed reads, and a dry run of every spend in the catalog. */
export function allowedCliCommands(): CliCommand[] {
  const known = new Map([...localEntries(), ...shippedCloudEntries()].map((entry) => [entry.name, entry]));
  const reads = AUTO_ALLOWED_READS.filter((op) => known.get(op)?.effect === "read").map((op) => ({ words: wordsOf(op), dryRun: false }));
  const areas = new Set<string>(CLI_AREAS);
  const spends = [...known.values()]
    .filter((entry) => entry.effect === "spend" && entry.status !== "deprecated" && areas.has(entry.name.split(".")[0]))
    .map((entry) => ({ words: wordsOf(entry.name), dryRun: true }));
  return [{ words: ["status"], dryRun: false }, ...reads, ...spends].sort((a, b) => a.words.join(" ").localeCompare(b.words.join(" ")) || Number(a.dryRun) - Number(b.dryRun));
}

export const LAUNCHERS: ReadonlyArray<readonly string[]> = [["summer"], ["npx", "-y", "summer-engine@latest"]];

/** Claude Code `permissions.allow` rules, for both launchers. */
export function claudeAllowRules(): string[] {
  return LAUNCHERS.flatMap((launcher) => allowedCliCommands().map(({ words, dryRun }) => `Bash(${[...launcher, ...words, ...(dryRun ? ["--dry-run"] : [])].join(" ")} *)`));
}

const starlark = (value: string | readonly string[]): string => (typeof value === "string" ? JSON.stringify(value) : `[${value.map((item) => JSON.stringify(item)).join(", ")}]`);

const CODEX_HEADER = "# Written by summer setup codex --cli --allow-rules; setup rewrites this file and --remove-allow-rules deletes it.";

/** Codex rules: one prefix_rule per launcher, area and kind, the actions as a union. */
export function codexRules(): string {
  const groups = new Map<string, { launcher: readonly string[]; head: string[]; actions: string[]; dryRun: boolean }>();
  for (const launcher of LAUNCHERS) {
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
    const why = dryRun ? "Summer dry run: checks the input, spends nothing" : "Summer read: changes no Summer data; jobs wait and assets get save the files they name";
    return `prefix_rule(\n    pattern = [${pattern.join(", ")}],\n    decision = "allow",\n    justification = ${starlark(why)},\n    match = [${starlark(example)}],\n)`;
  });
  return `${CODEX_HEADER}\n# Reads, and spends only as dry runs. Changes, publishing, deletes and messages still ask.\n\n${rules.join("\n\n")}\n`;
}

export interface AllowRulesResult {
  agent: SupportedAgent;
  path: string;
  /** Every rule Summer wants there (Codex: its patterns); empty for a removal. */
  rules: string[];
  /** What this run added, or removed with --remove-allow-rules. */
  changed: string[];
  wrote: boolean;
}

/** The agents with clean per-command allow rules: Claude Code (settings.json) and Codex (rules files). */
export function supportsAllowRules(agent: SupportedAgent): boolean {
  return agent === "claude-code" || agent === "codex";
}

/**
 * Where the rules go. Claude Code: the user's settings, or with --scope
 * project the project's personal settings.local.json (never the shared file).
 * Codex: always the user's rules folder; a project's .codex/rules is shared
 * through git, so Summer does not write there.
 */
export function allowRulesPath(agent: SupportedAgent, scope: "user" | "project", ctx: PathContext): string {
  if (agent === "codex") return ctx.env.SUMMER_CODEX_RULES_FILE || join(ctx.env.CODEX_HOME || join(ctx.home, ".codex"), "rules", "summer.rules");
  return ctx.env.SUMMER_CLAUDE_SETTINGS_FILE || (scope === "project" ? join(ctx.cwd, ".claude", "settings.local.json") : join(ctx.home, ".claude", "settings.json"));
}

/**
 * Write next to the file, then rename over it, so Claude Code never reads
 * half a file. A symlinked settings file (a dotfiles repo) is written through
 * the link, in its real folder, and keeps its mode.
 */
async function writeAtomically(path: string, text: string): Promise<void> {
  const target = existsSync(path) ? await realpath(path) : path;
  await mkdir(dirname(target), { recursive: true });
  const mode = existsSync(target) ? (await stat(target)).mode & 0o7777 : undefined;
  const temp = `${target}.summer-${process.pid}.tmp`;
  await writeFile(temp, text, mode === undefined ? {} : { mode });
  if (mode !== undefined) await chmod(temp, mode);
  await rename(temp, target);
}

async function readClaudeSettings(path: string): Promise<{ settings: Record<string, unknown>; permissions: Record<string, unknown>; allow: unknown[] }> {
  let settings: unknown = {};
  if (existsSync(path)) {
    try {
      settings = JSON.parse(await readFile(path, "utf8"));
    } catch {
      throw new Error(`${path} is not valid JSON, so Summer left its allow rules alone. Fix the file, then run setup again.`);
    }
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error(`${path} is not a JSON object, so Summer left its allow rules alone.`);
  const record = settings as Record<string, unknown>;
  const permissions = record.permissions ?? {};
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) throw new Error(`${path}: permissions is not an object, so Summer left its allow rules alone.`);
  const allow = (permissions as Record<string, unknown>).allow ?? [];
  if (!Array.isArray(allow)) throw new Error(`${path}: permissions.allow is not a list, so Summer left its allow rules alone.`);
  return { settings: record, permissions: permissions as Record<string, unknown>, allow };
}

/**
 * Add the allow rules. Claude Code: merged into `permissions.allow`, nothing
 * removed, every other setting kept. Codex: Summer's own rules file,
 * rewritten. Writes nothing unless `write`.
 */
export async function addAllowRules(agent: SupportedAgent, path: string, write: boolean): Promise<AllowRulesResult> {
  if (agent === "codex") {
    const text = codexRules();
    const rules = text.split("\n").filter((line) => line.startsWith("    pattern = ")).map((line) => line.trim());
    const changed = (existsSync(path) ? await readFile(path, "utf8") : "") !== text;
    if (write && changed) await writeAtomically(path, text);
    return { agent, path, rules, changed: changed ? rules : [], wrote: write && changed };
  }
  const rules = claudeAllowRules();
  const { settings, permissions, allow } = await readClaudeSettings(path);
  const added = rules.filter((rule) => !allow.includes(rule));
  if (write && added.length > 0) await writeAtomically(path, `${JSON.stringify({ ...settings, permissions: { ...permissions, allow: [...allow, ...added] } }, null, 2)}\n`);
  return { agent, path, rules, changed: added, wrote: write && added.length > 0 };
}

/** Remove exactly the rules Summer adds (Claude Code), or Summer's own rules file (Codex). Writes nothing unless `write`. */
export async function removeAllowRules(agent: SupportedAgent, path: string, write: boolean): Promise<AllowRulesResult> {
  if (agent === "codex") {
    const ours = existsSync(path) && (await readFile(path, "utf8")).startsWith("# Written by summer setup codex");
    if (write && ours) await rm(path);
    return { agent, path, rules: [], changed: ours ? [path] : [], wrote: write && ours };
  }
  if (!existsSync(path)) return { agent, path, rules: [], changed: [], wrote: false };
  const ours = new Set(claudeAllowRules());
  const { settings, permissions, allow } = await readClaudeSettings(path);
  const removed = allow.filter((rule): rule is string => typeof rule === "string" && ours.has(rule));
  if (write && removed.length > 0) {
    await writeAtomically(path, `${JSON.stringify({ ...settings, permissions: { ...permissions, allow: allow.filter((rule) => !removed.includes(rule as string)) } }, null, 2)}\n`);
  }
  return { agent, path, rules: [], changed: removed, wrote: write && removed.length > 0 };
}
