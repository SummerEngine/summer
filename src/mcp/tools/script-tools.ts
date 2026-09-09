import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withEngine, missingEngineOpResult, withOldEngineHint } from "./with-engine.js";
import { lookupApiDocs } from "../../core/capabilities/api-docs.js";
import {
  RUN_EDITOR_SCRIPT_FALLBACK,
  RUN_SCRIPT_FALLBACK,
  buildRunEditorScriptOp,
  buildRunSceneScriptOp,
} from "../../core/capabilities/scene-script.js";

// Re-exported so existing tests keep importing the lookup from the tool module.
export {
  API_DOCS_NOT_INSTALLED,
  isApiDocsBundleInstalled,
  lookupApiDocs,
  resetApiDocsForTests,
} from "../../core/capabilities/api-docs.js";

export function registerScriptTools(server: McpServer): void {
  server.tool(
    "summer_run_script",
    `Run a GDScript snippet INSIDE the live editor, against the currently OPEN scene. This is the scene-scripting workhorse: one script replaces long chains of add-node/set-prop calls, and it can compute (loops, randomness, math, procedural meshes) what individual CRUD ops cannot.

SCRIPT CONTRACT — write ONLY the body below; do not add extends/@tool lines (missing ones are prepended and reported in 'normalizations'):

  func run(ctx):
      var root = ctx.get_scene_root()    # root node of the open scene
      for i in range(10):
          var m := MeshInstance3D.new()
          m.mesh = BoxMesh.new()
          m.position = Vector3(i * 2, 0, 0)
          root.add_child(m)
          ctx.set_owner_recursive(m)     # REQUIRED or the node is NOT saved
      ctx.report("count", 10)            # structured value back to you

- ctx.get_scene_root() — the open scene's root node. Full editor API access.
- ctx.set_owner_recursive(node) — stamps node AND its descendants with the scene-root owner (equivalent to node.owner = root on each). Call it after add_child on every created subtree.
- ctx.report(key, value) — return structured results (comes back in 'reports').
- print(...) — captured and returned in 'output'.
- OWNERSHIP: a created node whose owner is never set silently vanishes when the scene saves — descendants too. ctx.set_owner_recursive covers both.
- Values here are real GDScript — Vector3(0,10,0), Color(1,0,0,1) — NOT the quoted variant strings used by summer_set_prop.

Newer ctx builds also carry creation helpers that set the owner FOR you and return the node — prefer them: ctx.add_node(type, name, parent, props), ctx.find(name), ctx.get_or_create(type, name, parent), ctx.instance_scene(res_path, parent, name), ctx.add_mesh(shape, name, parent, props) / ctx.add_mesh_with_collision(...), ctx.mesh_from_arrays(...), ctx.make_material(props) / ctx.apply_material(node, material), ctx.grid(count_x, count_z, spacing, maker) / ctx.scatter(area, count, maker, seed), ctx.add_light_rig(target), ctx.ensure_environment(props), ctx.add_camera(position, look_at, make_current), ctx.summary(), ctx.save_scene(path). Unknown props keys are reported in 'prop_warnings', never silently dropped. On an older engine a missing helper is a plain GDScript error — fall back to the manual form above.

WHEN TO USE: 3+ related ops, anything with computed placement (scatter, grids, rings), procedural geometry (SurfaceTool/ArrayMesh), bulk renames/retunes. For a single property tweak, summer_set_prop is cheaper. Use summer_api_docs to verify property/method names instead of guessing.

THE LOOP: summer_world_snapshot (keep snapshot_id) -> summer_run_script -> summer_snapshot_diff + summer_screenshot -> inspect -> iterate. Never claim visual success without the screenshot.

Returns {ok, ran, result, reports, output, errors, duration_ms, checkpoint} — newer engines add rolled_back (a runtime error rolled the whole undo action back; the scene is untouched) and budget_enforced (max_seconds was a HARD deadline; when the budget hits, the script errors with "Summer script budget exceeded" — split the work into smaller scripts, never resubmit the same oversized one). Read 'errors' even when ok — with undo:'none', a partially-failed script may have mutated the scene. If this engine build predates RunSceneScript, the result is a structured engine_lacks_op failure (nothing is sent): use summer_run_editor_script or update Summer Engine.`,
    {
      source: z.string().describe(
        "GDScript source containing `func run(ctx):`. No extends/@tool line — just the function (plus any helpers)."
      ),
      max_seconds: z
        .number()
        .optional()
        .describe("Time budget in seconds (default 20, clamped 5-120). The script blocks the editor while it runs — keep it short."),
      checkpoint: z
        .boolean()
        .optional()
        .describe("Take a SummerGit checkpoint before running (default true). The result confesses (no_rewind_point) when no checkpoint could be taken."),
      undo: z
        .enum(["action", "none"])
        .optional()
        .describe(
          "Transaction mode (newer engines). 'action' (engine default): the whole run is ONE named undo action, and a mid-script runtime error rolls it back before returning (result rolled_back:true) — no half-mutated scene. 'none': v1 behavior, checkpoint only. Older engines ignore this."
        ),
    },
    async ({ source, max_seconds, checkpoint, undo }) =>
      withEngine(async (client) => {
        const missing = missingEngineOpResult(client, "RunSceneScript", RUN_SCRIPT_FALLBACK);
        if (missing) return missing;
        const { op, timeoutMs } = buildRunSceneScriptOp({ source, max_seconds, checkpoint, undo });
        const result = await client.executeIdentityBoundOps([op], undefined, timeoutMs);
        return withOldEngineHint(result, "RunSceneScript", "use summer_run_editor_script instead");
      })
  );

  server.tool(
    "summer_run_editor_script",
    `Run a GDScript EditorScript in a FRESH HEADLESS editor spawned against the ON-DISK project. Cold path: a whole child editor boots, runs your script once, and exits — seconds to tens of seconds depending on the project and the script (about 2 s end to end on a small template project; large projects can spend 30 s+ just booting).

USE FOR batch/project-wide jobs that should not block the live editor: re-saving many scenes, sweeping resources, mass import fixes, generating .tres assets, long bakes. It sees ONLY what is saved on disk — unsaved live edits in the open editor are INVISIBLE to it, and the live editor won't show its output until files reload. For work on the OPEN scene, use summer_run_script instead.

SCRIPT CONTRACT — write a plain EditorScript body:

  func _run():
      var scene = load("res://main.tscn").instantiate()
      # ... work ...
      print("done")  # captured into output[]

You may omit the '@tool' and 'extends EditorScript' lines — the engine prepends any that are missing and reports each fix in 'normalizations' (with 'line_offset' so error line numbers map back to your source). Including 'extends EditorScript' yourself is also fine.

Returns {ok, ran, exit_code, output, errors, boot_errors, result, out_dir, checkpoint, normalizations} plus a failure_reason taxonomy on failure (script_parse_failed, timeout, spawn_failed, ...). A top-level no_rewind_point:true means no pre-run checkpoint exists — the run is NOT rewindable; tell the user before doing more destructive work. This headless child has NO renderer: screenshots/pixels are impossible here (see the headless-scripting skill).`,
    {
      source: z.string().describe(
        "EditorScript GDScript source with `func _run():`. '@tool' / 'extends EditorScript' are optional — missing lines are prepended and reported in normalizations."
      ),
      max_seconds: z
        .number()
        .optional()
        .describe("Time budget in seconds for the child editor (default 120, clamped 15-600). Include boot time — large projects can take 30s+ just to start."),
      checkpoint: z
        .boolean()
        .optional()
        .describe("Take a SummerGit checkpoint before the child editor runs. The result confesses (no_rewind_point) when none could be taken."),
    },
    async ({ source, max_seconds, checkpoint }) =>
      withEngine(async (client) => {
        const missing = missingEngineOpResult(client, "RunEditorScript", RUN_EDITOR_SCRIPT_FALLBACK);
        if (missing) return missing;
        const { op, timeoutMs } = buildRunEditorScriptOp({ source, max_seconds, checkpoint });
        return client.executeIdentityBoundOps([op], undefined, timeoutMs);
      })
  );

  server.tool(
    "summer_api_docs",
    `Offline engine class-reference lookup — verify a property, method, signal, or constant BEFORE writing script code, instead of guessing names. No engine connection needed.

Returns for a class: inherits, brief description, properties (name/type/default), method signatures, signals, constants. Pass 'member' to fetch one member (e.g. class_name:'BoxShape3D', member:'size' -> {name:'size', type:'Vector3', default:'Vector3(1, 1, 1)'}). Unknown names return closest-match suggestions.

Entries list only members DECLARED on that class — walk 'inherits' for inherited ones (e.g. 'position' lives on Node3D, not MeshInstance3D). Data is compiled from the engine's class reference and stamped with the engine technical base it was generated from (technical_base in every successful result) — trust it over training memory for version-sensitive APIs; descriptions are trimmed to one line. When the bundled reference is missing from this install, the result says so (api_docs_not_installed) instead of guessing.`,
    {
      class_name: z.string().describe("Engine class name, e.g. 'BoxShape3D', 'CharacterBody3D', 'SurfaceTool'. Case-insensitive."),
      member: z
        .string()
        .optional()
        .describe("Optional property/method/signal/constant name to fetch just that member, e.g. 'size' or 'move_and_slide'."),
    },
    async ({ class_name, member }) => {
      try {
        const result = lookupApiDocs(class_name, member);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          ...(result.ok === false ? { isError: true as const } : {}),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Could not load the bundled api-docs asset (${message}). Reinstall/update the summer-engine package.`,
            },
          ],
          isError: true as const,
        };
      }
    }
  );
}
