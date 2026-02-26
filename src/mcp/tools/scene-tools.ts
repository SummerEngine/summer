import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withEngine } from "./with-engine.js";

export function registerSceneTools(server: McpServer): void {
  server.tool(
    "summer_add_node",
    `Add a new node to the scene tree.

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
    "Remove a node from the scene tree. All children are removed too. Cannot remove the root node. Supports undo.",
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
    "Open a scene file in the editor. Use this to switch between scenes (e.g., open a level to edit it).",
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
}
