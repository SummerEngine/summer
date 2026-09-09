import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withEngine, missingEngineOpResult, withOldEngineHint } from "./with-engine.js";
import { shapeEngineLogResponse } from "../../core/log-filters.js";
import { createDebugReportArtifact } from "../../core/capabilities/debug-report.js";
import { withConsoleScope } from "../../core/capabilities/console-read.js";
import { describePlayDeterminism, pickPlayDeterminism } from "../../core/capabilities/play-determinism.js";
import {
  RUNTIME_FALLBACKS,
  buildStopGameOp,
  playGame,
  playGameExtensionSchema,
  withRuntimeFailureHints,
} from "../../core/capabilities/runtime-control.js";

// summer_get_diagnostics view shaping. The engine serves /api/state/diagnostics
// from a pre-published snapshot (empty args — query params are NOT forwarded on
// that route), so trimming has to happen here. The snapshot defaults bury
// task-specific failures under baseline info noise (50 console messages, up to
// 100 debugger entries); this reorders by severity and caps ONLY the
// low-severity bodies. All counts stay intact and honest. No pattern-matching
// against specific noise strings — severity + recency + caps only.
const CONSOLE_NOISE_TAIL_CAP = 10;
const DEBUGGER_WARNING_CAP = 20;

/**
 * Prioritized, bounded view of the engine diagnostics payload:
 * - console.messages reordered: errors first, then warnings, then a capped tail
 *   of info/std/editor noise (engine order is newest-first; that order is
 *   preserved within each severity bucket, so the kept tail is the most recent).
 * - debugger.errors_data untouched; debugger.warnings_data capped to the most
 *   recent DEBUGGER_WARNING_CAP entries (engine emits newest-first).
 * - a `_view` block with honest counters and a hint pointing at includeAll.
 * Shape-tolerant: anything unexpected passes through unchanged.
 * Exported for unit tests.
 */
export function prioritizeDiagnostics(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const root = payload as Record<string, unknown>;
  if (!root.data || typeof root.data !== "object") return payload;
  const data = root.data as Record<string, unknown>;
  const shapedData: Record<string, unknown> = { ...data };

  let totalConsole = 0;
  let shownConsole = 0;
  let suppressedInfo = 0;
  if (data.console && typeof data.console === "object") {
    const c = data.console as Record<string, unknown>;
    totalConsole = typeof c.total === "number" ? c.total : 0;
    if (Array.isArray(c.messages)) {
      const errors: unknown[] = [];
      const warnings: unknown[] = [];
      const rest: unknown[] = [];
      for (const m of c.messages) {
        const type =
          m && typeof m === "object" ? (m as Record<string, unknown>).type : undefined;
        if (type === "error") errors.push(m);
        else if (type === "warning") warnings.push(m);
        else rest.push(m);
      }
      const keptRest = rest.slice(0, CONSOLE_NOISE_TAIL_CAP);
      suppressedInfo = rest.length - keptRest.length;
      const messages = [...errors, ...warnings, ...keptRest];
      shownConsole = messages.length;
      shapedData.console = { ...c, messages, returned: messages.length };
    }
  }

  let totalDebugger = 0;
  let shownDebugger = 0;
  let suppressedDebuggerWarnings = 0;
  if (data.debugger && typeof data.debugger === "object") {
    const g = data.debugger as Record<string, unknown>;
    totalDebugger =
      (typeof g.errors === "number" ? g.errors : 0) +
      (typeof g.warnings === "number" ? g.warnings : 0);
    const errorsData = Array.isArray(g.errors_data) ? g.errors_data : [];
    if (Array.isArray(g.warnings_data)) {
      const keptWarnings = g.warnings_data.slice(0, DEBUGGER_WARNING_CAP);
      suppressedDebuggerWarnings = g.warnings_data.length - keptWarnings.length;
      shownDebugger = errorsData.length + keptWarnings.length;
      shapedData.debugger = { ...g, warnings_data: keptWarnings };
    } else {
      shownDebugger = errorsData.length;
    }
  }

  return {
    ...root,
    data: shapedData,
    _view: {
      mode: "prioritized",
      totalConsole,
      shownConsole,
      suppressedInfo,
      totalDebugger,
      shownDebugger,
      suppressedDebuggerWarnings,
      hint: "All counts are complete; only low-severity message bodies were trimmed. Re-call with includeAll: true for the untrimmed payload, or use summer_get_console / summer_get_debugger_warnings for targeted reads.",
    },
  };
}

export function registerDebugTools(server: McpServer): void {
  server.tool(
    "summer_get_diagnostics",
    `Quick overview of all errors and warnings from the editor console, the runtime debugger, and script errors together. Returns error counts and a guidance message.

ALWAYS call this FIRST before diving into summer_get_console or summer_get_debugger_errors. It tells you where to look. It is also THE post-play read: a played game's runtime errors land in the debugger section here (and in summer_get_debugger_errors), never in the editor console — summer_get_console alone can honestly report errors 0 right after a play session that produced several.

By default the response is a prioritized view: errors first, then warnings, then a small capped tail of recent info/std noise. Counts (console totals, debugger totals) are always complete — only low-severity message bodies are trimmed, and a "_view" block reports exactly what was suppressed. Pass includeAll: true for the full untrimmed engine payload.

Typical workflow after making changes or playing:
1. summer_get_diagnostics — are there issues? (after a play session: check debugger.errors)
2. If errors: summer_get_debugger_errors (runtime, with stacks) or summer_get_console (editor output) for details
3. Fix the issues
4. summer_get_diagnostics again to verify`,
    {
      includeAll: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Return the full engine diagnostics payload untrimmed (no severity reordering, no info-noise cap)."
        ),
    },
    async ({ includeAll }) =>
      withEngine(async (client) => {
        const raw = await client.getDiagnostics();
        return includeAll ? raw : prioritizeDiagnostics(raw);
      })
  );

  server.tool(
    "summer_get_console",
    `Read recent messages from the editor's Output panel (print() output, editor-side warnings and errors).

SCOPE: the editor console ONLY. Runtime errors from a played game are collected by the debugger, not the console — right after summer_play this tool can honestly report errors 0 while summer_get_debugger_errors holds several. Never treat this tool alone as the post-play verdict: read summer_get_diagnostics (console + debugger + script errors together) first, then come here for message bodies. Every result carries a "_scope" note restating this.

Output is post-processed for token economy: consecutive identical messages collapse into one entry with a "(×N)" count suffix, and the response carries a "_filter" summary so you can see what was hidden. Message types come straight from the editor log (error / warning / std / editor); errors_only=true (default) drops the std/editor lines — startup banners and print() output — and keeps errors and warnings. Use errors_only=false to read print() output, raw=true to bypass all shaping.

Use after summer_get_diagnostics indicates console issues, or to check what your print() statements said.`,
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
        // E2E 2026-09-03 F-07: the console is not where a played game's runtime
        // errors go. Say so on every shaped result, not only in the description.
        return withConsoleScope(result);
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
    `Start running the game in the engine. With no extra parameters the game runs inside Summer Engine's viewport (the 'main' instance) QUIETLY — see below.

QUIET BY DEFAULT (focus:false, PlayGame agent:true): the user is usually working on the same machine while you build, so a play must not take over their screen. Quiet play makes the EDITOR stay put: it does not switch the main screen to the Game tab, does not grab keyboard focus for the embedded game, ignores the game's later focus report, and skips the render-health self-check that would otherwise misread the untouched Game view as a GPU failure and flip the user's embed setting. Quiet play does NOT hide the game: it still runs embedded in the Game view (visible if the user already has that tab open), it is the running game for summer_is_running / summer_screenshot target:'game' / summer_get_diagnostics, and on engines without the background launch posture it does not change a user who has "Embed Game on Play" turned off — their game opens in its own OS window as always. Engines with the background posture (--summer-background, 0.5.66+) also launch the play child with that flag, so a separate-window game appears without activating or taking focus either. The result echoes agent_quiet:true when honoured; a launch result WITHOUT agent_quiet means the engine predates quiet play and most likely took focus — the tool adds posture_note saying so. focus:true launches like the toolbar Play button (Game tab + focus): use it ONLY when the user is watching and asked to see the game come up.

After starting, confirm boot with summer_is_running (boot time varies — never sleep a guessed delay), then summer_get_diagnostics for runtime errors. You can run a specific scene instead of the main scene — useful for testing individual levels or UI screens.

DETERMINISTIC RUNS (newer engines): seed / fixed_fps / time_scale pin THIS launch only (nothing is persisted). seed pins the game's GLOBAL RNG (randi/randf/randi_range/randf_range/randfn, Array.shuffle/pick_random) — it does NOT pin RandomNumberGenerator instances, scripts that call randomize(), rand_from_seed, wall-clock reads, or thread/IO/audio timing. fixed_fps decouples scene time from the wall clock so frame-count-derived state lands on the same frame run to run. The result's \`determinism\` block says whether the pins were applied (applied:false carries a reason: already_running, editor_run_args_override, launch_not_started) and restates seed_scope. If the result has NO determinism block although you sent a pin, the engine predates the params and the run is NOT reproducible — the tool says so; do not claim otherwise. Omitting every pin and instance parameter is exactly the v1 launch.

PLAYTEST LAUNCH (engine runtime-control build): instance + mode:'offscreen' spawn a disposable hidden instance (at most 3) that summer_game_probe / summer_game_input / summer_game_control / summer_runtime_* address by name — run two variants side by side for an A/B. deterministic:true (offscreen only) launches with --fixed-fps 60 --summer-seed --audio-driver Dummy and is what lets summer_game_input action:'replay' accept a seed; speed sets the user time scale on session start. The instance result reports session_attached; poll summer_game_control action:'instances' until attached:true before addressing it. Then: probe -> act -> step/probe -> assert (the agent-playtesting skill). Failure reasons: too_many_instances, instance_exists, session_timeout (child never attached — check summer_get_console), unsupported_mode, main_scene_not_configured. A game already running answers playing:true with determinism.applied:false — summer_stop first to apply seed/fixed_fps.`,
    {
      scene: z.string().optional().describe("Scene to run instead of main scene, e.g. 'res://levels/test_level.tscn'"),
      ...playGameExtensionSchema,
    },
    async (args) => {
      const requested = pickPlayDeterminism({ seed: args.seed, fixed_fps: args.fixed_fps, time_scale: args.time_scale });
      return withEngine(
        // ONE implementation with the CLI face (runtime-control.ts playGame):
        // route choice, validation, Wave I pre-flight, old-engine / instance /
        // posture annotations. A ToolInputError propagates to withEngine.
        async (client) => playGame(client, args),
        {
          toContent: (result) => {
            const json = JSON.stringify(result, null, 2);
            // Surface applied / reason / seed_scope in prose so the model does not
            // have to dig; and call out the old-engine case (pins sent, no
            // determinism block back) as "not applied" instead of staying silent.
            const summary = describePlayDeterminism(result, requested);
            return [{ type: "text" as const, text: summary ? `${json}\n\n${summary}` : json }];
          },
        }
      );
    }
  );

  server.tool(
    "summer_stop",
    "Stop the running game. Use after runtime verification or when you intentionally need to restart the running instance; ordinary editor scene mutations do not require a blanket stop. Pass instance to stop ONE offscreen instance started with summer_play {instance, mode:'offscreen'} (the result reports was_playing and killed); omit it for the editor's main game.",
    {
      instance: z
        .string()
        .optional()
        .describe("Offscreen instance name to stop (from summer_play {instance}); omit for the main embedded game."),
    },
    async ({ instance }) =>
      withEngine(async (client) => {
        if (typeof instance !== "string" || instance.trim().length === 0 || instance.trim() === "main") {
          return client.stop();
        }
        const missing = missingEngineOpResult(client, "ListGameInstances", RUNTIME_FALLBACKS.ListGameInstances!);
        if (missing) return missing;
        const { op, timeoutMs } = buildStopGameOp(instance);
        const result = await client.executeOps([op], undefined, timeoutMs);
        return withRuntimeFailureHints(withOldEngineHint(result, "StopGame", RUNTIME_FALLBACKS.ListGameInstances!));
      })
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
