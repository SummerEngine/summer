import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withEngine } from "./with-engine.js";
import { readFile } from "fs/promises";
import { join } from "path";
import type { EngineApiClient } from "../../lib/api-client.js";

function sceneMutationOps(ops: Record<string, unknown>[]): Record<string, unknown>[] {
  const saveIndexes = ops
    .map((op, index) => op.op === "SaveScene" ? index : -1)
    .filter((index) => index >= 0);
  if (saveIndexes.length > 1) {
    throw new Error("A scene mutation batch may contain only one SaveScene");
  }
  if (saveIndexes.length === 1) {
    if (saveIndexes[0] !== ops.length - 1) {
      throw new Error("SaveScene must be the final operation in a scene mutation batch");
    }
    return ops;
  }
  return [...ops, { op: "SaveScene" }];
}

function executeSceneMutation(
  client: EngineApiClient,
  scenePath: string,
  ops: Record<string, unknown>[],
  options?: Record<string, unknown>,
): Promise<unknown> {
  return client.executeIdentityBoundOps(sceneMutationOps(ops), {
    ...(options ?? {}),
    scenePath,
  });
}

async function readMainSceneFromProject(projectPath?: string): Promise<string | null> {
  if (!projectPath) return null;
  try {
    const text = await readFile(join(projectPath, "project.godot"), "utf-8");
    const match = text.match(/run\/main_scene="([^"]+)"/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

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

export function registerSceneTools(server: McpServer): void {
  server.tool(
    "summer_create_scene",
    `Create a new empty scene file safely.

IMPORTANT:
- This tool uses a temporary mutation strategy: it opens a template scene, removes children, saves to a new path, then restores the previous scene.
- To prevent accidental destructive actions, you MUST explicitly set allow_temporary_scene_mutation=true.
- If you don't want this strategy, stop and ask the user for manual scene creation in the editor.

Recommended workflow:
1) Call summer_get_project_context
2) Call summer_open_main_scene (optional)
3) Call summer_create_scene with a new path`,
    {
      path: z.string().describe("New scene path, e.g. 'res://scenes/empty_level.tscn'"),
      rootName: z.string().default("Main").describe("Root node name for the new scene"),
      allow_temporary_scene_mutation: z
        .boolean()
        .default(false)
        .describe("Safety gate. Must be true to proceed."),
    },
    async ({ path, rootName, allow_temporary_scene_mutation }) =>
      withEngine(async (client) => {
        if (!allow_temporary_scene_mutation) {
          throw new Error(
            "Refusing to create scene without explicit approval. Re-run with allow_temporary_scene_mutation=true."
          );
        }

        const health = (await client.health()) as Record<string, unknown>;
        const currentScene =
          typeof health.scene === "string" && health.scene.length > 0 ? health.scene : null;
        const projectPath =
          typeof health.project_path === "string" ? health.project_path : undefined;
        const mainScene = await readMainSceneFromProject(projectPath);
        const templateScene = currentScene || mainScene;

        if (!templateScene) {
          throw new Error(
            "No scene open and could not resolve main scene. Call summer_get_project_context first, then open a known scene."
          );
        }

        await client.executeOps([{ op: "OpenScene", path: templateScene }]);
        const tree = (await client.getSceneState(templateScene)) as {
          data?: { children?: Array<{ path?: string }> };
          children?: Array<{ path?: string }>;
        };
        const children =
          tree.data?.children ?? tree.children ?? [];

        const removeOps = children
          .map((c) => c.path)
          .filter((p): p is string => typeof p === "string" && p.length > 0)
          .map((p) => ({ op: "RemoveNode", path: `./${p}` }));

        const createOps = [
          ...removeOps,
          { op: "SetProp", path: ".", key: "name", value: rootName },
          { op: "SaveScene", path },
        ];
        const createReceipt = requireSuccessfulOps(
          await executeSceneMutation(client, templateScene, createOps, {
            groupUndo: true,
          }),
          `Creating ${path}`,
        );

        if (currentScene && currentScene !== path) {
          requireSuccessfulOps(
            await client.executeOps([{ op: "OpenScene", path: currentScene }]),
            `Restoring ${currentScene}`,
          );
        }

        return {
          ok: true,
          created: path,
          rootName,
          templateScene,
          restoredScene: currentScene,
          receipt: createReceipt,
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

The scene must already exist in the project. Use summer_import_from_url first if importing from external sources.`,
    {
      scenePath: z.string().describe("Target scene to receive the instance, e.g. 'res://main.tscn'"),
      parent: z.string().describe("Parent node path, e.g. './World'"),
      scene: z.string().describe("Scene/model path, e.g. 'res://player.tscn' or 'res://models/tree.glb'"),
      name: z.string().optional().describe("Override the instance name"),
    },
    async ({ scenePath, parent, scene, name }) =>
      withEngine(async (client) => {
        const op: Record<string, unknown> = { op: "InstantiateScene", parent, scene };
        if (name) op.name = name;
        return executeSceneMutation(client, scenePath, [op]);
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

Call this before modifying a node to understand its current state. Returns every property the Godot inspector would show.

Example: inspect a light to see its energy, color, shadow settings before changing them.`,
    {
      path: z.string().describe("Node path from scene tree, e.g. 'Player', 'World/Enemies/Boss', 'DirectionalLight3D'"),
    },
    async ({ path }) =>
      withEngine(async (client) => client.inspectNode(path))
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
    `Execute multiple operations in a single call, grouped into one undo step. Each op is forwarded to the engine VERBATIM, so this is also how you reach engine ops that have no dedicated tool.

The user can undo everything with a single Ctrl+Z. Use this when building something that involves multiple nodes and properties — e.g., creating a player character with collision, camera, and properties.

Each op in the array uses the same format as the individual tools:
- {"op": "AddNode", "parent": "/", "type": "MeshInstance3D", "name": "Floor"}
- {"op": "SetProp", "path": "Floor", "key": "position", "value": "Vector3(0, -1, 0)"}
- {"op": "SetProp", "path": "Floor", "key": "mesh", "value": "PlaneMesh"}
- {"op": "SetResourceProperty", "nodePath": "Floor", "resourceProperty": "mesh", "subProperty": "size", "value": "Vector2(20, 20)"}

RAW RUNTIME OPS (interactive verification — structured failure_reason passes through verbatim):
- RunVerification — spawn a hidden, disposable game instance that runs a GDScript probe and dies (never touches the editor): {"op": "RunVerification", "probe_source": "extends SummerProbeBase\\nfunc _ready(): await super._ready(); report('ok', true); finish()", "max_seconds": 20}. Returns {ok, results, frames, out_dir}. Probe API: report()/save_frame()/press()/key()/finish(). This is the ONLY way to drive input from MCP, and unlike the editor it renders real pixels, so save_frame() produces a real image.
- SimulateInput is NOT reachable from MCP or the CLI. It requires the in-editor chat bridge's async reply channel; every queued caller gets {"ok": false, "failure_reason": "unsupported_transport"} on every engine build. Do not send it and do not treat that reply as a version problem — use RunVerification's press()/key() instead.

Do not mix OpenScene with scene mutations in one batch. OpenScene is a UI action;
send it separately. scenePath selects every mutation target. The tool appends one
final SaveScene when the batch mutates a scene; if supplied explicitly, SaveScene
must appear exactly once and be the final operation.`,
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
          throw new Error(
            `summer_batch does not accept raw ${String(rawFileMutation.op)} operations. ` +
            "Use summer_write_file or summer_replace_text so project identity, content guards, and same-file ordering are enforced."
          );
        }
        const sceneMutations = new Set([
          "AddNode", "RemoveNode", "MoveNode", "ReparentNode", "ReplaceNode",
          "SetProp", "SetResourceProperty", "ConnectSignal", "DisconnectSignal",
          "InstantiateScene", "SaveScene", "Undo",
        ]);
        const needsScenePath = ops.some((op) => sceneMutations.has(String(op.op ?? "")));
        if (needsScenePath && !scenePath) {
          throw new Error("summer_batch requires scenePath when ops contains scene mutations");
        }
        const options = { groupUndo: true, ...(scenePath ? { scenePath } : {}) };
        return needsScenePath
          ? executeSceneMutation(client, scenePath!, ops as Record<string, unknown>[], options)
          : client.executeOps(ops as Record<string, unknown>[], options);
      })
  );
}
