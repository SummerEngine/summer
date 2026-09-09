/**
 * summer tool — CLI parity passthrough for every library tool resource.
 *
 * Dispatches through the shared registry in
 * src/core/capabilities/tool-dispatch.ts (the same core capabilities, engine
 * client, and gateway endpoints the MCP surface uses; contract §2: cli never
 * imports mcp). Name resolution prefers the dispatch table and, when the
 * compiled registry exists (registry/generated/index.json), also resolves
 * library ids and legacy aliases through it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT } from "../../core/package-root.js";
import { Command, Option } from "commander";
import {
  ToolDispatchError,
  ToolResultError,
  dispatchTool,
  listToolDispatches,
  resolveToolDispatch,
  type ToolDispatchEntry,
} from "../../core/capabilities/tool-dispatch.js";
import { c } from "../../core/format.js";

interface ToolCommandOptions {
  args?: string;
  /** Deprecated alias of --args (one release). Every other command's --json is
   *  a boolean output switch; taking a JSON string here was the odd one out. */
  json?: string;
  list?: boolean;
}

interface RegistryIndexResource {
  id?: string;
  kind?: string;
  aliases?: string[];
}

/** Resolve a name through the compiled registry index when it exists —
 *  accepts full ids ("tool/add-node") and legacy aliases, returning the slug
 *  the dispatch table knows. Returns null when the index is absent or the
 *  name is not a tool resource. */
export function resolveViaRegistryIndex(
  name: string,
  root: string = PACKAGE_ROOT
): string | null {
  const indexPath = join(root, "registry", "generated", "index.json");
  if (!existsSync(indexPath)) return null;
  let resources: RegistryIndexResource[];
  try {
    const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as {
      resources?: RegistryIndexResource[];
    };
    resources = Array.isArray(parsed.resources) ? parsed.resources : [];
  } catch {
    return null;
  }
  const needle = name.trim();
  for (const resource of resources) {
    if (resource.kind !== "tool" || typeof resource.id !== "string") continue;
    const matches =
      resource.id === needle ||
      resource.id === `tool/${needle}` ||
      (Array.isArray(resource.aliases) && resource.aliases.includes(needle));
    if (matches) return resource.id.replace(/^tool\//, "");
  }
  return null;
}

export function resolveToolForCli(name: string): ToolDispatchEntry | null {
  const direct = resolveToolDispatch(name);
  if (direct) return direct;
  const viaRegistry = resolveViaRegistryIndex(name);
  return viaRegistry ? resolveToolDispatch(viaRegistry) : null;
}

export function parseJsonArgs(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ToolDispatchError(
      `--args must be valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ToolDispatchError("--args must be a JSON object of tool arguments");
  }
  return parsed as Record<string, unknown>;
}

export function formatToolList(entries: readonly ToolDispatchEntry[]): string {
  const width = Math.max(...entries.map((entry) => entry.slug.length));
  const lines = [...entries]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map(
      (entry) =>
        `  ${entry.slug.padEnd(width)}  ${entry.summary}${entry.engineRequired ? c.dim(" [engine]") : ""}`
    );
  return [
    c.bold(`Summer tools (${entries.length})`),
    ...lines,
    "",
    c.dim("[engine] needs the Summer Engine app running with the project open."),
    c.dim(`Run one: summer tool <name> --args '{"arg": "value"}'`),
  ].join("\n");
}

export const toolCommand = new Command("tool")
  .description(
    "Run any Summer tool from the CLI — same implementations as the MCP surface"
  )
  .argument("[name]", "Tool name: library slug (add-node) or MCP alias (summer_add_node)")
  .option("--args <json>", "Tool arguments as a JSON object (matches the tool's input_schema)")
  .addOption(new Option("--json <args>", "Deprecated alias of --args").hideHelp())
  .option("--list", "List every tool with a one-line summary")
  .action(async (name: string | undefined, options: ToolCommandOptions) => {
    if (options.list || name === undefined) {
      console.log(formatToolList(listToolDispatches()));
      if (name === undefined && !options.list) {
        console.log("");
        console.log(c.dim("Pass a tool name to run one."));
      }
      return;
    }

    const entry = resolveToolForCli(name);
    if (!entry) {
      throw new ToolDispatchError(
        `Unknown tool "${name}". Run 'summer tool --list' to see all ${listToolDispatches().length} tools.`
      );
    }

    if (options.json !== undefined && options.args === undefined) {
      console.error("Note: 'summer tool --json <args>' is deprecated; use --args <json>.");
    }
    const args = parseJsonArgs(options.args ?? options.json);
    let result: unknown;
    try {
      result = await dispatchTool(entry.slug, args);
    } catch (err) {
      // A structured failure — any engine receipt the MCP face would mark
      // isError, engine_lacks_op, a library/navigation miss — is printed whole
      // (stdout, exit 1) so callers read ok/error/failure_reason instead of
      // scraping a sentence. Argument and connection errors stay plain text on
      // stderr (thrown; the program's catch exits 1).
      if (err instanceof ToolResultError) {
        console.log(JSON.stringify(err.result, null, 2));
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    console.log(JSON.stringify(result, null, 2));
  });
