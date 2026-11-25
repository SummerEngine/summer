import { describe, expect, it } from "vitest";
import { buildWorldSnapshotOp, shapeWorldSnapshot, WORLD_SNAPSHOT_DEFAULT_MAX_NODES } from "./world-snapshot.js";
import { dispatchTool } from "./tool-dispatch.js";

function node(path: string, cls: string, extra: Record<string, unknown> = {}) {
  return { path, class: cls, name: path.split("/").pop(), pos: "Vector3(0, 0, 0)", rot_deg: "Vector3(0, 0, 0)", scale: "Vector3(1, 1, 1)", visible: true, aabb: { pos: "Vector3(0, 0, 0)", size: "Vector3(1, 1, 1)" }, ...extra };
}

// A 2700-node scene: two houses of 1300 pieces plus props.
const nodes = [
  node(".", "Node3D"),
  ...Array.from({ length: 1300 }, (_, i) => node(`House1/P${String(i).padStart(4, "0")}`, "StaticBody3D")),
  ...Array.from({ length: 1300 }, (_, i) => node(`House3/P${String(i).padStart(4, "0")}`, i % 2 ? "MeshInstance3D" : "StaticBody3D", { scene_file: "res://kit/wall.tscn" })),
  ...Array.from({ length: 99 }, (_, i) => node(`Props/Bench${i}`, "Node3D")),
].sort((a, b) => (a.path < b.path ? -1 : 1));

const envelope = {
  ok: true,
  results: [
    {
      ok: true,
      op: "GetWorldSnapshot",
      snapshot_id: "ws-7",
      total_nodes: 2700,
      truncated: false,
      nodes,
      lights: [{ path: "House3/Lamp", class: "OmniLight3D" }, { path: "Props/Lamp", class: "SpotLight3D" }],
      cameras: [],
      counts: { StaticBody3D: 1950, MeshInstance3D: 650, Node3D: 100 },
    },
  ],
};

type Shaped = { results: Array<Record<string, unknown> & { nodes: Array<Record<string, unknown>> }> };

describe("summer_world_snapshot filters", () => {
  it("lists at most the default cap and keeps whole-scene counts and the snapshot id", () => {
    const shaped = (shapeWorldSnapshot(envelope, {}) as Shaped).results[0]!;
    expect(shaped.nodes).toHaveLength(WORLD_SNAPSHOT_DEFAULT_MAX_NODES);
    expect(WORLD_SNAPSHOT_DEFAULT_MAX_NODES).toBeLessThanOrEqual(300);
    expect(shaped).toMatchObject({ truncated: true, matched_nodes: 2700, next_offset: 200, snapshot_id: "ws-7", total_nodes: 2700 });
    expect(shaped.counts).toEqual(envelope.results[0]!.counts);
  });

  it("path_prefix + classes + fields read one subtree cheaply, with subtree class counts", () => {
    const shaped = (shapeWorldSnapshot(envelope, {
      path_prefix: "./House3",
      classes: ["Mesh*"],
      fields: ["pos", "scene_file"],
      max_nodes: 5,
      offset: 10,
    }) as Shaped).results[0]!;
    expect(shaped.matched_nodes).toBe(650);
    expect(shaped.matched_counts).toEqual({ MeshInstance3D: 650 });
    expect(shaped.nodes).toHaveLength(5);
    expect(shaped.nodes[0]).toEqual({ path: "House3/P0021", pos: "Vector3(0, 0, 0)", scene_file: "res://kit/wall.tscn" });
    expect(shaped.next_offset).toBe(15);
    expect(shaped.lights).toEqual([{ path: "House3/Lamp", class: "OmniLight3D" }]);
    expect(Buffer.byteLength(JSON.stringify(shaped))).toBeLessThan(2500);
  });

  it("the prefix matches the subtree only, not a sibling sharing the name start", () => {
    const shaped = (shapeWorldSnapshot(envelope, { path_prefix: "House1", max_nodes: 5000 }) as Shaped).results[0]!;
    expect(shaped.matched_nodes).toBe(1300);
    expect(shaped.next_offset).toBeNull();
    expect(shaped.truncated).toBe(false);
  });

  it("identifies a missing filtered match when the engine truncated the baseline", () => {
    const partial = { ...envelope.results[0]!, total_nodes: 4002, truncated: true };
    const shaped = shapeWorldSnapshot(partial, { path_prefix: "Tail" });
    expect(shaped).toMatchObject({
      engine_truncated: true, truncated: true, matched_nodes: 0, returned_nodes: 0, next_offset: null,
      total_nodes: 4002, note: expect.stringContaining("Increase max_nodes"),
    });
    expect(shapeWorldSnapshot(partial, { max_nodes: 5000 })).toMatchObject({
      engine_truncated: true, next_offset: null, note: expect.stringContaining("only the captured node entries"),
    });
  });

  it("the engine baseline is never capped below its default; failures pass through", () => {
    expect(buildWorldSnapshotOp({ max_nodes: 50 })).toEqual({ op: "GetWorldSnapshot", include_2d: true });
    expect(buildWorldSnapshotOp({ include_2d: false })).toEqual({ op: "GetWorldSnapshot", include_2d: false });
    expect(buildWorldSnapshotOp({ max_nodes: 9000, scene_path: "res://a.tscn" })).toEqual({ op: "GetWorldSnapshot", include_2d: true, scene_path: "res://a.tscn", max_nodes: 9000 });
    const failure = { ok: false, results: [{ ok: false, op: "GetWorldSnapshot", error: "no edited scene" }] };
    expect(shapeWorldSnapshot(failure, { path_prefix: "A" })).toBe(failure);
  });

  it("can find a 2D child by class on editors that omit 2D rows by default", async () => {
    const child = { path: "UI/Label", class: "Label" };
    const client = {
      async executeOps([op]: Array<{ include_2d?: boolean }>) {
        const nodes = op?.include_2d ? [child] : [];
        return { results: [{ ok: true, op: "GetWorldSnapshot", nodes, counts: { Label: 1 } }] };
      },
    };
    const ctx = { engine: async () => client as never };
    const byClass = { classes: ["Label"] };
    const included = await dispatchTool("world-snapshot", byClass, ctx);
    const excluded = await dispatchTool("world-snapshot", { ...byClass, include_2d: false }, ctx);
    expect(included).toMatchObject({ results: [{ matched_nodes: 1, nodes: [child] }] });
    expect(excluded).toMatchObject({ results: [{ matched_nodes: 0, nodes: [] }] });
  });

  it("the CLI face shapes the result the same way", async () => {
    const client = { executeOps: async () => envelope };
    const result = (await dispatchTool("world-snapshot", { path_prefix: "Props", fields: ["pos"] }, { engine: async () => client as never })) as Shaped;
    expect(result.results[0]!.matched_nodes).toBe(99);
    expect(Object.keys(result.results[0]!.nodes[0]!)).toEqual(["path", "pos"]);
  });
});
