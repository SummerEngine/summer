import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withEngine, ToolInputError } from "./with-engine.js";
import { executeOpsChunked, executeSceneMutation } from "../../core/capabilities/engine-ops.js";
import { annotateVariantTypes } from "../../core/capabilities/variant-types.js";
import {
  FALLBACK_SINGLE_ONLY_OPS,
  resolveSingleOnlyOps,
} from "../../core/capability-skew.js";

// Re-exported for tests and for callers that reason about dispatch classes.
// executeSceneMutation is the ONE copy in core/capabilities/engine-ops.ts,
// re-exported here for the spatial tools (snap / align).
export { FALLBACK_SINGLE_ONLY_OPS, resolveSingleOnlyOps, executeSceneMutation };

function requireSuccessfulOps(result: unknown, context: string): Record<string, unknown> {
  const receipt = (result ?? {}) as Record<string, unknown>;
  const results = Array.isArray(receipt.results)
    ? receipt.results as Array<Record<string, unknown>>
    : [];
  const failed = results.find((entry) => entry?.ok === false);
  if (receipt.status === "error" || failed) {
    const error =
      (typeof failed?.error === "string" && failed.error) ||
      (typeof receipt.error === "string" && receipt.error) ||
      `${context} failed`;
    throw new Error(error);
  }
  return receipt;
}

/** Compose the minimal valid .tscn text scene: header + one root node.
 *  `uid` and `load_steps` are optional in the engine parser
 *  (resource_format_text.cpp treats a missing uid as INVALID_ID); the editor
 *  assigns a uid on first save. */
function minimalSceneText(rootName: string, rootType: string): string {
  return `[gd_scene format=3]\n\n[node name="${rootName}" type="${rootType}"]\n`;
}

// Node names reject . : @ / " %; the type must be a plain class name.
// Both are interpolated into quoted .tscn fields, so validate before composing.
const VALID_ROOT_NAME = /^[A-Za-z_][A-Za-z0-9_\- ]*$/;
const VALID_ROOT_TYPE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function registerSceneTools(server: McpServer): void {
  server.tool(
    "summer_create_scene",
    `Create a new empty scene file. Writes a minimal .tscn through the identity-bound engine with a create-only guard: it fails if the path already exists, and it never touches the currently open scene.

The new scene is on disk but NOT opened. Call summer_open_scene to start editing it, then summer_add_node to build it out.

Recommended workflow:
1) Call summer_get_project_context
2) Call summer_create_scene with a new res:// path
3) Call summer_open_scene with that path`,
    {
      path: z.string().describe("New scene path, e.g. 'res://scenes/empty_level.tscn'"),
      rootName: z.string().default("Main").describe("Root node name for the new scene"),
      rootType: z
        .string()
        .default("Node3D")
        .describe(
          "Root node type. Default 'Node3D' (3D scenes); common alternatives: 'Node2D' (2D scenes), 'Control' (UI scenes), 'Node' (logic-only)."
        ),
      allow_temporary_scene_mutation: z
        .boolean()
        .optional()
        .describe(
          "DEPRECATED, ignored. Scene creation no longer mutates any open scene; kept only so older callers don't break."
        ),
    },
    async ({ path, rootName, rootType }) =>
      withEngine(async (client) => {
        const safePath = path.trim().replace(/\\/g, "/");
        if (!safePath.startsWith("res://") || safePath.includes("..")) {
          throw new ToolInputError("Scene path must be a traversal-free res:// project path.");
        }
        if (!safePath.endsWith(".tscn")) {
          throw new ToolInputError("New scenes must use the text format: the path must end in .tscn.");
        }
        if (!VALID_ROOT_NAME.test(rootName)) {
          throw new ToolInputError(
            `Invalid rootName "${rootName}": use letters, digits, underscores, hyphens, or spaces, starting with a letter or underscore.`
          );
        }
        if (!VALID_ROOT_TYPE.test(rootType)) {
          throw new ToolInputError(
            `Invalid rootType "${rootType}": must be a plain class name like 'Node3D', 'Node2D', or 'Control'.`
          );
        }

        // Same engine-routed guarded write path summer_write_file uses:
        // identity-bound, and mustNotExist makes the engine refuse (create-only)
        // if the path already exists. The open scene is never touched.
        const receipt = requireSuccessfulOps(
          await client.executeIdentityBoundOps([
            {
              op: "WriteFile",
              path: safePath,
              content: minimalSceneText(rootName, rootType),
              mustNotExist: true,
            },
          ]),
          `Creating ${safePath}`,
        );

        // Post-write verification: read the file back through the engine. The
        // write receipt already passed; a read-back failure is reported honestly
        // instead of failing the create or being masked.
        let verified = false;
        let verifyError: string | undefined;
        try {
          const read = (await client.readProjectFile(safePath, 4096)) as {
            ok?: boolean;
            error?: unknown;
            data?: { content?: unknown };
          };
          const content = typeof read?.data?.content === "string" ? read.data.content : null;
          if (read?.ok === false) {
            verifyError = String(read.error ?? "engine could not read the file back");
          } else if (content === null) {
            verifyError = "engine returned no text content on read-back";
          } else if (!content.includes(`[node name="${rootName}"`)) {
            verifyError = "read-back content does not contain the expected root node";
          } else {
            verified = true;
          }
        } catch (err) {
          verifyError = err instanceof Error ? err.message : String(err);
        }

        return {
          ok: true,
          created: safePath,
          rootName,
          rootType,
          verified,
          ...(verifyError ? { verifyError } : {}),
          receipt,
          hint: "The new scene is on disk but not open. Call summer_open_scene to start editing it.",
        };
      })
  );

  server.tool(
    "summer_add_node",
    `Add a new node to the scene tree.

Pass the exact res:// scenePath to mutate. The scene does not need to be the
active editor tab.

Common node types:
- 3D: Node3D, MeshInstance3D, CharacterBody3D, RigidBody3D, StaticBody3D, Camera3D, DirectionalLight3D, OmniLight3D, SpotLight3D, WorldEnvironment, CollisionShape3D, Area3D
- 2D: Node2D, Sprite2D, CharacterBody2D, RigidBody2D, StaticBody2D, Camera2D, CollisionShape2D, Area2D, TileMapLayer
- UI: Control, Label, Button, TextEdit, Panel, VBoxContainer, HBoxContainer, MarginContainer
- Audio: AudioStreamPlayer, AudioStreamPlayer3D

The parent path uses "./" prefix for relative paths from scene root. E.g., "./World" means the "World" child of the root node.`,
    {
      scenePath: z.string().describe("Target scene path, e.g. 'res://main.tscn'"),
      parent: z.string().describe("Parent node path, e.g. './World' or './World/Enemies'"),
      type: z.string().describe("Summer Engine node type, e.g. 'MeshInstance3D', 'CharacterBody3D'"),
      name: z.string().describe("Name for the new node, e.g. 'Player', 'MainCamera'"),
    },
    async ({ scenePath, parent, type, name }) =>
      withEngine(async (client) =>
        executeSceneMutation(client, scenePath, [{ op: "AddNode", parent, type, name }])
      )
  );

  server.tool(
    "summer_set_prop",
    `Set a property on a node. This is the primary way to configure nodes after adding them.

VALUE FORMAT — Godot string syntax for complex types:
- Vector3: "Vector3(0, 10, 0)" — position, scale, rotation_degrees
- Vector2: "Vector2(100, 200)" — 2D position, size
- Color: "Color(1, 0.5, 0, 1)" — RGBA, always 4 components, values 0.0-1.0
- Transform3D: "Transform3D(1,0,0, 0,1,0, 0,0,1, 0,5,0)" — basis + origin
- Resource class name: "BoxMesh", "SphereMesh", "StandardMaterial3D" — auto-instantiated
- Numbers: 1.5, 42 — native JSON
- Booleans: true, false — native JSON
- Strings: "hello" — native JSON

COMMON PROPERTIES:
- position: "Vector3(x, y, z)" — world position
- rotation_degrees: "Vector3(rx, ry, rz)" — rotation in degrees
- scale: "Vector3(sx, sy, sz)" — scale factor
- visible: true/false — visibility
- mesh: "BoxMesh", "SphereMesh", "CapsuleMesh", "CylinderMesh", "PlaneMesh"
- shadow_enabled: true — for lights
- light_energy: 1.5 — light intensity
- fov: 75.0 — camera field of view`,
    {
      scenePath: z.string().describe("Target scene path, e.g. 'res://main.tscn'"),
      path: z.string().describe("Node path, e.g. './World/Player'"),
      key: z.string().describe("Property name, e.g. 'position', 'mesh', 'visible'"),
      value: z.union([z.string(), z.number(), z.boolean()]).describe(
        "Value in Summer Engine variant-string format for complex types, native JSON for primitives"
      ),
    },
    async ({ scenePath, path, key, value }) =>
      withEngine(async (client) =>
        executeSceneMutation(client, scenePath, [{ op: "SetProp", path, key, value }])
      )
  );

  server.tool(
    "summer_set_resource_property",
    `Set a nested property on a resource attached to a node.

Use when you need to modify a sub-property of a resource, like:
- CollisionShape3D shape size: nodePath="./Player/CollisionShape3D", resourceProperty="shape", subProperty="size", value="Vector3(1, 2, 1)"
- Material albedo color: nodePath="./Floor", resourceProperty="material_override", subProperty="albedo_color", value="Color(0.2, 0.5, 0.2, 1)"
- Mesh size: nodePath="./Box", resourceProperty="mesh", subProperty="size", value="Vector3(2, 2, 2)"`,
    {
      scenePath: z.string().describe("Target scene path, e.g. 'res://main.tscn'"),
      nodePath: z.string().describe("Node path, e.g. './Player/CollisionShape3D'"),
      resourceProperty: z.string().describe("Resource property on the node, e.g. 'shape', 'mesh', 'material_override'"),
      subProperty: z.string().describe("Property on the resource, e.g. 'size', 'radius', 'albedo_color'"),
      value: z.union([z.string(), z.number(), z.boolean()]).describe("Value in Summer Engine variant-string format"),
    },
    async ({ scenePath, nodePath, resourceProperty, subProperty, value }) =>
      withEngine(async (client) =>
        executeSceneMutation(client, scenePath, [
          { op: "SetResourceProperty", nodePath, resourceProperty, subProperty, value },
        ])
      )
  );

  server.tool(
    "summer_remove_node",
    "Remove a node from the scene tree. All children are removed too. Cannot remove the root node. Supports undo. Destructive operation: do not delete multiple top-level nodes unless the user explicitly requests destructive changes.",
    {
      scenePath: z.string().describe("Target scene path, e.g. 'res://main.tscn'"),
      path: z.string().describe("Node path to remove, e.g. './World/OldEnemy'"),
    },
    async ({ scenePath, path }) =>
      withEngine(async (client) => executeSceneMutation(client, scenePath, [{ op: "RemoveNode", path }]))
  );

  server.tool(
    "summer_save_scene",
    "Save an explicit scene to disk. Mutation tools already append one save; use this for a standalone save or save-as.",
    {
      scenePath: z.string().describe("Scene to save, e.g. 'res://main.tscn'"),
      path: z.string().optional().describe("Optional save-as path, e.g. 'res://levels/level2.tscn'"),
    },
    async ({ scenePath, path }) =>
      withEngine(async (client) => {
        const op: Record<string, unknown> = { op: "SaveScene" };
        if (path) op.path = path;
        return executeSceneMutation(client, scenePath, [op]);
      })
  );

  server.tool(
    "summer_open_scene",
    `Open a scene file in the editor. Use this to switch between scenes.

Do not guess paths. Prefer:
1) summer_get_project_context (read mainScene)
2) summer_open_main_scene (open known main scene)
3) summer_open_scene only when user gave an explicit path.`,
    { path: z.string().describe("Scene path, e.g. 'res://main.tscn' or 'res://levels/level1.tscn'") },
    async ({ path }) =>
      withEngine(async (client) =>
        client.executeOps([{ op: "OpenScene", path }])
      )
  );

  server.tool(
    "summer_instantiate_scene",
    `Add an existing scene or 3D model as a child node. Use this to:
- Add a .tscn prefab (reusable scene) as a child
- Add a .glb/.gltf 3D model into the scene
- Compose scenes from smaller scenes (e.g., add a "Player" scene into a "Level" scene)

The scene must already exist in the project. Use summer_import_from_url first if importing from external sources.

PASS target_size FOR IMPORTED MODELS. Downloaded/generated .glb assets arrive at arbitrary scale (a "chair" can be 40 units tall). target_size uniformly scales the instanced subtree so its largest world-AABB dimension equals that many units — commit to real-world size: chair 1.0, door 2.0, car 4.5, person 1.7, tree 6-10. The result then reports dimensions + scale_applied; verify placement afterwards (summer_world_snapshot AABBs, summer_screenshot). Older engine builds ignore target_size — when the result lacks scale_applied, this tool appends a note and you must scale the node yourself (summer_set_prop scale) and re-check.`,
    {
      scenePath: z.string().describe("Target scene to receive the instance, e.g. 'res://main.tscn'"),
      parent: z.string().describe("Parent node path, e.g. './World'"),
      scene: z.string().describe("Scene/model path, e.g. 'res://player.tscn' or 'res://models/tree.glb'"),
      name: z.string().optional().describe("Override the instance name"),
      target_size: z
        .number()
        .positive()
        .optional()
        .describe(
          "Normalize the instance's physical size: uniformly scale it so its largest world-AABB dimension equals this many units (chair 1.0, car 4.5, person 1.7). Strongly recommended for imported .glb/.gltf models."
        ),
    },
    async ({ scenePath, parent, scene, name, target_size }) =>
      withEngine(async (client) => {
        const op: Record<string, unknown> = { op: "InstantiateScene", parent, scene };
        if (name) op.name = name;
        if (target_size !== undefined) op.target_size = target_size;
        const result = await executeSceneMutation(client, scenePath, [op]);
        // An older engine applies the op but silently drops target_size — its
        // receipt then lacks scale_applied. Confess that instead of letting a
        // 40-unit "chair" pass as normalized.
        if (target_size !== undefined && result && typeof result === "object") {
          const envelope = result as Record<string, unknown> & {
            results?: Array<Record<string, unknown>>;
          };
          const instanced = envelope.results?.find(
            (entry) => entry.op === "InstantiateScene" && entry.ok === true
          );
          if (instanced && !("scale_applied" in instanced)) {
            return {
              ...envelope,
              target_size_note:
                `This Summer Engine build IGNORED target_size (no scale_applied in the receipt) — the instance is at the asset's raw scale, NOT normalized to ${target_size}. ` +
                "Scale it yourself (summer_set_prop scale, or ctx code in summer_run_script), verify with summer_world_snapshot/summer_screenshot, or update Summer Engine.",
            };
          }
        }
        return result;
      })
  );

  server.tool(
    "summer_connect_signal",
    `Connect a signal between two nodes. Signals are Godot's event system — they notify when something happens.

Common signals:
- "body_entered" / "body_exited" — Area3D/Area2D detects physics bodies
- "pressed" — Button clicked
- "timeout" — Timer finished
- "area_entered" — Area detects another area
- "input_event" — CollisionObject received input

The receiver node must have a script with the specified method.`,
    {
      scenePath: z.string().describe("Target scene path, e.g. 'res://main.tscn'"),
      emitter: z.string().describe("Node that fires the signal, e.g. './Player/HitArea'"),
      signal: z.string().describe("Signal name, e.g. 'body_entered'"),
      receiver: z.string().describe("Node with the handler script, e.g. './Player'"),
      method: z.string().describe("Method name in the receiver's script, e.g. '_on_hit_area_body_entered'"),
    },
    async ({ scenePath, emitter, signal, receiver, method }) =>
      withEngine(async (client) =>
        executeSceneMutation(client, scenePath, [
          { op: "ConnectSignal", emitter, signal, receiver, method },
        ])
      )
  );

  server.tool(
    "summer_select_node",
    "Select a node in the editor's scene tree and show it in the inspector panel. Useful for focusing the editor on a specific node.",
    {
      nodePath: z.string().describe("Node path to select"),
      scenePath: z.string().optional().describe("Open this scene first, then select the node"),
    },
    async ({ nodePath, scenePath }) =>
      withEngine(async (client) => {
        const op: Record<string, unknown> = { op: "SelectNode", nodePath };
        if (scenePath) op.scenePath = scenePath;
        return client.executeOps([op]);
      })
  );

  server.tool(
    "summer_replace_node",
    "Replace a node with a different type or scene, preserving its position in the tree and its children. Useful for changing a StaticBody3D to a RigidBody3D, or swapping a placeholder with a proper prefab.",
    {
      scenePath: z.string().describe("Target scene path, e.g. 'res://main.tscn'"),
      path: z.string().describe("Node path to replace"),
      type: z.string().optional().describe("New node type, e.g. 'RigidBody3D'"),
      scene: z.string().optional().describe("Scene to replace with, e.g. 'res://enemies/boss.tscn'"),
    },
    async ({ scenePath, path, type, scene }) =>
      withEngine(async (client) => {
        const op: Record<string, unknown> = { op: "ReplaceNode", path };
        if (type) op.type = type;
        if (scene) op.scene = scene;
        return executeSceneMutation(client, scenePath, [op]);
      })
  );

  server.tool(
    "summer_inspect_node",
    `Get all editable properties of a node with their current values, types, and resource info.

Call this before modifying a node to understand its current state. Returns every property the Godot inspector would show. Each prop carries the engine's raw Variant.Type integer as "type" plus its name as "type_name" (e.g. type 5 = TYPE_VECTOR2, 20 = TYPE_COLOR, 24 = TYPE_OBJECT); resource-valued props also carry resource_type / resource_path.

Reads the currently OPEN scene — "path" is relative to its root (there is no scenePath argument; open the scene first if needed).

Example: inspect a light to see its energy, color, shadow settings before changing them.`,
    {
      path: z.string().describe("Node path from scene tree, e.g. 'Player', 'World/Enemies/Boss', 'DirectionalLight3D'"),
    },
    async ({ path }) =>
      // E2E 2026-09-03 F-14: the engine returns Variant.Type as a bare int.
      withEngine(async (client) => annotateVariantTypes(await client.inspectNode(path)))
  );

  server.tool(
    "summer_inspect_resource",
    `Get all properties of a resource (material, mesh, shape, environment, etc).

Use when you need the sub-properties of a resource attached to a node. For example, summer_inspect_node tells you a MeshInstance3D has a "StandardMaterial3D" material — this tool tells you that material's albedo_color, metallic, roughness, etc.`,
    {
      path: z.string().describe("Resource path, e.g. 'res://materials/ground.tres' or 'res://models/player.glb'"),
    },
    async ({ path }) =>
      withEngine(async (client) => client.inspectResource(path))
  );

  server.tool(
    "summer_batch",
    `Execute multiple operations in a single call. Each op is forwarded to the engine VERBATIM, so this is also how you reach engine ops that have no dedicated tool.

UNDO: when nothing in the list forces a split (see the single-op contract below), the whole batch is ONE undo step — the user undoes everything with a single Ctrl+Z. When single-only ops are present the list is split into sequential requests and EACH chunk is its own undo step (one Ctrl+Z per chunk; the receipt shows the chunks). Use this when building something that involves multiple nodes and properties — e.g., creating a player character with collision, camera, and properties.

Each op in the array uses the same format as the individual tools:
- {"op": "AddNode", "parent": "/", "type": "MeshInstance3D", "name": "Floor"}
- {"op": "SetProp", "path": "Floor", "key": "position", "value": "Vector3(0, -1, 0)"}
- {"op": "SetProp", "path": "Floor", "key": "mesh", "value": "PlaneMesh"}
- {"op": "SetResourceProperty", "nodePath": "Floor", "resourceProperty": "mesh", "subProperty": "size", "value": "Vector2(20, 20)"}

RAW RUNTIME OPS (interactive verification — structured failure_reason passes through verbatim):
- RunVerification — spawn a hidden, disposable game instance that runs a GDScript probe and dies (never touches the editor): {"op": "RunVerification", "probe_source": "...", "max_seconds": 20}. Returns {ok, results, frames, out_dir}. Probe API: report(name, value) / save_frame(name) / press(action) / key(keycode) / finish(). save_frame REQUIRES a name argument — save_frame() with no args is a script error. Mount scenes deferred: get_tree().root.add_child.call_deferred(instance); await get_tree().process_frame; await settle() — a direct add_child in _ready can hit the parent-busy guard and capture a black frame.
- SimulateInput — inject an action/key/mouse/axis into the RUNNING game (summer_play first): {"op": "SimulateInput", "type": "action", "action": "jump", "pressed": true}. It MUST be sent alone (single-op batch). failure_reason "not_running" = start the game first; "unsupported" = the running game build predates the handler — fall back to RunVerification or ask the user.

Do not mix OpenScene with scene mutations in one batch. OpenScene is a UI action;
send it separately. scenePath selects every mutation target. The tool appends one
final SaveScene when the batch mutates a scene; if supplied explicitly, SaveScene
must appear exactly once and be the final operation. The engine requires
SaveScene, InstantiateScene, ReplaceNode, SimulateInput, the runtime reads
(GetRuntimeSceneTree/GetRuntimeNode), and the Run*/Import*
ops to travel as their own request, so this tool automatically splits your op
list into sequential requests around them — each split chunk is its own undo
step (NOT one step for the whole batch), and if a later chunk fails the receipt
reports exactly which earlier ops already applied.`,
    {
      scenePath: z.string().optional().describe(
        "Required when ops contains scene mutations; exact res:// target scene path",
      ),
      ops: z.array(z.record(z.unknown())).describe("Array of operation objects, each with 'op' plus its parameters"),
    },
    async ({ scenePath, ops }) =>
      withEngine(async (client) => {
        const rawFileMutation = ops.find((op) => {
          const kind = String(op.op ?? "");
          return kind === "WriteFile" || kind === "ReplaceText";
        });
        if (rawFileMutation) {
          throw new ToolInputError(
            `summer_batch does not accept raw ${String(rawFileMutation.op)} operations. ` +
            "Use summer_write_file or summer_replace_text so project identity, content guards, and same-file ordering are enforced."
          );
        }
        const sceneMutations = new Set([
          "AddNode", "RemoveNode", "MoveNode", "ReparentNode", "ReplaceNode",
          "SetProp", "SetResourceProperty", "ConnectSignal", "DisconnectSignal",
          "InstantiateScene", "SaveScene", "SnapToSurface", "AlignDistribute3D", "Undo",
        ]);
        // Read-only spatial queries target an exact scene (identity-bound) but
        // never save — no SaveScene is appended for them.
        const sceneQueries = new Set([
          "TestPlacement3D", "NavigationProbe3D", "Starcast3D",
        ]);
        const containsMutation = ops.some((op) => sceneMutations.has(String(op.op ?? "")));
        const needsScenePath = containsMutation ||
          ops.some((op) => sceneQueries.has(String(op.op ?? "")));
        if (needsScenePath && !scenePath) {
          throw new ToolInputError("summer_batch requires scenePath when ops targets a scene");
        }
        const options = { groupUndo: true, ...(scenePath ? { scenePath } : {}) };
        if (containsMutation) {
          return executeSceneMutation(client, scenePath!, ops as Record<string, unknown>[], options);
        }
        return executeOpsChunked(
          (chunk) => needsScenePath
            ? client.executeIdentityBoundOps(chunk, options)
            : client.executeOps(chunk, options),
          ops as Record<string, unknown>[],
          resolveSingleOnlyOps(client),
        );
      })
  );
}
