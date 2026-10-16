/**
 * summer_run_script with a target scene. The engine's RunSceneScript runs
 * against the scene the editor is editing and takes no target of its own, so
 * a scenePath is honored here, the same way for the MCP tool and the CLI:
 *
 * 1. Read the scene the editor is editing (a snapshot up to ~300 ms old).
 * 2. OpenScene scenePath, alone (never in one batch with a mutation), even
 *    when the snapshot says it is already the edited scene: the person may
 *    have switched tabs since, and opening the current scene again changes
 *    nothing. The engine answers ok only once that scene is the edited one,
 *    so a failed open stops here and the script never runs.
 * 3. Run the script.
 * 4. Give the person back the tab they had (OpenScene of the earlier scene),
 *    as the engine's own scene-targeted ops do.
 *
 * The result is the engine's RunSceneScript receipt plus `scene_target`.
 */
import { resolveCurrentScene } from "./project-context.js";
import { buildRunSceneScriptOp, type RunSceneScriptArgs } from "./scene-script.js";
import { validateScenePath } from "./seeing/seeing.js";
import { extractOpError } from "./engine-receipt.js";

export interface SceneScriptClient {
  executeIdentityBoundOps(ops: Record<string, unknown>[], options?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  getSceneState(): Promise<unknown>;
}

export interface SceneTarget {
  scenePath: string;
  /** The script's scene was not the edited one, so its tab was brought forward. */
  opened: boolean;
  /** The scene the editor showed before, opened again after the run. */
  restored?: string;
  /** Why that tab could not be restored (the script still ran). */
  restore_error?: string;
}

function withTarget(result: unknown, target: SceneTarget): unknown {
  return result && typeof result === "object" && !Array.isArray(result)
    ? { ...(result as Record<string, unknown>), scene_target: target }
    : { result, scene_target: target };
}

export async function runSceneScriptOn(
  client: SceneScriptClient,
  args: RunSceneScriptArgs & { scenePath?: string }
): Promise<unknown> {
  const { op, timeoutMs } = buildRunSceneScriptOp(args);
  if (args.scenePath === undefined) return client.executeIdentityBoundOps([op], undefined, timeoutMs);

  const scenePath = validateScenePath(args.scenePath);
  let before: string | null = null;
  let beforeError: string | undefined;
  try {
    before = resolveCurrentScene(undefined, await client.getSceneState(), undefined);
  } catch (error) {
    beforeError = error instanceof Error ? error.message : String(error);
  }

  const open = await client.executeIdentityBoundOps([{ op: "OpenScene", path: scenePath }]);
  const openError = extractOpError(open);
  if (openError) {
    return {
      ok: false,
      error: `Could not open ${scenePath}, so the script did not run. ${openError}`,
      failure_reason: "scene_target_failed",
      scene_target: { scenePath, opened: false },
      receipt: open,
    };
  }

  const opened = before !== scenePath;
  const result = await client.executeIdentityBoundOps([op], undefined, timeoutMs);
  const target: SceneTarget = { scenePath, opened };
  if (beforeError !== undefined) target.restore_error = `The scene open before could not be read, so no tab was restored: ${beforeError}`;
  if (opened && before) {
    try {
      const restore = await client.executeIdentityBoundOps([{ op: "OpenScene", path: before }]);
      const restoreError = extractOpError(restore);
      if (restoreError) target.restore_error = restoreError;
      else target.restored = before;
    } catch (error) {
      target.restore_error = error instanceof Error ? error.message : String(error);
    }
  }
  return withTarget(result, target);
}
