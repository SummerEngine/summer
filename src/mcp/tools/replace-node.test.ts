import { describe, expect, it, vi } from "vitest";

vi.mock("../server.js", () => ({ getClient: vi.fn(), resetClient: vi.fn() }));
vi.mock("../../core/telemetry.js", () => ({ recordMcpSession: vi.fn() }));

import { getClient } from "../server.js";
import { registerSceneTools } from "./scene-tools.js";
import { FakeSceneEngine } from "../../test-helpers/fake-scene-engine.js";
import { propSetValue, replaceNodePersisted } from "../../core/capabilities/replace-node.js";
import { dispatchTool } from "../../core/capabilities/tool-dispatch.js";
import { findTscnNode, parseTscn } from "../../core/capabilities/tscn.js";

const SCENE = "res://town.tscn";
const OLD = "res://kit/facade_frame_a.tscn";
const NEW = "res://kit/wall_door_b.tscn";

const SCENES = {
  [OLD]: { rootType: "StaticBody3D", children: [{ name: "Frame", type: "MeshInstance3D" }] },
  [NEW]: { rootType: "StaticBody3D", children: [{ name: "Wall", type: "MeshInstance3D" }, { name: "DoorSlot", type: "Marker3D" }] },
};

// A door host inside a facade row, with a sign (and its bolt) added under it,
// between two siblings.
const HOUSE = `[gd_scene format=3]

[ext_resource type="PackedScene" path="${OLD}" id="1_frame"]

[node name="Root" type="Node3D"]

[node name="House3" type="Node3D" parent="."]

[node name="Before" type="Node3D" parent="House3" unique_id=11]

[node name="G_f2_door" parent="House3" unique_id=12 instance=ExtResource("1_frame")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 2, 0, -0.13)
visible = false

[node name="Sign" type="Node3D" parent="House3/G_f2_door" unique_id=13]
position = Vector3(0, 2.5, 0.1)

[node name="Bolt" type="MeshInstance3D" parent="House3/G_f2_door/Sign" unique_id=14]

[node name="After" type="Node3D" parent="House3" unique_id=15]
`;

function engine(tscn = HOUSE, options: Partial<ConstructorParameters<typeof FakeSceneEngine>[2]> = {}) {
  return new FakeSceneEngine(SCENE, tscn, { scenes: SCENES, ...options });
}

describe("the fake engine reproduces the ReplaceNode engine bug (regression guard)", () => {
  it("a raw ReplaceNode {scene} shows the new scene live but saves the OLD scene reference", async () => {
    const fake = engine();
    await fake.executeIdentityBoundOps([{ op: "ReplaceNode", path: "./House3/G_f2_door", scene: NEW }]);
    await fake.executeIdentityBoundOps([{ op: "SaveScene" }]);
    // Live: the new scene's nodes are there (plus the old instance's own Frame, moved over).
    expect(fake.liveChildren("House3/G_f2_door")).toEqual(expect.arrayContaining(["Wall", "DoorSlot", "Frame", "Sign"]));
    // Saved: still the old ExtResource, with a fresh unique_id.
    const saved = findTscnNode(fake.savedScene(), "House3/G_f2_door")!;
    expect(saved.instancePath).toBe(OLD);
    expect(fake.disk.get(SCENE)).not.toContain("unique_id=12 ");
  });
});

describe("summer_replace_node: scene swap through ops that persist", () => {
  it("saves the NEW scene at the same parent, index and name, with transform, props and every added child", async () => {
    const fake = engine();
    const result = await replaceNodePersisted(fake, { scenePath: SCENE, path: "./House3/G_f2_door", scene: NEW });

    expect(result).toMatchObject({
      ok: true,
      persisted: true,
      path: "House3/G_f2_door",
      method: "instantiate_move_remove",
      replaced: { from: OLD, to: NEW },
      moved_children: ["Sign"],
      props_copied: ["transform", "visible"],
    });
    expect(fake.opsSent()).not.toContain("ReplaceNode");

    const saved = fake.savedScene();
    const node = findTscnNode(saved, "House3/G_f2_door")!;
    expect(node.instancePath).toBe(NEW);
    expect(node.parent).toBe("House3");
    expect(node.props).toEqual([
      { key: "transform", value: "Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 2, 0, -0.13)" },
      { key: "visible", value: "false" },
    ]);
    // Sibling order and both levels of added children survive the save.
    expect(saved.nodes.filter((n) => n.parent === "House3").map((n) => n.name)).toEqual(["Before", "G_f2_door", "After"]);
    expect(findTscnNode(saved, "House3/G_f2_door/Sign")?.type).toBe("Node3D");
    expect(findTscnNode(saved, "House3/G_f2_door/Sign/Bolt")?.type).toBe("MeshInstance3D");
    expect(fake.disk.get(SCENE)).not.toContain("SummerReplace");
    expect(fake.disk.get(SCENE)).not.toContain(OLD);
    // Live tree: the new scene's own nodes plus the moved child, none of the old scene's.
    expect(fake.liveChildren("House3/G_f2_door")).toEqual(["Wall", "DoorSlot", "Sign"]);
  });

  it("re-owns the descendants below a moved child (the engine's ReparentNode leaves them unowned)", async () => {
    const fake = engine();
    await replaceNodePersisted(fake, { scenePath: SCENE, path: "House3/G_f2_door", scene: NEW });
    const reparents = fake.sent.flat().filter((op) => op.op === "ReparentNode");
    expect(reparents).toEqual([
      { op: "ReparentNode", path: "House3/G_f2_door/Sign", new_parent_path: "House3/G_f2_door_SummerReplace", keep_global_transform: false },
      {
        op: "ReparentNode",
        path: "House3/G_f2_door_SummerReplace/Sign/Bolt",
        new_parent_path: "House3/G_f2_door_SummerReplace/Sign",
        keep_global_transform: false,
      },
    ]);
  });

  it("reports persisted:false as a failure when the saved file does not hold the swap", async () => {
    const fake = engine(HOUSE, { saveDropsChanges: true });
    const result = await replaceNodePersisted(fake, { scenePath: SCENE, path: "House3/G_f2_door", scene: NEW });
    expect(result).toMatchObject({ ok: false, persisted: false, failure_reason: "not_persisted" });
    expect(String(result.error)).toContain("did NOT persist");
    expect(String(result.error)).toContain(OLD);
  });

  it("MCP face: isError with failure_reason not_persisted, never a success receipt", async () => {
    const fake = engine(HOUSE, { saveDropsChanges: true });
    vi.mocked(getClient).mockResolvedValue(fake as never);
    const tool = sceneTool("summer_replace_node");
    const result = (await tool.handler({ scenePath: SCENE, path: "House3/G_f2_door", scene: NEW })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not_persisted");
    expect(result.content[0]!.text).toContain("persisted:false");
  });

  it("MCP face: a persisted swap returns persisted:true", async () => {
    const fake = engine();
    vi.mocked(getClient).mockResolvedValue(fake as never);
    const result = (await sceneTool("summer_replace_node").handler({ scenePath: SCENE, path: "House3/G_f2_door", scene: NEW })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: true, persisted: true });
  });

  it("CLI face runs the same implementation", async () => {
    const fake = engine();
    const result = await dispatchTool(
      "replace-node",
      { scenePath: SCENE, path: "House3/G_f2_door", scene: NEW },
      { engine: async () => fake as never }
    );
    expect(result).toMatchObject({ ok: true, persisted: true });
    expect(findTscnNode(fake.savedScene(), "House3/G_f2_door")?.instancePath).toBe(NEW);
  });

  it("refuses a child-name collision and removes the temporary node again", async () => {
    const withWallChild = HOUSE.replace(
      '[node name="After"',
      '[node name="Wall" type="Node3D" parent="House3/G_f2_door" unique_id=16]\n\n[node name="After"'
    );
    const fake = engine(withWallChild);
    const before = fake.disk.get(SCENE);
    const result = await replaceNodePersisted(fake, { scenePath: SCENE, path: "House3/G_f2_door", scene: NEW });
    expect(result).toMatchObject({ ok: false, failure_reason: "child_name_collision", rolled_back: true });
    expect(fake.liveChildren("House3")).toEqual(["Before", "G_f2_door", "After"]);
    expect(findTscnNode(parseTscn(before!), "House3/G_f2_door")?.instancePath).toBe(OLD);
    expect(findTscnNode(fake.savedScene(), "House3/G_f2_door")?.instancePath).toBe(OLD);
  });

  it("lists what cannot travel: groups, signal connections, sub_resource values, failed props", async () => {
    const rich = HOUSE.replace(
      '[node name="G_f2_door" parent="House3" unique_id=12 instance=ExtResource("1_frame")]',
      '[node name="G_f2_door" parent="House3" unique_id=12 instance=ExtResource("1_frame") groups=["doors"]]\nmaterial_override = SubResource("Mat_1")\ndoor_speed = 2.0'
    ) + '\n[connection signal="body_entered" from="House3/G_f2_door" to="." method="_on_door"]\n';
    const fake = engine(rich, { unknownProps: ["door_speed"] });
    const result = await replaceNodePersisted(fake, { scenePath: SCENE, path: "House3/G_f2_door", scene: NEW });
    expect(result).toMatchObject({ ok: true, persisted: true });
    const lost = result.not_carried_over as Record<string, unknown>;
    expect(lost.groups).toEqual(["doors"]);
    expect(lost.connections).toEqual(["House3/G_f2_door:body_entered -> .:_on_door"]);
    const props = lost.props as Array<{ key: string; reason: string }>;
    expect(props.map((p) => p.key).sort()).toEqual(["door_speed", "material_override"]);
    expect(props.find((p) => p.key === "material_override")?.reason).toContain("sub_resource");
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining("not_carried_over")]));
  });

  it("a missing node is reported, and nothing but the pre-save was sent", async () => {
    const fake = engine();
    const result = await replaceNodePersisted(fake, { scenePath: SCENE, path: "House3/Nope", scene: NEW });
    expect(result).toMatchObject({ ok: false, failure_reason: "node_not_found" });
    expect(fake.opsSent()).toEqual(["SaveScene"]);
  });

  it("refuses the scene root for a scene swap", async () => {
    const fake = engine();
    const result = await replaceNodePersisted(fake, { scenePath: SCENE, path: ".", scene: NEW });
    expect(result).toMatchObject({ ok: false, failure_reason: "root_not_supported" });
  });

  it("validates arguments before sending anything", async () => {
    const fake = engine();
    await expect(replaceNodePersisted(fake, { scenePath: SCENE, path: "House3/G_f2_door" })).rejects.toThrow(/exactly one of type/);
    await expect(
      replaceNodePersisted(fake, { scenePath: SCENE, path: "House3/G_f2_door", type: "Node3D", scene: NEW })
    ).rejects.toThrow(/exactly one of type/);
    await expect(replaceNodePersisted(fake, { scenePath: "res://level.scn", path: "A", scene: NEW })).rejects.toThrow(/\.tscn/);
    expect(fake.sent).toEqual([]);
  });

  it("refuses when the engine provably lacks an op of the path (nothing destructive sent)", async () => {
    const fake = engine(HOUSE, { opKinds: ["SaveScene", "InstantiateScene", "SetProp", "MoveNode", "RemoveNode"] });
    const result = await replaceNodePersisted(fake, { scenePath: SCENE, path: "House3/G_f2_door", scene: NEW });
    expect(result).toMatchObject({ ok: false, failure_reason: "engine_lacks_op", op: "ReparentNode" });
    expect(fake.opsSent()).toEqual(["SaveScene"]);
  });
});

describe("summer_replace_node: type changes", () => {
  const CRATE = `[gd_scene format=3]

[node name="Root" type="Node3D"]

[node name="Crate" type="StaticBody3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0)

[node name="Shape" type="CollisionShape3D" parent="Crate"]
`;

  it("a plain node keeps the engine's ReplaceNode (it persists) and is verified from the file", async () => {
    const fake = engine(CRATE);
    const result = await replaceNodePersisted(fake, { scenePath: SCENE, path: "Crate", type: "RigidBody3D" });
    expect(result).toMatchObject({ ok: true, persisted: true, method: "engine_replace_node" });
    expect(fake.opsSent()).toEqual(["SaveScene", "ReplaceNode", "SaveScene"]);
    const saved = fake.savedScene();
    expect(findTscnNode(saved, "Crate")?.type).toBe("RigidBody3D");
    expect(findTscnNode(saved, "Crate/Shape")?.type).toBe("CollisionShape3D");
  });

  it("an instanced node goes through AddNode, because the engine op would keep it an instance of the old scene", async () => {
    const fake = engine();
    const result = await replaceNodePersisted(fake, { scenePath: SCENE, path: "House3/G_f2_door", type: "Node3D" });
    expect(result).toMatchObject({ ok: true, persisted: true, method: "instantiate_move_remove" });
    expect(fake.opsSent()).toContain("AddNode");
    expect(fake.opsSent()).not.toContain("ReplaceNode");
    const node = findTscnNode(fake.savedScene(), "House3/G_f2_door")!;
    expect(node.type).toBe("Node3D");
    expect(node.instance).toBeUndefined();
  });
});

describe("summer_batch refuses a raw ReplaceNode with scene", () => {
  it("sends nothing and points at summer_replace_node", async () => {
    const fake = engine();
    vi.mocked(getClient).mockResolvedValue(fake as never);
    const result = (await sceneTool("summer_batch").handler({
      scenePath: SCENE,
      ops: [{ op: "ReplaceNode", path: "House3/G_f2_door", scene: NEW }],
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("summer_replace_node");
    expect(fake.sent).toEqual([]);
    await expect(
      dispatchTool("batch", { scenePath: SCENE, ops: [{ op: "ReplaceNode", path: "X", scene: NEW }] }, { engine: async () => fake as never })
    ).rejects.toThrow(/summer_replace_node/);
  });
});

describe("propSetValue", () => {
  const parsed = parseTscn(`[gd_scene format=3]\n\n[ext_resource type="Script" path="res://door.gd" id="2_s"]\n\n[node name="R" type="Node"]\n`);
  it("converts tscn literals to SetProp values", () => {
    expect(propSetValue({ key: "visible", value: "false" }, parsed)).toEqual({ value: false });
    expect(propSetValue({ key: "speed", value: "2.5" }, parsed)).toEqual({ value: 2.5 });
    expect(propSetValue({ key: "label", value: '"Front \\"door\\""' }, parsed)).toEqual({ value: 'Front "door"' });
    expect(propSetValue({ key: "target", value: 'NodePath("../Door")' }, parsed)).toEqual({ value: "../Door" });
    expect(propSetValue({ key: "script", value: 'ExtResource("2_s")' }, parsed)).toEqual({ value: "res://door.gd" });
    expect(propSetValue({ key: "transform", value: "Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0)" }, parsed)).toEqual({
      value: "Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0)",
    });
    expect(propSetValue({ key: "material_override", value: 'SubResource("M")' }, parsed)).toHaveProperty("reason");
  });
});

type RegisteredTool = { name: string; handler: (args: Record<string, unknown>) => Promise<unknown> };

function sceneTool(name: string): RegisteredTool {
  const registered: RegisteredTool[] = [];
  registerSceneTools({
    tool(toolName: string, _description: string, _schema: unknown, handler: RegisteredTool["handler"]) {
      registered.push({ name: toolName, handler });
      return { name: toolName };
    },
  } as never);
  return registered.find((candidate) => candidate.name === name)!;
}
