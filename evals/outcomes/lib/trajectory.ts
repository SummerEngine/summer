/**
 * Golden trajectories and replay (design §2.2).
 *
 * A golden is a trajectory in the toolkit's eval-mode FULL capture format
 * (src/core/trajectory.ts, SUMMER_TRAJECTORY_EVAL=1): one JSONL record per
 * tool call — {ts, kind:"tool_call", tool, args, result:{ok, …}, durationMs}.
 * Hand-authored goldens are compiled from golden/src/*.yaml by
 * golden/compile.ts and carry a leading {kind:"golden", …} header line.
 *
 * Replay re-issues each record through the toolkit's OWN tool table
 * (src/core/capabilities/tool-dispatch.ts — the same functions `summer tool
 * <slug>` and the MCP tools call), bound to the eval editor by project path.
 * Why in-process dispatch and not `node dist/bin/summer.js tool …`: the CLI
 * command has no --project selector and resolves the engine through the
 * machine-global ~/.summer/api-port pointer, which the eval editor is booted
 * NOT to publish (--summer-no-publish) — so a subprocess would either find no
 * engine or, worse, a developer's own open editor. dispatchTool() with a
 * project-bound context is exactly what `summer mcp --project <dir>` does, and
 * it keeps every TS adapter (pre-flight, scenePath re-targeting, receipt
 * classification) inside the measured system.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dispatchTool, resolveToolDispatch, ToolDispatchError, ToolResultError, type ToolDispatchContext } from "../../../dist/core/capabilities/tool-dispatch.js";
import { extractOpError } from "../../../dist/core/capabilities/engine-receipt.js";
import { recordToolCall } from "../../../dist/core/trajectory.js";

export interface GoldenHeader {
  kind: "golden";
  task: string;
  description?: string;
  mutation?: string;
  /** Mutants: the assertion ids this broken golden must fail — exactly these. */
  expect_fail?: string[];
  source?: string;
  recorded_at?: string;
}

export interface GoldenRecord {
  ts?: string;
  kind: "tool_call";
  tool: string;
  args: Record<string, unknown> | null;
  result?: { ok?: boolean; failureReason?: string; terminalState?: string; errorClass?: string };
  durationMs?: number;
}

export interface GoldenTrajectory {
  file: string;
  sha256: string;
  header: GoldenHeader | null;
  records: GoldenRecord[];
  /** Non tool_call records (feedback, unknown kinds) — counted, not replayed. */
  other_records: number;
}

export function loadGolden(file: string): GoldenTrajectory {
  const text = readFileSync(file, "utf8");
  const sha256 = createHash("sha256").update(text).digest("hex");
  let header: GoldenHeader | null = null;
  const records: GoldenRecord[] = [];
  let other = 0;
  for (const [i, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`${file}:${i + 1}: not JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    if (parsed.kind === "golden") {
      header = parsed as unknown as GoldenHeader;
    } else if (parsed.kind === "tool_call") {
      if (typeof parsed.tool !== "string") throw new Error(`${file}:${i + 1}: tool_call without tool`);
      if (!("args" in parsed)) throw new Error(`${file}:${i + 1}: tool_call without args — a redacted trajectory (argsRedacted) is not replayable; record with SUMMER_TRAJECTORY_EVAL=1`);
      records.push(parsed as unknown as GoldenRecord);
    } else {
      other++;
    }
  }
  return { file, sha256, header, records, other_records: other };
}

// ---------------------------------------------------------------------------
// Tool -> engine op needs (pre-flight against /api/health capabilities.opKinds)
// ---------------------------------------------------------------------------

/** Ops each replayable tool sends. Mirrors the op literals in
 *  src/core/capabilities/tool-dispatch.ts (CLI_KNOWN_OP_NEEDS is the flat
 *  union); tools missing here are treated as needing no engine op. */
export const TOOL_OPS: Record<string, string[]> = {
  summer_run_script: ["RunSceneScript"],
  summer_run_editor_script: ["RunEditorScript"],
  summer_world_snapshot: ["GetWorldSnapshot"],
  summer_snapshot_diff: ["DiffWorldSnapshot"],
  summer_get_runtime_tree: ["GetRuntimeSceneTree"],
  summer_inspect_runtime_node: ["GetRuntimeNode"],
  summer_add_node: ["AddNode"],
  summer_set_prop: ["SetProp"],
  summer_set_resource_property: ["SetResourceProperty"],
  summer_remove_node: ["RemoveNode"],
  summer_save_scene: ["SaveScene"],
  summer_open_scene: ["OpenScene"],
  summer_open_main_scene: ["OpenScene"],
  summer_instantiate_scene: ["InstantiateScene"],
  summer_connect_signal: ["ConnectSignal"],
  summer_replace_node: ["ReplaceNode"],
  summer_select_node: ["SelectNode"],
  summer_input_map_bind: ["InputMapAddAction", "InputMapBind"],
  summer_project_setting: ["ProjectSetting"],
  summer_write_file: ["WriteFile"],
  summer_replace_text: ["WriteFile"],
  summer_create_scene: ["WriteFile"],
  summer_import_from_url: ["ImportFromUrl"],
  summer_import_from_url_batch: ["ImportFromUrlBatch"],
  summer_get_console: ["GetConsoleOutput"],
  summer_clear_console: ["ClearConsoleOutput"],
  summer_get_debugger_errors: ["GetDebuggerErrors"],
  summer_get_debugger_warnings: ["GetDebuggerErrors"],
  summer_is_running: ["IsGameRunning"],
  summer_test_placement: ["TestPlacement3D"],
  summer_snap_to_surface: ["SnapToSurface"],
  summer_align_distribute_3d: ["AlignDistribute3D"],
  summer_navigation_probe: ["NavigationProbe3D"],
  summer_starcast: ["Starcast3D"],
};

export function recordOpNeeds(record: GoldenRecord): string[] {
  const args = record.args ?? {};
  if (record.tool === "summer_batch" && Array.isArray(args.ops)) {
    return (args.ops as Array<Record<string, unknown>>).map((op) => String(op.op ?? "")).filter(Boolean);
  }
  if (record.tool === "summer_screenshot") {
    const target = typeof args.target === "string" ? args.target : "viewport";
    return [target === "scene" ? "ScenePreview" : target === "game" ? "GameSnapshot" : "ViewportSnapshot"];
  }
  return TOOL_OPS[record.tool] ?? [];
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export interface ReplayStep {
  index: number;
  tool: string;
  ok: boolean;
  failure_reason?: string;
  error?: string;
  recorded_ok: boolean | null;
  recorded_failure_reason?: string;
  divergent: boolean;
  durationMs: number;
  /** Set when the tool is not in the dispatch table (host-side call). */
  skipped?: true;
}

export interface ReplayOutcome {
  steps: ReplayStep[];
  divergence: ReplayStep[];
  skipped: number;
  /** Fresh results, in order, for callers that want to inspect them (e.g.
   *  snapshot ids). Not persisted by the runner. */
  results: unknown[];
}

function failureReasonFromMessage(message: string): string | undefined {
  // extractOpError renders classified failures as a JSON object with
  // failure_reason (engine-receipt.ts); read it back rather than scraping.
  const start = message.indexOf("{");
  if (start === -1) return undefined;
  try {
    const parsed = JSON.parse(message.slice(start, message.lastIndexOf("}") + 1)) as { failure_reason?: unknown };
    return typeof parsed.failure_reason === "string" ? parsed.failure_reason : undefined;
  } catch {
    return undefined;
  }
}

/** Re-issue every record through dispatchTool. Never throws on a tool
 *  failure — failures are steps with ok:false and count as divergence when
 *  the golden recorded ok:true (and vice versa). `onCall` receives the same
 *  TrajectoryToolCall shape the MCP server records, so the run directory gets
 *  a real trajectory.jsonl / trajectory.full.jsonl pair. */
export async function replayTrajectory(
  golden: GoldenTrajectory,
  ctx: ToolDispatchContext,
  options: { record?: boolean } = {}
): Promise<ReplayOutcome> {
  const steps: ReplayStep[] = [];
  const results: unknown[] = [];
  let skipped = 0;
  for (const [index, record] of golden.records.entries()) {
    const recordedOk = typeof record.result?.ok === "boolean" ? record.result.ok : null;
    const recordedReason = record.result?.failureReason;
    if (!resolveToolDispatch(record.tool)) {
      skipped++;
      steps.push({ index, tool: record.tool, ok: false, recorded_ok: recordedOk, ...(recordedReason ? { recorded_failure_reason: recordedReason } : {}), divergent: false, durationMs: 0, skipped: true });
      results.push(undefined);
      continue;
    }
    const startedAt = Date.now();
    let ok = true;
    let failureReason: string | undefined;
    let error: string | undefined;
    let result: unknown;
    try {
      result = await dispatchTool(record.tool, record.args ?? {}, ctx);
      const opError = extractOpError(result);
      if (opError) {
        ok = false;
        error = opError;
        failureReason = failureReasonFromMessage(opError);
      }
    } catch (err) {
      ok = false;
      if (err instanceof ToolResultError) {
        result = err.result;
        failureReason = typeof err.result.failure_reason === "string" ? err.result.failure_reason : undefined;
        error = err.message;
      } else if (err instanceof ToolDispatchError) {
        error = err.message;
        failureReason = failureReasonFromMessage(err.message) ?? "dispatch_error";
      } else {
        error = err instanceof Error ? err.message : String(err);
        failureReason = "exception";
      }
    }
    const durationMs = Date.now() - startedAt;
    if (options.record !== false) {
      recordToolCall({
        tool: record.tool,
        args: record.args ?? {},
        isError: !ok,
        ...(failureReason ? { failureReason } : {}),
        ...(!ok && !result ? { exception: error } : {}),
        durationMs,
        result,
      });
    }
    const divergent = recordedOk !== null && (recordedOk !== ok || (recordedReason ?? undefined) !== (ok ? undefined : failureReason));
    steps.push({
      index,
      tool: record.tool,
      ok,
      ...(failureReason ? { failure_reason: failureReason } : {}),
      ...(error ? { error: error.slice(0, 2000) } : {}),
      recorded_ok: recordedOk,
      ...(recordedReason ? { recorded_failure_reason: recordedReason } : {}),
      divergent,
      durationMs,
    });
    results.push(result);
  }
  return { steps, divergence: steps.filter((s) => s.divergent), skipped, results };
}
