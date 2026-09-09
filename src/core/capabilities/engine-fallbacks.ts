/**
 * engine-fallbacks — the `engine_lacks_op` fallback sentences, ONE copy for
 * every face (src/mcp/tools/spatial-tools.ts, src/mcp/tools/perception-tools.ts,
 * src/core/capabilities/tool-dispatch.ts). Each names what an agent should do
 * on an engine build that lacks the op, whether the capability pre-flight
 * refused before sending (missingEngineOpResult) or the engine answered
 * "unknown op" (withOldEngineHint) — the sentence is identical either way.
 *
 * Rule (E2E 2026-09-03 F-16): a fallback names ONLY tools every shipped engine
 * has — summer_get_scene_tree, summer_inspect_node, summer_inspect_resource,
 * summer_set_prop, summer_screenshot, a RunVerification probe.
 * summer_world_snapshot is itself engine_lacks_op on every shipped build, so a
 * fallback that routes through it sends the agent from one dead end to the
 * next. The scripting fallbacks live with their op builders in ./scene-script.ts.
 */

export const WORLD_SNAPSHOT_FALLBACK =
  "read structure with summer_get_scene_tree (pass depth) and verify visually with summer_screenshot";

export const SNAPSHOT_DIFF_FALLBACK =
  "re-read with summer_get_scene_tree (pass depth) and summer_inspect_node and compare against your earlier read yourself";

export const RUNTIME_TREE_FALLBACK =
  "probe runtime state with a RunVerification probe (dump_tree/report — see the playbook's rawOpsViaBatch)";

export const RUNTIME_NODE_FALLBACK =
  "probe the node from a RunVerification probe (report(key, value) — see the playbook's rawOpsViaBatch)";

export const TEST_PLACEMENT_FALLBACK =
  "list the subject and its neighbours with summer_get_scene_tree, read their positions and mesh/shape sizes with summer_inspect_node (summer_inspect_resource for mesh/shape extents), judge clearance from those, then verify with summer_screenshot";

export const SNAP_TO_SURFACE_FALLBACK =
  "read the support's position and mesh/shape size with summer_inspect_node / summer_inspect_resource, set the subject's position with summer_set_prop so its bottom sits on the support's top, and verify with summer_screenshot";

export const ALIGN_DISTRIBUTE_FALLBACK =
  "compute the shared anchor or spacing from the subjects' positions and sizes (summer_inspect_node / summer_inspect_resource) and set each subject's position with summer_set_prop (or one summer_run_editor_script)";

export const NAVIGATION_PROBE_FALLBACK =
  "probe reachability from a RunVerification probe (NavigationServer3D.map_get_path — see the playbook's rawOpsViaBatch)";

export const STARCAST_FALLBACK =
  "read the subject and its neighbours with summer_get_scene_tree + summer_inspect_node and judge support, contact, and clearance from their positions and sizes, then verify with summer_screenshot";

/** Every fallback, for the parity test: none may mention summer_world_snapshot. */
export const ENGINE_OP_FALLBACKS: Readonly<Record<string, string>> = {
  GetWorldSnapshot: WORLD_SNAPSHOT_FALLBACK,
  DiffWorldSnapshot: SNAPSHOT_DIFF_FALLBACK,
  GetRuntimeSceneTree: RUNTIME_TREE_FALLBACK,
  GetRuntimeNode: RUNTIME_NODE_FALLBACK,
  TestPlacement3D: TEST_PLACEMENT_FALLBACK,
  SnapToSurface: SNAP_TO_SURFACE_FALLBACK,
  AlignDistribute3D: ALIGN_DISTRIBUTE_FALLBACK,
  NavigationProbe3D: NAVIGATION_PROBE_FALLBACK,
  Starcast3D: STARCAST_FALLBACK,
};
