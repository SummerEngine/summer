import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withEngine } from "./with-engine.js";

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
    "Read recent messages from the editor's Output panel. Shows print statements, warnings, and errors from both the editor and scripts. Use after summer_get_diagnostics indicates console issues.",
    {
      max_lines: z.number().optional().default(100).describe("Max lines to return (default 100)"),
      filter: z.string().optional().describe("Only return lines containing this string"),
      type: z.enum(["error", "warning", "std", "editor"]).optional().describe("Filter by message type"),
    },
    async ({ max_lines, filter, type }) =>
      withEngine(async (client) => {
        const op: Record<string, unknown> = { op: "GetConsoleOutput", max_lines };
        if (filter) op.filter = filter;
        if (type) op.type = type;
        return client.executeOps([op]);
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
    "Read runtime errors and warnings from the debugger. These are errors that occur while the game is running (null references, missing nodes, physics errors). Different from console output — these come from the debugger, not print statements.",
    {
      max_errors: z.number().optional().default(50).describe("Max errors to return"),
      include_stack: z.boolean().optional().describe("Include stack traces for each error"),
    },
    async ({ max_errors, include_stack }) =>
      withEngine(async (client) => {
        const op: Record<string, unknown> = { op: "GetDebuggerErrors", max_errors };
        if (include_stack !== undefined) op.include_stack = include_stack;
        return client.executeOps([op]);
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
    "Stop the running game. Call this before making scene changes — some operations require the game to not be running.",
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
}
