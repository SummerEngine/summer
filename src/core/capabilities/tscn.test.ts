import { describe, expect, it } from "vitest";
import { findTscnNode, isSceneCreatedNode, normalizeNodePath, parseTscn, quotedLiteral } from "./tscn.js";

const TEXT = `[gd_scene load_steps=3 format=3 uid="uid://b1"]

[ext_resource type="PackedScene" uid="uid://c2" path="res://kit/door.tscn" id="1_door"]
[ext_resource type="Script" path="res://door.gd" id="2_s"]

[sub_resource type="BoxMesh" id="Box_1"]
size = Vector3(1, 2, 3)

[node name="Root" type="Node3D" unique_id=1]

[node name="Door" parent="." unique_id=2 instance=ExtResource("1_door") groups=["doors", &"open"]]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 2)
script = ExtResource("2_s")
"odd key" = "a \\"quoted\\" [value]"
notes = "line one
[not a tag] line two"
curve = {
"points": [1, 2],
"closed": false
}

[node name="Frame" parent="Door"]
visible = false

[node name="Sign" type="Label3D" parent="Door" index="0"]

[connection signal="body_entered" from="Door" to="." method="_on_door" flags=3]

[editable path="Door"]
`;

describe("parseTscn", () => {
  const parsed = parseTscn(TEXT);

  it("reads ext_resources, nodes with paths, instance targets and groups", () => {
    expect(parsed.format).toBe(3);
    expect(parsed.extResources.get("1_door")).toMatchObject({ path: "res://kit/door.tscn", type: "PackedScene", uid: "uid://c2" });
    expect(parsed.nodes.map((n) => n.path)).toEqual([".", "Door", "Door/Frame", "Door/Sign"]);
    const door = findTscnNode(parsed, "./Door")!;
    expect(door).toMatchObject({ parent: ".", instance: "1_door", instancePath: "res://kit/door.tscn", groups: ["doors", "open"] });
    expect(findTscnNode(parsed, "Door/Sign")).toMatchObject({ type: "Label3D", index: 0 });
  });

  it("keeps property values raw, including quoted keys and multi-line values (a '[' line inside a value is not a tag)", () => {
    const door = findTscnNode(parsed, "Door")!;
    expect(door.props.map((p) => p.key)).toEqual(["transform", "script", "odd key", "notes", "curve"]);
    expect(door.props[3]!.value).toBe('"line one\n[not a tag] line two"');
    expect(door.props[4]!.value).toBe('{\n"points": [1, 2],\n"closed": false\n}');
    expect(quotedLiteral(door.props[2]!.value)).toBe('a "quoted" [value]');
    // sub_resource bodies never leak into a node.
    expect(parsed.nodes.flatMap((n) => n.props.map((p) => p.key))).not.toContain("size");
  });

  it("tells scene-created nodes from overrides, and reads connections and editable paths", () => {
    expect(isSceneCreatedNode(findTscnNode(parsed, "Door")!)).toBe(true);
    expect(isSceneCreatedNode(findTscnNode(parsed, "Door/Frame")!)).toBe(false);
    expect(parsed.connections).toEqual([
      expect.objectContaining({ signal: "body_entered", from: "Door", to: ".", method: "_on_door", flags: 3 }),
    ]);
    expect(parsed.editable).toEqual(["Door"]);
  });

  it("normalizes node paths the way the engine resolves them", () => {
    expect(normalizeNodePath("")).toBe(".");
    expect(normalizeNodePath("./")).toBe(".");
    expect(normalizeNodePath("./House3/Door/")).toBe("House3/Door");
    expect(normalizeNodePath("House3\\Door")).toBe("House3/Door");
  });
});
