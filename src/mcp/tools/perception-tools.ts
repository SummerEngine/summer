import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withEngine, missingEngineOpResult, withOldEngineHint } from "./with-engine.js";
// engine_lacks_op fallbacks: ONE copy for every face (E2E 2026-09-03 F-16).
import {
  RUNTIME_NODE_FALLBACK,
  RUNTIME_TREE_FALLBACK,
  SNAPSHOT_DIFF_FALLBACK,
  WORLD_SNAPSHOT_FALLBACK,
} from "../../core/capabilities/engine-fallbacks.js";

/**
 * Perception tools. Two signals, two jobs: these ops return STRUCTURED state —
 * exact node paths, transforms, world AABBs, counts — while summer_screenshot
 * returns PIXELS. Structured reads prove facts ("the tree is at (4, 0, -2) and
 * nothing clips"); pixels prove appearance. Run both around every mutation
 * batch; neither substitutes for the other.
 *
 * Every tool here depends on an engine op an older build may lack. Two layers
 * cover that: a capability pre-flight (missingEngineOpResult — nothing is sent
 * when /api/health PROVES the op is missing) and, for engines that advertise
 * nothing, a post-hoc rewrite of the per-op "unknown op" error into the same
 * upgrade path.
 */

/** Amend a classified failure_reason with prescriptive recovery text. The
 *  structured failure_reason stays intact for programmatic callers; only the
 *  human/model-facing error string is taught. Shared with visual-tools.ts
 *  (camera bookmarks). */
export function withFailureReasonHint(
  result: unknown,
  hints: Record<string, string>
): unknown {
  if (!result || typeof result !== "object") return result;
  const envelope = result as Record<string, unknown> & {
    results?: Array<{ ok?: boolean; failure_reason?: string; failureReason?: string; error?: string }>;
  };
  const failed = envelope.results?.find((entry) => entry.ok === false);
  const reason =
    (typeof envelope.failure_reason === "string" && envelope.failure_reason) ||
    (typeof envelope.failureReason === "string" && envelope.failureReason) ||
    failed?.failure_reason ||
    failed?.failureReason;
  if (typeof reason !== "string" || !(reason in hints)) return result;
  const engineError =
    (typeof envelope.error === "string" && envelope.error) || failed?.error || reason;
  return { ...envelope, error: `${hints[reason]} Engine said: ${engineError}` };
}

const GAME_NOT_RUNNING_HINT =
  "No game is running, so there is no runtime tree to read. Start it with summer_play (wait for it to boot), then re-run this tool. For the EDITED scene's structure use summer_get_scene_tree instead — it needs no running game.";

const RUNTIME_TRANSPORT_HINT =
  "This connection cannot carry runtime debugger reads (no async reply channel), or the op was batched with others. Retry it as the ONLY op in the request; if it persists on this transport, probe the running game with a RunVerification probe instead (see the playbook's rawOpsViaBatch).";

export function registerPerceptionTools(server: McpServer): void {
  server.tool(
    "summer_world_snapshot",
    `Compact structured snapshot of the whole EDITED scene — the cheap read to run BEFORE and AFTER every mutation batch. Per node: path, class, transform (pos/rot/scale as Godot literal strings, 3-decimal floats), world AABB (3D visuals), visibility, and 8-hex resource fingerprints (script/materials — detect-change markers, never content). Plus a light summary, camera list, environment fingerprint, and per-class counts.

THE LOOP: summer_world_snapshot (note snapshot_id) -> mutate (summer_run_script / scene tools / imports) -> summer_snapshot_diff from_id:<that id> -> summer_screenshot. The diff proves exactly what changed structurally; the screenshot proves it looks right. This is how you catch a node that silently vanished on save, a transform that landed at the origin, or an AABB clipping through the floor.

Node lists are path-sorted and truncated DETERMINISTICALLY (result carries total_nodes + truncated) so two snapshots stay diffable without phantom adds/removes. The engine retains the last 8 snapshots per session, keyed by snapshot_id. Use this instead of summer_get_scene_tree when you need transforms/AABBs/fingerprints or a diffable baseline; the tree read remains the hierarchy-shaped view. On an engine build that predates GetWorldSnapshot the result is a structured engine_lacks_op failure naming the fallback.`,
    {
      scene_path: z
        .string()
        .optional()
        .describe("Scene to snapshot, e.g. 'res://main.tscn'. Omit for the currently edited scene."),
      max_nodes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Node cap (engine default 4000). The result declares truncation — never assume a capped list is complete."),
    },
    async ({ scene_path, max_nodes }) =>
      withEngine(async (client) => {
        const missing = missingEngineOpResult(client, "GetWorldSnapshot", WORLD_SNAPSHOT_FALLBACK);
        if (missing) return missing;
        const op: Record<string, unknown> = { op: "GetWorldSnapshot" };
        if (scene_path) op.scene_path = scene_path;
        if (max_nodes !== undefined) op.max_nodes = max_nodes;
        const result = await client.executeOps([op]);
        return withFailureReasonHint(
          withOldEngineHint(result, "GetWorldSnapshot", WORLD_SNAPSHOT_FALLBACK),
          {
            no_scene:
              "No scene is open to snapshot. Call summer_get_project_context, then summer_open_main_scene (or summer_open_scene with a known .tscn path), then retry.",
            scene_not_loaded:
              "scene_path resolves only a LIVE editor tab or an already-cached scene — never a disk load. Open that scene first (summer_open_scene), or omit scene_path to snapshot the currently edited scene.",
          }
        );
      })
  );

  server.tool(
    "summer_snapshot_diff",
    `Diff two world snapshots into exactly what changed: added/removed node paths, changed nodes with the fields that moved (pos, scale, material fingerprint, ...), and per-class count deltas. Reads like a receipt — no wading through two full dumps.

Standard use: take summer_world_snapshot BEFORE a mutation batch, mutate, then call this with from_id (to_id omitted = the engine takes a fresh snapshot now). Verify the diff matches your INTENT: exactly the nodes you meant to add were added, nothing you didn't touch changed, nothing vanished. An empty diff after a "successful" mutation is a red flag — the change did not land (wrong scene? unsaved? unowned nodes dropped on save?).

The engine retains the last 8 snapshot ids per session; an expired/unknown id fails with failure_reason "unknown_snapshot" — take a fresh baseline and re-run the mutation check rather than guessing.`,
    {
      from_id: z.string().describe("snapshot_id of the BEFORE snapshot (from summer_world_snapshot)."),
      to_id: z
        .string()
        .optional()
        .describe("snapshot_id of the AFTER snapshot. Omit to snapshot the current state now and diff against that."),
    },
    async ({ from_id, to_id }) =>
      withEngine(async (client) => {
        const missing = missingEngineOpResult(client, "DiffWorldSnapshot", SNAPSHOT_DIFF_FALLBACK);
        if (missing) return missing;
        const op: Record<string, unknown> = { op: "DiffWorldSnapshot", from_id };
        if (to_id) op.to_id = to_id;
        const result = await client.executeOps([op]);
        return withFailureReasonHint(
          withOldEngineHint(result, "DiffWorldSnapshot", SNAPSHOT_DIFF_FALLBACK),
          {
            unknown_snapshot:
              "That snapshot_id is gone (the engine retains only the last 8 per session, and ids do not survive an engine restart). Take a fresh summer_world_snapshot baseline and redo the before/after pair.",
          }
        );
      })
  );

  server.tool(
    "summer_get_runtime_tree",
    `Scene tree of the RUNNING GAME — live runtime state, not the edited scene. Use it during playtests to see what actually spawned: dynamically created enemies/projectiles/UI, autoloads, pooled nodes — everything summer_get_scene_tree (an EDITOR read) can never show. Inspecting live keeps the bug alive; stopping the game to look usually resets it.

Returns {tree: {name, class, path, children}, total_nodes, truncated}. Depth/limit are capped and truncation is declared — never assume a capped tree is complete. Drill into one node's live properties with summer_inspect_runtime_node.

Needs a running game: fails with failure_reason "game_not_running" otherwise — start with summer_play, then re-run.`,
    {
      path: z
        .string()
        .optional()
        .describe("Subtree root to read, e.g. '/root/Main/Enemies'. Omit for the scene tree root."),
      depth: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum depth to walk (engine default 3)."),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum nodes to return (engine default 500)."),
    },
    async ({ path, depth, limit }) =>
      withEngine(async (client) => {
        const missing = missingEngineOpResult(client, "GetRuntimeSceneTree", RUNTIME_TREE_FALLBACK);
        if (missing) return missing;
        const op: Record<string, unknown> = { op: "GetRuntimeSceneTree" };
        if (path) op.path = path;
        if (depth !== undefined) op.depth = depth;
        if (limit !== undefined) op.limit = limit;
        const result = await client.executeOps([op]);
        return withFailureReasonHint(
          withOldEngineHint(result, "GetRuntimeSceneTree", RUNTIME_TREE_FALLBACK),
          {
            game_not_running: GAME_NOT_RUNNING_HINT,
            unsupported_transport: RUNTIME_TRANSPORT_HINT,
          }
        );
      })
  );

  server.tool(
    "summer_inspect_runtime_node",
    `Live properties of ONE node in the RUNNING GAME: {node: {path, class, properties, children_names}} with a curated common-property set (transform, visibility, physics state, ...). The runtime counterpart of summer_inspect_node (which reads the EDITED scene) — use it to answer "what are this enemy's actual stats right now", "where IS the player", "did that flag flip" without stopping the game and losing the state.

Find the path with summer_get_runtime_tree first — runtime paths (e.g. '/root/Main/Enemies/Goblin3') often differ from edited-scene paths because nodes are spawned, renamed, or reparented at runtime.

Needs a running game: fails with failure_reason "game_not_running" otherwise — start with summer_play, then re-run.`,
    {
      path: z.string().describe("Runtime node path, e.g. '/root/Main/Player'. Get it from summer_get_runtime_tree."),
    },
    async ({ path }) =>
      withEngine(async (client) => {
        const missing = missingEngineOpResult(client, "GetRuntimeNode", RUNTIME_NODE_FALLBACK);
        if (missing) return missing;
        const result = await client.executeOps([{ op: "GetRuntimeNode", path }]);
        return withFailureReasonHint(
          withOldEngineHint(result, "GetRuntimeNode", RUNTIME_NODE_FALLBACK),
          {
            game_not_running: GAME_NOT_RUNNING_HINT,
            unsupported_transport: RUNTIME_TRANSPORT_HINT,
            node_not_found:
              "That path does not exist in the RUNNING game (runtime paths are absolute, e.g. '/root/Main/Player', and often differ from the edited scene). List what actually spawned with summer_get_runtime_tree, then retry with a path from its result.",
          }
        );
      })
  );
}
