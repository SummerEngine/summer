import { describe, expect, it, vi } from "vitest";

vi.mock("../server.js", () => ({ getClient: vi.fn(), resetClient: vi.fn() }));
vi.mock("../../core/telemetry.js", () => ({ recordMcpSession: vi.fn() }));

import { getClient } from "../server.js";
import { registerSceneTools } from "./scene-tools.js";
import { FakeSceneEngine } from "../../test-helpers/fake-scene-engine.js";
import { executeSceneBatch, reownInPlaceOps } from "../../core/capabilities/scene-batch.js";
import { dispatchTool } from "../../core/capabilities/tool-dispatch.js";
import { findTscnNode } from "../../core/capabilities/tscn.js";

const SCENE = "res://levels/room.tscn";
const CRATE = "res://kit/crate.tscn";

// The repro: Box/Toy/ToyPart moved under Cabinet. Box also holds an
// instanced Crate whose own Lid belongs to the crate scene, not to this one.
const CABINET = `[gd_scene format=3]

[ext_resource type="PackedScene" path="${CRATE}" id="1_crate"]

[node name="Root" type="Node3D"]

[node name="Box" type="Node3D" parent="."]
position = Vector3(1, 0, 0)

[node name="Toy" type="Node3D" parent="Box"]

[node name="ToyPart" type="MeshInstance3D" parent="Box/Toy"]

[node name="Crate" parent="Box" instance=ExtResource("1_crate")]

[node name="Cabinet" type="Node3D" parent="."]
`;

function engine(tscn = CABINET, options: Partial<ConstructorParameters<typeof FakeSceneEngine>[2]> = {}) {
  return new FakeSceneEngine(SCENE, tscn, {
    scenes: { [CRATE]: { rootType: "StaticBody3D", children: [{ name: "Lid", type: "MeshInstance3D" }] } },
    ...options,
  });
}

const MOVE = { op: "ReparentNode", path: "Box", new_parent_path: "Cabinet" };

type RegisteredTool = { name: string; handler: (args: Record<string, unknown>) => Promise<unknown> };
type ToolText = { isError?: boolean; content: Array<{ text: string }> };

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

function savedPaths(fake: FakeSceneEngine): string[] {
  return fake.savedScene().nodes.map((n) => n.path);
}

describe("the fake engine reproduces the ReparentNode engine bug (regression guard)", () => {
  it("a raw ReparentNode + SaveScene saves the moved node without its children", async () => {
    const fake = engine();
    await fake.executeIdentityBoundOps([MOVE], { scenePath: SCENE });
    const receipt = (await fake.executeIdentityBoundOps([{ op: "SaveScene" }], { scenePath: SCENE })) as Record<string, unknown>;
    // The receipt says the save ran ...
    expect(receipt.scenePersistence).toMatchObject({ saved: true });
    // ... and the file holds Cabinet/Box but not Toy or ToyPart (the instanced Crate keeps its own Lid).
    expect(savedPaths(fake)).toContain("Cabinet/Box");
    expect(savedPaths(fake)).not.toContain("Cabinet/Box/Toy");
    expect(savedPaths(fake)).not.toContain("Cabinet/Box/Toy/ToyPart");
    // Live, the editor still shows them.
    expect(fake.liveChildren("Cabinet/Box")).toEqual(["Toy", "Crate"]);
  });
});

describe("summer_batch ReparentNode keeps the moved node's subtree and verifies it", () => {
  it("saves every scene-owned descendant under the new path, in order, and proves it from the file", async () => {
    const fake = engine();
    const result = (await executeSceneBatch(fake, SCENE, [MOVE], { groupUndo: true })) as Record<string, unknown>;

    expect(result).toMatchObject({
      ok: true,
      persisted: true,
      verified: true,
      scenePersistence: { saved: true, verified: true },
      verification: { verified: true, read_back: SCENE },
      reparented: [{ path: "Box", new_path: "Cabinet/Box", reowned: ["Cabinet/Box/Toy", "Cabinet/Box/Crate", "Cabinet/Box/Toy/ToyPart"] }],
    });
    expect((result.verification as Record<string, unknown>).checked).toEqual(
      expect.arrayContaining(["Cabinet/Box", "Cabinet/Box/Toy", "Cabinet/Box/Toy/ToyPart", "Cabinet/Box/Crate"])
    );
    // One result per caller op (the ReparentNode and the appended SaveScene).
    expect((result.results as Array<{ op: string }>).map((r) => r.op)).toEqual(["ReparentNode", "SaveScene"]);

    const paths = savedPaths(fake);
    expect(paths).toEqual(expect.arrayContaining(["Cabinet/Box", "Cabinet/Box/Toy", "Cabinet/Box/Toy/ToyPart", "Cabinet/Box/Crate"]));
    expect(paths).not.toContain("Box");
    // The crate scene's own Lid stays the crate's: never written as a node of this scene.
    expect(paths).not.toContain("Cabinet/Box/Crate/Lid");
    expect(findTscnNode(fake.savedScene(), "Cabinet/Box/Crate")?.instancePath).toBe(CRATE);
    expect(findTscnNode(fake.savedScene(), "Cabinet/Box")?.props).toEqual([{ key: "position", value: "Vector3(1, 0, 0)" }]);
    // Sibling order kept.
    expect(fake.savedScene().nodes.filter((n) => n.parent === "Cabinet/Box").map((n) => n.name)).toEqual(["Toy", "Crate"]);
  });

  it("sends a pre-save, the move with one in-place ReparentNode per descendant (shallowest first, same index), then the save", async () => {
    const fake = engine();
    await executeSceneBatch(fake, SCENE, [MOVE]);
    expect(fake.sent).toEqual([
      [{ op: "SaveScene" }],
      [
        MOVE,
        { op: "ReparentNode", path: "Cabinet/Box/Toy", new_parent_path: "Cabinet/Box", keep_global_transform: false, new_index: 0 },
        { op: "ReparentNode", path: "Cabinet/Box/Crate", new_parent_path: "Cabinet/Box", keep_global_transform: false, new_index: 1 },
        { op: "ReparentNode", path: "Cabinet/Box/Toy/ToyPart", new_parent_path: "Cabinet/Box/Toy", keep_global_transform: false, new_index: 0 },
      ],
      [{ op: "SaveScene" }],
    ]);
  });

  it("keeps nodes created earlier in the same batch, and follows a rename after the move", async () => {
    const fake = engine();
    const result = (await executeSceneBatch(fake, SCENE, [
      { op: "AddNode", parent: ".", type: "Node3D", name: "Gift" },
      { op: "AddNode", parent: "./Gift", type: "Node3D", name: "Ribbon" },
      { op: "AddNode", parent: "Gift/Ribbon", type: "MeshInstance3D", name: "Bow" },
      { op: "ReparentNode", path: "./Gift", new_parent_path: "./Cabinet" },
      { op: "SetProp", path: "Cabinet/Gift", key: "name", value: "Present" },
    ])) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, persisted: true, verified: true });
    expect(savedPaths(fake)).toEqual(expect.arrayContaining(["Cabinet/Present", "Cabinet/Present/Ribbon", "Cabinet/Present/Ribbon/Bow"]));
    expect((result.verification as Record<string, unknown>).checked).toEqual(
      expect.arrayContaining(["Cabinet/Present", "Cabinet/Present/Ribbon", "Cabinet/Present/Ribbon/Bow"])
    );
  });

  it("reports persisted:false with failure_reason not_persisted when the saved file lacks the subtree", async () => {
    const fake = engine(CABINET, { saveDropsChanges: true });
    const result = (await executeSceneBatch(fake, SCENE, [MOVE])) as Record<string, unknown>;
    expect(result).toMatchObject({
      ok: false,
      failure_reason: "not_persisted",
      persisted: false,
      verified: false,
      scenePersistence: { saved: true, verified: false },
    });
    expect((result.verification as Record<string, unknown>).missing).toEqual(
      expect.arrayContaining(["Cabinet/Box", "Cabinet/Box/Toy", "Cabinet/Box/Toy/ToyPart"])
    );
    expect(String(result.error)).toContain("did NOT persist");
  });

  it("MCP face: a verified move returns persisted:true; an unverified one is isError with not_persisted", async () => {
    const good = engine();
    vi.mocked(getClient).mockResolvedValue(good as never);
    const ok = (await sceneTool("summer_batch").handler({ scenePath: SCENE, ops: [MOVE] })) as ToolText;
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse(ok.content[0]!.text)).toMatchObject({ ok: true, persisted: true, verified: true });
    expect(savedPaths(good)).toContain("Cabinet/Box/Toy/ToyPart");

    const lying = engine(CABINET, { saveDropsChanges: true });
    vi.mocked(getClient).mockResolvedValue(lying as never);
    const bad = (await sceneTool("summer_batch").handler({ scenePath: SCENE, ops: [MOVE] })) as ToolText;
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain("not_persisted");
    expect(bad.content[0]!.text).toContain("persisted:false");
  });

  it("CLI face runs the same implementation", async () => {
    const fake = engine();
    const result = await dispatchTool("batch", { scenePath: SCENE, ops: [MOVE] }, { engine: async () => fake as never });
    expect(result).toMatchObject({ ok: true, persisted: true, verified: true });
    expect(savedPaths(fake)).toContain("Cabinet/Box/Toy/ToyPart");
  });

  it("refuses a move onto a parent that already has a child of that name (the engine would rename it)", async () => {
    const clash = CABINET + `\n[node name="Box" type="Node3D" parent="Cabinet"]\n`;
    const fake = engine(clash);
    const result = (await executeSceneBatch(fake, SCENE, [MOVE])) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: false, failure_reason: "name_collision" });
    expect(fake.opsSent()).toEqual(["SaveScene"]);
  });

  it("refuses Undo in the same batch and a binary .scn, before anything is sent", async () => {
    const fake = engine();
    await expect(executeSceneBatch(fake, SCENE, [MOVE, { op: "Undo" }])).rejects.toThrow(/Undo/);
    await expect(executeSceneBatch(fake, "res://level.scn", [MOVE])).rejects.toThrow(/\.tscn/);
    expect(fake.sent).toEqual([]);
  });

  it("a batch without ReparentNode is sent exactly as before (no pre-save, no read-back)", async () => {
    const fake = engine();
    await executeSceneBatch(fake, SCENE, [{ op: "SetProp", path: "Box", key: "visible", value: false }]);
    expect(fake.sent).toEqual([[{ op: "SetProp", path: "Box", key: "visible", value: false }], [{ op: "SaveScene" }]]);
  });
});

describe("summer_batch refuses a raw ConnectSignal", () => {
  it("sends nothing on either face and points at summer_connect_signal", async () => {
    const fake = engine();
    vi.mocked(getClient).mockResolvedValue(fake as never);
    const ops = [{ op: "ConnectSignal", emitter: "Box", signal: "ready", receiver: ".", method: "queue_free" }];
    const result = (await sceneTool("summer_batch").handler({ scenePath: SCENE, ops })) as ToolText;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("summer_connect_signal");
    await expect(dispatchTool("batch", { scenePath: SCENE, ops }, { engine: async () => fake as never })).rejects.toThrow(
      /summer_connect_signal/
    );
    expect(fake.sent).toEqual([]);
  });
});

describe("reownInPlaceOps", () => {
  it("orders shallowest first and keeps the live index when known", () => {
    const rebase = (p: string) => p.replace(/^Box/, "Cabinet/Box");
    expect(reownInPlaceOps(["Box/A/B", "Box/C", "Box/A"], rebase, new Map([["Box/A", 1], ["Box/C", 0], ["Box/A/B", 0]]))).toEqual([
      { op: "ReparentNode", path: "Cabinet/Box/C", new_parent_path: "Cabinet/Box", keep_global_transform: false, new_index: 0 },
      { op: "ReparentNode", path: "Cabinet/Box/A", new_parent_path: "Cabinet/Box", keep_global_transform: false, new_index: 1 },
      { op: "ReparentNode", path: "Cabinet/Box/A/B", new_parent_path: "Cabinet/Box/A", keep_global_transform: false, new_index: 0 },
    ]);
  });
});
