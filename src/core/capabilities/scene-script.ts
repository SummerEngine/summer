/**
 * Scene-scripting op builders (tool/run-script, tool/run-editor-script).
 * Shared by the MCP tools and the CLI dispatcher so both surfaces send the
 * same op with the same clamps and the same client poll budget.
 *
 * Server-side clamps: RunSceneScript blocks between frames of the LIVE editor,
 * so its ceiling is deliberately low; RunEditorScript boots a whole headless
 * child editor, so its floor covers the boot cost (editor_script_ops.cpp:
 * 15..600 default 120).
 */

export const SCENE_SCRIPT_MIN_SECONDS = 5;
export const SCENE_SCRIPT_MAX_SECONDS = 120;
export const SCENE_SCRIPT_DEFAULT_SECONDS = 20;
export const EDITOR_SCRIPT_MIN_SECONDS = 15;
export const EDITOR_SCRIPT_MAX_SECONDS = 600;
export const EDITOR_SCRIPT_DEFAULT_SECONDS = 120;

/** What each tool tells the model to do when the engine lacks its op. */
export const RUN_SCRIPT_FALLBACK =
  "use summer_run_editor_script (a headless child editor against the ON-DISK project) for the same work";
export const RUN_EDITOR_SCRIPT_FALLBACK =
  "run the script from a shell with the engine binary --headless --script (see the headless-scripting skill)";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export interface RunSceneScriptArgs {
  source: string;
  max_seconds?: number;
  checkpoint?: boolean;
  undo?: "action" | "none";
}

export interface RunEditorScriptArgs {
  source: string;
  max_seconds?: number;
  checkpoint?: boolean;
}

export interface BuiltScriptOp {
  op: Record<string, unknown>;
  /** Client poll budget — MUST outlive the engine's own max_seconds, or a
   *  long-but-successful run is reported as timed_out client-side. */
  timeoutMs: number;
}

export function buildRunSceneScriptOp(args: RunSceneScriptArgs): BuiltScriptOp {
  const budgetSeconds = clamp(
    args.max_seconds ?? SCENE_SCRIPT_DEFAULT_SECONDS,
    SCENE_SCRIPT_MIN_SECONDS,
    SCENE_SCRIPT_MAX_SECONDS
  );
  const op: Record<string, unknown> = {
    op: "RunSceneScript",
    script_source: args.source,
    max_seconds: budgetSeconds,
    checkpoint: args.checkpoint ?? true,
  };
  if (args.undo) op.undo = args.undo;
  return { op, timeoutMs: budgetSeconds * 1000 + 30_000 };
}

export function buildRunEditorScriptOp(args: RunEditorScriptArgs): BuiltScriptOp {
  const budgetSeconds = clamp(
    args.max_seconds ?? EDITOR_SCRIPT_DEFAULT_SECONDS,
    EDITOR_SCRIPT_MIN_SECONDS,
    EDITOR_SCRIPT_MAX_SECONDS
  );
  const op: Record<string, unknown> = {
    op: "RunEditorScript",
    script_source: args.source,
    max_seconds: budgetSeconds,
  };
  if (args.checkpoint !== undefined) op.checkpoint = args.checkpoint;
  return { op, timeoutMs: budgetSeconds * 1000 + 60_000 };
}
