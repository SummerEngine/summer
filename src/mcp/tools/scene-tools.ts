import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withEngine } from "./with-engine.js";
import { readFile } from "fs/promises";
import { join } from "path";
import {
  MAX_BATCH_OPERATIONS,
  classifyMcpOperation,
  isBatchSafeOperation,
} from "./operation-classification.js";

type ToolErrorResult = {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
};

function batchError(
  reason: string,
  details: { rejectedIndex?: number; operation?: string | null } = {}
): ToolErrorResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            error: "batch_rejected",
            reason,
            ...details,
          },
          null,
          2
        ),
      },
    ],
    isError: true,
  };
}

function validateBatch(
  value: unknown
):
  | { ok: true; ops: Record<string, unknown>[] }
  | {
      ok: false;
      reason: string;
      rejectedIndex?: number;
      operation?: string | null;
    } {
  if (!Array.isArray(value)) {
    return { ok: false, reason: "ops must be an array" };
  }
  if (value.length < 1 || value.length > MAX_BATCH_OPERATIONS) {
    return {
      ok: false,
      reason: `ops must contain between 1 and ${MAX_BATCH_OPERATIONS} operations`,
    };
  }

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return {
        ok: false,
        reason: "each operation must be an object",
        rejectedIndex: index,
        operation: null,
      };
    }

    const operation = (item as Record<string, unknown>).op;
    if (typeof operation !== "string" || operation.trim().length === 0) {
      return {
        ok: false,
        reason: "each operation must have a non-empty string op",
        rejectedIndex: index,
        operation: null,
      };
    }

    if (!isBatchSafeOperation(operation)) {
      const classification = classifyMcpOperation(operation);
      return {
        ok: false,
        reason: classification
          ? `operation is ${classification}, not batch_safe`
          : "unknown operation",
        rejectedIndex: index,
        operation,
      };
    }
  }

  return { ok: true, ops: value as Record<string, unknown>[] };
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
        const tree = (await client.getSceneState()) as {
          data?: { children?: Array<{ path?: string }> };
          children?: Array<{ path?: string }>;
        };
        const children =
          tree.data?.children ?? tree.children ?? [];

        const removeOps = children
          .map((c) => c.path)
          .filter((p): p is string => typeof p === "string" && p.length > 0)
          .map((p) => ({ op: "RemoveNode", path: `./${p}` }));

        if (removeOps.length > 0) {
          await client.executeOps(removeOps, { groupUndo: true });
        }

        await client.executeOps([{ op: "SetProp", path: ".", key: "name", value: rootName }]);
        await client.executeOps([{ op: "SaveScene", path }]);

        if (currentScene && currentScene !== path) {
          await client.executeOps([{ op: "OpenScene", path: currentScene }]);
        }

        return {
          ok: true,
          created: path,
          rootName,
          templateScene,
          restoredScene: currentScene,
        };
      })
  );

  server.tool(
    "summer_add_node",
    `Add a new node to the scene tree.

Preflight (fresh chat):
1) summer_get_project_context
2) summer_open_main_scene (if no scene open)
3) summer_get_scene_tree

Common node types:
- 3D: Node3D, MeshInstance3D, CharacterBody3D, RigidBody3D, StaticBody3D, Camera3D, DirectionalLight3D, OmniLight3D, SpotLight3D, WorldEnvironment, CollisionShape3D, Area3D
- 2D: Node2D, Sprite2D, CharacterBody2D, RigidBody2D, StaticBody2D, Camera2D, CollisionShape2D, Area2D, TileMapLayer
- UI: Control, Label, Button, TextEdit, Panel, VBoxContainer, HBoxContainer, MarginContainer
- Audio: AudioStreamPlayer, AudioStreamPlayer3D

The parent path uses "./" prefix for relative paths from scene root. E.g., "./World" means the "World" child of the root node.`,
    {
      parent: z.string().describe("Parent node path, e.g. './World' or './World/Enemies'"),
      type: z.string().describe("Godot node type, e.g. 'MeshInstance3D', 'CharacterBody3D'"),
      name: z.string().describe("Name for the new node, e.g. 'Player', 'MainCamera'"),
    },
    async ({ parent, type, name }) =>
      withEngine(async (client) =>
        client.executeOps([{ op: "AddNode", parent, type, name }])
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
      path: z.string().describe("Node path, e.g. './World/Player'"),
      key: z.string().describe("Property name, e.g. 'position', 'mesh', 'visible'"),
      value: z.union([z.string(), z.number(), z.boolean()]).describe(
        "Value in Godot string format for complex types, native JSON for primitives"
      ),
    },
    async ({ path, key, value }) =>
      withEngine(async (client) =>
        client.executeOps([{ op: "SetProp", path, key, value }])
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
      nodePath: z.string().describe("Node path, e.g. './Player/CollisionShape3D'"),
      resourceProperty: z.string().describe("Resource property on the node, e.g. 'shape', 'mesh', 'material_override'"),
      subProperty: z.string().describe("Property on the resource, e.g. 'size', 'radius', 'albedo_color'"),
      value: z.union([z.string(), z.number(), z.boolean()]).describe("Value in Godot string format"),
    },
    async ({ nodePath, resourceProperty, subProperty, value }) =>
      withEngine(async (client) =>
        client.executeOps([
          { op: "SetResourceProperty", nodePath, resourceProperty, subProperty, value },
        ])
      )
  );

  server.tool(
    "summer_remove_node",
    "Remove a node from the scene tree. All children are removed too. Cannot remove the root node. Supports undo. Destructive operation: do not delete multiple top-level nodes unless the user explicitly requests destructive changes.",
    { path: z.string().describe("Node path to remove, e.g. './World/OldEnemy'") },
    async ({ path }) =>
      withEngine(async (client) => client.executeOps([{ op: "RemoveNode", path }]))
  );

  server.tool(
    "summer_save_scene",
    "Save the current scene to disk. Call this after making scene changes to persist them. Without saving, changes only exist in the editor's memory.",
    { path: z.string().optional().describe("Save-as path for creating a new scene file, e.g. 'res://levels/level2.tscn'") },
    async ({ path }) =>
      withEngine(async (client) => {
        const op: Record<string, unknown> = { op: "SaveScene" };
        if (path) op.path = path;
        return client.executeOps([op]);
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
      parent: z.string().describe("Parent node path, e.g. './World'"),
      scene: z.string().describe("Scene/model path, e.g. 'res://player.tscn' or 'res://models/tree.glb'"),
      name: z.string().optional().describe("Override the instance name"),
    },
    async ({ parent, scene, name }) =>
      withEngine(async (client) => {
        const op: Record<string, unknown> = { op: "InstantiateScene", parent, scene };
        if (name) op.name = name;
        return client.executeOps([op]);
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
      emitter: z.string().describe("Node that fires the signal, e.g. './Player/HitArea'"),
      signal: z.string().describe("Signal name, e.g. 'body_entered'"),
      receiver: z.string().describe("Node with the handler script, e.g. './Player'"),
      method: z.string().describe("Method name in the receiver's script, e.g. '_on_hit_area_body_entered'"),
    },
    async ({ emitter, signal, receiver, method }) =>
      withEngine(async (client) =>
        client.executeOps([
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
      path: z.string().describe("Node path to replace"),
      type: z.string().optional().describe("New node type, e.g. 'RigidBody3D'"),
      scene: z.string().optional().describe("Scene to replace with, e.g. 'res://enemies/boss.tscn'"),
    },
    async ({ path, type, scene }) =>
      withEngine(async (client) => {
        const op: Record<string, unknown> = { op: "ReplaceNode", path };
        if (type) op.type = type;
        if (scene) op.scene = scene;
        return client.executeOps([op]);
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
    `Execute up to ${MAX_BATCH_OPERATIONS} scene mutations in a single call, grouped into one undo step.

Only the documented scene-building operations below are accepted. The entire batch is validated before any engine request, and unknown or non-scene operations are rejected.

Allowed operations use the same format as their dedicated MCP tools:
- {"op": "AddNode", "parent": "/", "type": "MeshInstance3D", "name": "Floor"}
- {"op": "SetProp", "path": "Floor", "key": "position", "value": "Vector3(0, -1, 0)"}
- {"op": "SetProp", "path": "Floor", "key": "mesh", "value": "PlaneMesh"}
- {"op": "SetResourceProperty", "nodePath": "Floor", "resourceProperty": "mesh", "subProperty": "size", "value": "Vector2(20, 20)"}

Allowed op names: AddNode, SetProp, SetResourceProperty, RemoveNode, InstantiateScene, ConnectSignal, ReplaceNode.

File, Git, shell, restore, verification, live-input, internal-diff, and arbitrary native operations are not available through this tool.`,
    {
      ops: z
        .array(z.record(z.unknown()))
        .min(1)
        .max(MAX_BATCH_OPERATIONS)
        .describe("Bounded array of allowlisted scene operation objects"),
    },
    async ({ ops }) => {
      const validation = validateBatch(ops);
      if (!validation.ok) {
        return batchError(validation.reason, {
          ...(validation.rejectedIndex !== undefined
            ? { rejectedIndex: validation.rejectedIndex }
            : {}),
          ...(validation.operation !== undefined
            ? { operation: validation.operation }
            : {}),
        });
      }

      return withEngine(async (client) =>
        client.executeOps(validation.ops, { groupUndo: true })
      );
    }
  );
}
