import { z } from "zod";
import { asRecord } from "../util/json.js";
import { extractOpError } from "./engine-receipt.js";

/**
 * summer_enable_plugin: enable an editor plugin (`res://addons/<name>/`) and
 * report what really happened. Engines with Summer Apps support run the
 * EnableEditorPlugin op until the plugin's `_enter_tree` has run and answer
 * `enabled` (or a failure `code`); older engines only queue the enable and
 * answer `deferred: true`, so this tool says the result is unknown instead of
 * claiming success. One implementation for the MCP tool and `summer tool
 * enable-plugin`.
 */

export const enablePluginArgsSchema = z.object({
  plugin: z
    .string()
    .min(1)
    .max(200)
    .describe("The plugin folder under res://addons/ (e.g. 'quest_tools') or its 'res://addons/<name>/plugin.cfg'"),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(120_000)
    .optional()
    .describe("How long the engine waits for the plugin to load (default 30000)"),
});

export function enablePluginOp(args: z.output<typeof enablePluginArgsSchema>): { op: string; [key: string]: unknown } {
  return { op: "EnableEditorPlugin", pluginPath: args.plugin.trim(), ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}) };
}

const FAILURE_HINTS: Record<string, string> = {
  CFG_MISSING: "No plugin.cfg there. Check the folder name under res://addons/.",
  CFG_PARSE_FAILED: "plugin.cfg does not parse. Fix it and enable again.",
  NO_SCRIPT_KEY: "plugin.cfg needs a script= entry under [plugin].",
  EMPTY_SCRIPT_PATH: "plugin.cfg needs a script= entry under [plugin].",
  SCRIPT_MISSING: "The script plugin.cfg names does not exist.",
  SCRIPT_LOAD_FAILED: "The plugin script did not load. Read summer_get_script_errors for it.",
  SCRIPT_ERROR: "The plugin script has errors. Read summer_get_script_errors, fix them, and enable again.",
  NOT_EDITOR_PLUGIN: "The plugin script must extend EditorPlugin.",
  NOT_TOOL: "The plugin script must start with @tool.",
  TIMEOUT: "The plugin did not finish loading in time (often a filesystem scan). Try again, or raise timeoutMs.",
};

export const QUEUED_ONLY_NOTE =
  "This Summer Engine build only queues the enable and does not report whether the plugin loaded. " +
  "Check summer_get_debugger_errors and summer_get_script_errors for the plugin script before relying on it, or update Summer Engine for the real result.";

/** The engine's answer for EnableEditorPlugin, as one result an agent can trust. */
export function interpretEnablePluginResult(raw: unknown): Record<string, unknown> {
  const root = asRecord(raw) ?? {};
  const results = Array.isArray(root.results) ? root.results : [];
  const entry = asRecord(results.find((item) => asRecord(item)?.op === "EnableEditorPlugin") ?? results[0]) ?? root;
  const addonPath = typeof entry.addonPath === "string" ? entry.addonPath : undefined;
  const error = extractOpError(raw) ?? (entry.ok === false ? String(entry.error ?? "The plugin was not enabled.") : null);
  if (error) {
    const code = typeof entry.code === "string" ? entry.code : undefined;
    return {
      ok: false,
      enabled: false,
      ...(addonPath ? { addonPath } : {}),
      ...(code ? { code } : {}),
      error,
      ...(code && FAILURE_HINTS[code] ? { hint: FAILURE_HINTS[code] } : {}),
    };
  }
  if (entry.alreadyEnabled === true) return { ok: true, enabled: true, alreadyEnabled: true, ...(addonPath ? { addonPath } : {}) };
  if (entry.enabled === true) {
    return {
      ok: true,
      enabled: true,
      ...(addonPath ? { addonPath } : {}),
      autoloadsRegistered: Array.isArray(entry.autoloadsRegistered) ? entry.autoloadsRegistered : [],
      ...(typeof entry.elapsedMs === "number" ? { elapsedMs: entry.elapsedMs } : {}),
    };
  }
  // Older engines: { ok: true, deferred: true } means "scheduled", not "loaded".
  return { ok: true, enabled: null, queued: true, ...(addonPath ? { addonPath } : {}), note: QUEUED_ONLY_NOTE };
}
