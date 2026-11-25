import { describe, expect, it, vi } from "vitest";
import { inspectNodeFields } from "./inspect-node.js";
import { dispatchTool } from "./tool-dispatch.js";

// A ~5 KB inspector read: the target props plus a long tail.
function inspector(path: string) {
  return {
    ok: true,
    provenance: { scenePath: "res://room.tscn" },
    data: {
      node_name: path.split("/").pop(),
      node_type: "StaticBody3D",
      node_path: path,
      props: [
        { name: "position", type: 9, value: "(1, 0, -2)" },
        { name: "rotation", type: 9, value: `(0, ${(Math.PI / 2).toFixed(3)}, 0)` },
        { name: "scale", type: 9, value: "(1, 1, 1)" },
        { name: "rotation_order", type: 2, value: 2 },
        { name: "surface_material_override/0", type: 24, value: "<StandardMaterial3D#1>" },
        { name: "surface_material_override/1", type: 24, value: null },
        ...Array.from({ length: 80 }, (_, i) => ({ name: `some_property_${i}`, type: 3, value: i * 0.5 })),
      ],
      warnings: ["no collision shape"],
    },
  };
}

const snapshot = {
  ok: true,
  results: [
    {
      ok: true,
      op: "GetWorldSnapshot",
      nodes: [
        { path: ".", class: "Node3D", pos: "Vector3(0, 0, 0)", rot_deg: "Vector3(0, 0, 0)", scale: "Vector3(1, 1, 1)" },
        { path: "House3", class: "Node3D", pos: "Vector3(10, 0, 0)", rot_deg: "Vector3(0, 90, 0)", scale: "Vector3(2, 2, 2)" },
        { path: "House3/Door", class: "StaticBody3D", pos: "Vector3(1, 0, 0)", rot_deg: "Vector3(0, 0, 0)", scale: "Vector3(1, 1, 1)", scene_file: "res://kit/door.tscn", aabb: { pos: "Vector3(9, 0, -3)", size: "Vector3(2, 4, 1)" } },
        { path: "Logic", class: "Node" },
        { path: "Logic/Marker", class: "Marker3D", pos: "Vector3(0, 1, 0)", rot_deg: "Vector3(0, 0, 0)", scale: "Vector3(1, 1, 1)" },
      ],
    },
  ],
};

function client() {
  let path = "";
  return {
    inspectNode: vi.fn(async (value: string) => { path = value; return inspector(value); }),
    executeOps: vi.fn(async (ops: Record<string, unknown>[]) => {
      if (ops[0]?.op !== "RunSceneScript") return snapshot;
      const origin = path === "Logic/Marker" ? [0, 1, 0] : [10, 0, -2];
      const local = { position: "Vector3(0.00025, 0, -2)", rotation_degrees: "Vector3(0, 0, 0)", scale: "Vector3(1, 1.25, 1)", rotation_order: 2, transform: "Transform3D(1, 0.75, 0, 0, 1, 0, 0, 0, 1, 0.00025, 0, -2)" };
      const transform = path === "Logic/Marker"
        ? "Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0)"
        : "Transform3D(0, 0, 2, 0, 2, 0, -2, 0, 0, 10, 0, -2)";
      return { ok: true, results: [{ ok: true, op: "RunSceneScript", result: { ok: true, origin, local, world_origin: `Vector3(${origin.join(", ")})`, position: [1, 0, 0], transform, parent_transform: "Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0)", independent_geometry: [] } }] };
    }),
  };
}

describe("summer_inspect_node fields", () => {
  it("without fields returns the whole inspector read and sends no snapshot", async () => {
    const c = client();
    const result = (await inspectNodeFields(c, { path: "House3/Door" })) as { data: { props: unknown[] } };
    expect(result.data.props).toHaveLength(86);
    expect(c.executeOps).not.toHaveBeenCalled();
  });

  it("transform + globs read only what was asked, and name what is missing", async () => {
    const c = client();
    const result = (await inspectNodeFields(c, { path: "House3/Door", fields: ["transform", "global_transform", "surface_material_override/*", "nope"] })) as {
      data: Record<string, unknown> & { props: Array<{ name: string }>; transform: Record<string, string> };
    };
    expect(result.data.props.map((p) => p.name)).toEqual(["surface_material_override/0", "surface_material_override/1"]);
    expect(result.data.transform.position).toBe("Vector3(0.00025, 0, -2)");
    expect(result.data.transform.rotation_degrees).toBe("Vector3(0, 0, 0)");
    expect(result.data.transform.transform).toBe("Transform3D(1, 0.75, 0, 0, 1, 0, 0, 0, 1, 0.00025, 0, -2)");
    expect(result.data.missing_fields).toEqual(["nope"]);
    expect(c.executeOps).toHaveBeenCalledTimes(1);
    expect(c.executeOps).toHaveBeenCalledWith([expect.objectContaining({ op: "RunSceneScript" })], { scenePath: "res://room.tscn" }, expect.any(Number));
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1100);
  });

  it("global_transform reads the native transform; scene_file_path and aabb come from the world snapshot", async () => {
    const c = client();
    const result = (await inspectNodeFields(c, { path: "House3/Door", fields: ["global_transform", "scene_file_path", "aabb"] })) as {
      data: Record<string, unknown> & { global_transform: { origin: string; transform: string } };
    };
    expect(c.executeOps).toHaveBeenCalledWith([{ op: "GetWorldSnapshot" }]);
    expect(c.executeOps.mock.calls.some(([ops]) => ops[0]?.op === "RunSceneScript")).toBe(true);
    // House3 at x=10 turned 90 degrees about Y with scale 2: local (1,0,0) lands at (10, 0, -2).
    expect(result.data.global_transform.origin).toBe("Vector3(10, 0, -2)");
    expect(result.data.global_transform.transform).toBe("Transform3D(0, 0, 2, 0, 2, 0, -2, 0, 0, 10, 0, -2)");
    expect(result.data.scene_file_path).toBe("res://kit/door.tscn");
    expect(result.data.aabb).toEqual({ pos: "Vector3(9, 0, -3)", size: "Vector3(2, 4, 1)" });
  });

  it("a Node3D under a plain Node starts its own 3D space", async () => {
    const c = client();
    const result = (await inspectNodeFields(c, { path: "Logic/Marker", fields: ["global_transform"] })) as {
      data: { global_transform: { origin: string } };
    };
    expect(result.data.global_transform.origin).toBe("Vector3(0, 1, 0)");
  });

  it("says when the required native transform and snapshot reads are unavailable", async () => {
    const c = { ...client(), getEngineCapabilities: () => ({ opKinds: ["AddNode"] }) };
    const result = (await inspectNodeFields(c, { path: "House3/Door", fields: ["transform", "global_transform", "aabb", "warnings"] })) as {
      data: { unavailable: Record<string, string>; warnings: string[] };
    };
    expect(result.data.unavailable.transform).toContain("RunSceneScript");
    expect(result.data.unavailable.global_transform).toContain("RunSceneScript");
    expect(result.data.unavailable.aabb).toContain("GetWorldSnapshot");
    expect(result.data.warnings).toEqual(["no collision shape"]);
    expect(c.executeOps).not.toHaveBeenCalled();
  });

  it("the CLI face takes the same fields", async () => {
    const c = client();
    const result = (await dispatchTool("inspect-node", { path: "House3/Door", fields: ["scene_file_path"] }, { engine: async () => c as never })) as {
      data: Record<string, unknown>;
    };
    expect(result.data.scene_file_path).toBe("res://kit/door.tscn");
    expect(result.data).not.toHaveProperty("props");
  });
});
