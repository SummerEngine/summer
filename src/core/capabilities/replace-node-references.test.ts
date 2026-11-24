import { describe, expect, it, vi } from "vitest";
import { incomingNodeReferences, missingNodeReferences, rebindNodeReferences } from "./replace-node-references.js";
import { replaceNodePersisted } from "./replace-node.js";
import { parseTscn } from "./tscn.js";

const SCENE = `[gd_scene format=3]
[node name="Root" type="Node3D"]
[node name="Victim" type="Node3D" parent="."]
[node name="Child" type="Node3D" parent="Victim" node_paths=PackedStringArray("parent_ref")]
parent_ref = NodePath("..")
[node name="OldSourceChild" parent="Victim" node_paths=PackedStringArray("parent_ref")]
parent_ref = NodePath("..")
[node name="Holder" type="Node" parent="." node_paths=PackedStringArray("target", "other", "child")]
target = NodePath("../Victim")
other = NodePath("../Unrelated")
child = NodePath("../Victim/Child")
plain_path = NodePath("../Victim")
[node name="Unrelated" type="Node3D" parent="."]
`;

describe("replacement Node references", () => {
  it("uses exported Node metadata, resolves relative paths and excludes the discarded source subtree", () => {
    const parsed = parseTscn(SCENE);
    expect(incomingNodeReferences(parsed, "Victim", ["Victim/Child"])).toEqual([
      { owner: "Victim/Child", key: "parent_ref" },
      { owner: "Holder", key: "target" },
    ]);
    expect(missingNodeReferences(parsed, "Victim", [{ owner: "Holder", key: "target" }])).toEqual([]);
    const lost = parseTscn(SCENE.replace('target = NodePath("../Victim")', "target = null"));
    expect(missingNodeReferences(lost, "Victim", [{ owner: "Holder", key: "target" }])).toEqual([
      { owner: "Holder", key: "target" },
    ]);
  });

  it("does not accept an ordinary NodePath string as proof of a persisted Node reference", () => {
    const parsed = parseTscn(SCENE.replace('"target", ', ""));
    expect(missingNodeReferences(parsed, "Victim", [{ owner: "Holder", key: "target" }])).toHaveLength(1);
    expect(incomingNodeReferences(parsed, "Victim", [])).toEqual([]);
  });

  it("refuses a missing reference capability before creating or removing a node", async () => {
    const executeIdentityBoundOps = vi.fn().mockResolvedValue({ results: [{ op: "SaveScene", ok: true }] });
    const client = {
      executeIdentityBoundOps,
      readProjectFile: async () => ({ ok: true, data: { content: SCENE, encoding: "utf-8", truncated: false } }),
      getSceneState: async () => ({}),
      getEngineCapabilities: () => ({ opKinds: ["SaveScene", "InstantiateScene", "SetProp", "ReparentNode", "MoveNode", "RemoveNode"] }),
    };
    expect(await replaceNodePersisted(client, { scenePath: "res://scene.tscn", path: "Victim", scene: "res://replacement.tscn" })).toMatchObject({
      ok: false, failure_reason: "engine_lacks_op", op: "RunSceneScript",
    });
    expect(executeIdentityBoundOps.mock.calls.flatMap((call) => call[0].map((op: { op: string }) => op.op))).toEqual(["SaveScene"]);
  });

  it("targets the exact scene and preserves a structured no-change refusal", async () => {
    const outcome = { ok: false, unchanged: true, error: "incompatible exported type" };
    const executeIdentityBoundOps = vi.fn().mockResolvedValue({ results: [{ op: "RunSceneScript", ok: true, result: outcome }] });
    const result = await rebindNodeReferences(
      { executeIdentityBoundOps }, "res://inactive.tscn", "Victim", "Victim_SummerReplace", [{ owner: "Holder", key: "target" }]
    );
    expect(result).toEqual(outcome);
    const [ops, options, timeout] = executeIdentityBoundOps.mock.calls[0]!;
    expect(options).toEqual({ scenePath: "res://inactive.tscn" });
    expect(ops[0]).toMatchObject({ op: "RunSceneScript", checkpoint: false, undo: "none", max_seconds: 10 });
    expect(timeout).toBeGreaterThan(10_000);
  });

  it("does not assume an errored or missing script result left references unchanged", async () => {
    const executeIdentityBoundOps = vi.fn().mockResolvedValue({ results: [{ op: "RunSceneScript", ok: false, error: "script failed" }] });
    expect(await rebindNodeReferences({ executeIdentityBoundOps }, "res://scene.tscn", "Victim", "New", [])).toMatchObject({
      ok: false, unchanged: false,
    });
  });
});
