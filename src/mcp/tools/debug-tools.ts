import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withEngine } from "./with-engine.js";
import { shapeEngineLogResponse } from "../../lib/log-filters.js";
import { createDebugReportArtifact } from "../../lib/debug-report.js";

export function registerDebugTools(server: McpServer): void {
  server.tool(
    "summer_get_diagnostics",
    `Quick overview of all errors and warnings from both the editor console and the runtime debugger. Returns error counts and a guidance message.

ALWAYS call this FIRST before diving into summer_get_console or summer_get_debugger_errors. It tells you where to look.

Typical workflow after making changes:
1. summer_get_diagnostics — are there issues?
2. If errors: summer_get_console or summer_get_debugger_errors for details
3. Fix the issues
4. summer_get_diagnostics again to verify`,
    {},
    async () => withEngine(async (client) => client.getDiagnostics())
  );

  server.tool(
    "summer_get_console",
    `Read recent messages from the editor's Output panel.

Output is post-processed for token economy: consecutive identical messages collapse into one entry with a "(×N)" count suffix, and the response carries a "_filter" summary so you can see what was hidden. Use errors_only=true (default) to drop info/std noise; use raw=true to bypass all shaping.

Use after summer_get_diagnostics indicates console issues.`,
    {
      max_lines: z.number().optional().default(100).describe("Max lines to return after dedupe (default 100)"),
      filter: z.string().optional().describe("Only return lines containing this string"),
      type: z.enum(["error", "warning", "std", "editor"]).optional().describe("Filter by message type at the engine level"),
      errors_only: z.boolean().optional().default(true).describe("Drop info/std noise, keep errors and warnings (default true)"),
      strict_errors: z.boolean().optional().default(false).describe("Drop warnings too — return errors only"),
      raw: z.boolean().optional().default(false).describe("Bypass dedupe and level filtering — return engine output verbatim"),
    },
    async ({ max_lines, filter, type, errors_only, strict_errors, raw }) =>
      withEngine(async (client) => {
        const op: Record<string, unknown> = { op: "GetConsoleOutput", max_lines };
        if (filter) op.filter = filter;
        if (type) op.type = type;
        const engineResult = await client.executeOps([op]);
        if (raw) return engineResult;
        const { result } = shapeEngineLogResponse(engineResult, {
          errorsOnly: errors_only,
          errorsOnlyStrict: strict_errors,
          maxEntries: max_lines,
        });
        return result;
      })
  );

  server.tool(
    "summer_clear_console",
    "Clear the editor's Output panel. Useful before running the game to get a clean slate for error checking.",
    {},
    async () =>
      withEngine(async (client) => client.executeOps([{ op: "ClearConsoleOutput" }]))
  );

  server.tool(
    "summer_get_debugger_errors",
    `Read runtime errors from the debugger. These occur while the game is running (null references, missing nodes, physics errors). Different from console output — these come from the debugger, not print statements.

For warning text, use summer_get_debugger_warnings (separate tool — engine returns warning count here but not the bodies).

Output is deduped: identical errors firing every frame collapse into one entry with a "(×N)" count suffix. A "_filter" summary tells you exactly what was collapsed or truncated. Use raw=true to bypass shaping when you really need every entry.`,
    {
      max_errors: z.number().optional().default(50).describe("Max errors to return after dedupe"),
      include_stack: z.boolean().optional().describe("Include stack traces for each error"),
      include_warnings: z.boolean().optional().default(false).describe("Forward-compat flag — when engine supports it, returns warning bodies in the same call. Today the engine ignores it; use summer_get_debugger_warnings instead."),
      raw: z.boolean().optional().default(false).describe("Bypass dedupe — return engine output verbatim"),
    },
    async ({ max_errors, include_stack, include_warnings, raw }) =>
      withEngine(async (client) => {
        const op: Record<string, unknown> = { op: "GetDebuggerErrors", max_errors };
        if (include_stack !== undefined) op.include_stack = include_stack;
        if (include_warnings) op.include_warnings = true;
        const engineResult = await client.executeOps([op]);
        if (raw) return engineResult;
        const { result } = shapeEngineLogResponse(engineResult, { maxEntries: max_errors });
        return result;
      })
  );

  server.tool(
    "summer_get_debugger_warnings",
    `Read runtime warnings from the debugger panel. Warnings are non-fatal issues the game flags during play: missing optional resources, dead signal connections, deprecated API use, large allocations, physics warnings, etc.

Returns structured entries with file/line/function/error_descr/callstack — same shape as summer_get_debugger_errors but filtered to severity = "warning". Engine-internal warnings without a source file are filtered out as noise.

Use this when summer_get_diagnostics shows a non-zero \`debugger.warnings\` count and you want to see what they actually say.`,
    {
      max_warnings: z.number().optional().default(50).describe("Max warnings to return after dedupe"),
      include_stack: z.boolean().optional().default(true).describe("Include stack traces"),
      raw: z.boolean().optional().default(false).describe("Bypass dedupe"),
    },
    async ({ max_warnings, include_stack, raw }) =>
      withEngine(async (client) => {
        // Reuses the existing GetDebuggerErrors op with type: "warning" filter.
        // Engine-side change: ScriptEditorDebugger::get_errors_data() supports
        // include_warnings; debug_ops::get_debugger_errors honours `type` to
        // return warnings only. Diagnostics also exposes `warnings_data`.
        const op: Record<string, unknown> = {
          op: "GetDebuggerErrors",
          max_errors: max_warnings,
          type: "warning",
          include_stack,
        };
        const engineResult = await client.executeOps([op]);
        if (raw) return engineResult;
        const { result } = shapeEngineLogResponse(engineResult, { maxEntries: max_warnings });
        return result;
      })
  );

  server.tool(
    "summer_play",
    `Start running the game in the engine. The game runs inside Summer Engine's viewport.

After starting, use summer_get_diagnostics to check for runtime errors.

You can run a specific scene instead of the main scene — useful for testing individual levels or UI screens.`,
    {
      scene: z.string().optional().describe("Scene to run instead of main scene, e.g. 'res://levels/test_level.tscn'"),
    },
    async ({ scene }) => withEngine(async (client) => client.play(scene))
  );

  server.tool(
    "summer_stop",
    "Stop the running game. Use after runtime verification or when you intentionally need to restart the running instance; ordinary editor scene mutations do not require a blanket stop.",
    {},
    async () => withEngine(async (client) => client.stop())
  );

  server.tool(
    "summer_is_running",
    "Check if the game is currently running. Returns the active scene path if running.",
    {},
    async () =>
      withEngine(async (client) => client.executeOps([{ op: "IsGameRunning" }]))
  );

  server.tool(
    "summer_get_script_errors",
    `Check a GDScript file for parse/compile errors without running the game.

Use after writing or editing a .gd file to verify it compiles. Returns line numbers, error messages, and severity. Much faster than running the game to discover script errors.`,
    {
      path: z.string().describe("Script path, e.g. 'res://scripts/player.gd' or 'res://player_controller.gd'"),
    },
    async ({ path }) =>
      withEngine(async (client) => client.getScriptErrors(path))
  );

  server.tool(
    "summer_create_debug_report",
    `Create a support-ready Markdown report for /summer debug.

Use this when the user says "/summer debug", asks to send Summer a bug report,
or needs a portable artifact from a failing Codex/cloud/agent session. The
report includes Summer doctor checks, engine health, diagnostics, console
output, debugger errors/warnings, and an agent handoff prompt. It omits auth
tokens and project file contents, but the user should still review it before
sending because local paths and stack traces may appear.`,
    {
      issue: z.string().optional().describe("User-visible issue or repro summary."),
      output_path: z.string().optional().describe("Where to write the Markdown report. Defaults to the open project root, or the current working directory if no project is open."),
      include_play_session: z.boolean().optional().default(false).describe("Launch the game briefly and collect post-play diagnostics."),
      play_wait_ms: z.number().optional().default(2500).describe("Milliseconds to wait after launching the game when include_play_session is true."),
      max_console_lines: z.number().optional().default(200).describe("Console lines to include after filtering/deduping."),
      max_debugger_entries: z.number().optional().default(100).describe("Debugger error/warning entries to include after filtering/deduping."),
      include_doctor: z.boolean().optional().default(true).describe("Include summer doctor checks in the report."),
    },
    async ({
      issue,
      output_path,
      include_play_session,
      play_wait_ms,
      max_console_lines,
      max_debugger_entries,
      include_doctor,
    }) => {
      const artifact = await createDebugReportArtifact({
        issue,
        outputPath: output_path,
        includePlaySession: include_play_session,
        playWaitMs: play_wait_ms,
        maxConsoleLines: max_console_lines,
        maxDebuggerEntries: max_debugger_entries,
        includeDoctor: include_doctor,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: true,
                path: artifact.path,
                engineConnected: artifact.report.engine.connected,
                generatedAt: artifact.report.generatedAt,
                issue: artifact.report.issue,
                doctorSummary: artifact.report.doctor?.summary ?? null,
                reviewNote:
                  "Report omits auth tokens, but the user should review local paths and stack traces before sending.",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
