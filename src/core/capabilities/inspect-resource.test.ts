import { describe, expect, it, vi } from "vitest";

vi.mock("../telemetry.js", () => ({ recordMcpSession: vi.fn() }));

import { EngineApiClient } from "../api-client.js";
import { ToolInputError } from "../tool-errors.js";
import {
  INSPECT_RESOURCE_ARGS_TOKEN,
  buildInspectResourceScript,
  inspectResource,
  inspectResourceInputSchema,
  inspectResourceProbeTemplate,
} from "./inspect-resource.js";
import { gdscriptStructureProblems } from "../../test-helpers/gdscript-structure.js";

type Op = Record<string, unknown>;

function probeArgs(op: Op): Op {
  const line = String(op.script_source).split("\n").find((l) => l.startsWith("const ARGS_B64 = "))!;
  return JSON.parse(Buffer.from(JSON.parse(line.slice("const ARGS_B64 = ".length)) as string, "base64").toString("utf8")) as Op;
}

/** What the probe returns for a small single-surface kit mesh. */
const OUTLET_MESH = {
  ok: true,
  path: "res://kit/meshes/gutter_outlet.res",
  resource_type: "ArrayMesh",
  mesh: {
    aabb: { min: [-0.077, -0.272, -0.167], max: [0.077, 0.132, 0.094], size: [0.153, 0.404, 0.261] },
    surface_count: 1,
    surfaces: [
      {
        index: 0,
        attributes: ["normal", "tangent", "uv", "index"],
        primitive: "triangles",
        vertices: 725,
        indices: 4026,
        triangles: 1342,
        material: { class: "StandardMaterial3D", embedded: true, albedo_color: "Color(1, 1, 1, 1)", transparency: 0, cull_mode: 0 },
      },
    ],
    triangles: 1342,
    vertices: 725,
    materials: [{ class: "StandardMaterial3D", embedded: true }],
    blend_shapes: 0,
  },
  props: { custom_aabb: "AABB(0, 0, 0, 0, 0, 0)" },
  props_at_default: 4,
};

function fakeClient(answer: (args: Op) => Op, options: { lacks?: string[] } = {}) {
  const sent: Op[][] = [];
  const client = {
    sent,
    executeIdentityBoundOps: vi.fn(async (ops: Op[]) => {
      sent.push(ops);
      return { status: "ok", terminalState: "applied", results: [{ ok: true, op: "RunSceneScript", ran: true, result: answer(probeArgs(ops[0]!)) }] };
    }),
    inspectNodeResource: vi.fn(async (nodePath: string, property: string) => ({
      ok: true,
      data: { resource_type: "PlaneMesh", resource_path: "", props: [{ name: "size", type: 5, value: [10, 10] }] },
      provenance: { source: "editor_scene", kind: "resource", path: `${nodePath}:${property}` },
    })),
    getEngineCapabilities: () =>
      options.lacks ? { opKinds: ["SetProp", "SaveScene", "RunSceneScript"].filter((k) => !options.lacks!.includes(k)) } : undefined,
  };
  return client;
}

// Regression: summer_inspect_resource on a mesh .res used to answer "missing nodePath or property" although the schema takes only
// path: the tool sent ?path= to state:resource, which reads a resource a NODE
// holds and takes nodePath + property.
describe("summer_inspect_resource on a resource file", () => {
  it("loads a mesh .res read-only and returns its AABB, surfaces and materials, never the node endpoint", async () => {
    const client = fakeClient(() => OUTLET_MESH);
    const result = (await inspectResource(client, inspectResourceInputSchema.parse({ path: OUTLET_MESH.path }))) as Record<string, unknown>;
    expect(client.inspectNodeResource).not.toHaveBeenCalled();
    const op = client.sent[0]![0]!;
    expect(op).toMatchObject({ op: "RunSceneScript", checkpoint: false, undo: "none" });
    expect(probeArgs(op)).toEqual({ path: OUTLET_MESH.path });
    expect(result).toMatchObject({
      ok: true,
      tool: "summer_inspect_resource",
      source: "file",
      resource_type: "ArrayMesh",
      evidence: "resource_loader",
      mesh: {
        surface_count: 1,
        triangles: 1342,
        aabb: { size: [0.153, 0.404, 0.261] },
        surfaces: [{ primitive: "triangles", vertices: 725, indices: 4026, material: { class: "StandardMaterial3D" } }],
        materials: [{ class: "StandardMaterial3D" }],
      },
    });
  });

  it("describes a .glb as a scene and points to summer_inspect_asset", async () => {
    const client = fakeClient(() => ({
      ok: true,
      path: "res://models/player.glb",
      resource_type: "PackedScene",
      scene: {
        node_count: 3,
        root_type: "Node3D",
        nodes: [
          { path: ".", type: "Node3D" },
          { path: "Body", type: "MeshInstance3D", mesh: { class: "ArrayMesh", embedded: true } },
          { path: "Skeleton3D", type: "Skeleton3D" },
        ],
        mesh_nodes: 1,
        meshes: [{ class: "ArrayMesh", embedded: true, surfaces: 2, aabb_size: [0.6, 1.8, 0.4] }],
      },
      next: "summer_inspect_asset measures this scene (AABB, origin, planes, ports, anchors, collision); summer_inspect_resource on one of its mesh paths lists that mesh's surfaces and materials",
    }));
    const result = (await inspectResource(client, { path: "res://models/player.glb" })) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, resource_type: "PackedScene", scene: { node_count: 3, mesh_nodes: 1 } });
    expect(String(result.next)).toContain("summer_inspect_asset");
  });

  it("passes the probe's structured failure through", async () => {
    const client = fakeClient(() => ({ ok: false, failure_reason: "resource_not_found", error: "No resource at res://nope.res" }));
    const result = (await inspectResource(client, { path: "res://nope.res" })) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: false, failure_reason: "resource_not_found", error: "No resource at res://nope.res" });
  });

  it("keeps a large scene answer bounded and declares the cut", async () => {
    const nodes = Array.from({ length: 40 }, (_, i) => ({ path: `Facade/Storey_${i}/Window_with_a_long_name_${i}`, type: "MeshInstance3D", mesh: { class: "ArrayMesh", path: `res://kit/meshes/window_${i}.res` } }));
    const meshes = Array.from({ length: 24 }, (_, i) => ({ class: "ArrayMesh", path: `res://kit/meshes/window_${i}.res`, surfaces: 3, aabb_size: [1, 2, 0.2] }));
    const client = fakeClient(() => ({ ok: true, path: "res://big.tscn", resource_type: "PackedScene", scene: { node_count: 900, root_type: "Node3D", nodes, nodes_cut: 860, mesh_nodes: 800, meshes } }));
    const result = await inspectResource(client, { path: "res://big.tscn" });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(6500);
    expect((result as { scene: { truncated: Record<string, unknown> } }).scene.truncated).toBeDefined();
  });

  it("answers engine_lacks_op without sending on an engine without RunSceneScript", async () => {
    const client = fakeClient(() => OUTLET_MESH, { lacks: ["RunSceneScript"] });
    const result = (await inspectResource(client, { path: OUTLET_MESH.path })) as Record<string, unknown>;
    expect(result.failure_reason).toBe("engine_lacks_op");
    expect(client.sent).toHaveLength(0);
  });
});

describe("summer_inspect_resource on a resource a node holds", () => {
  it("sends nodePath + property to the engine endpoint", async () => {
    const client = fakeClient(() => OUTLET_MESH);
    const result = await inspectResource(client, { nodePath: "Floor", property: "mesh" });
    expect(client.inspectNodeResource).toHaveBeenCalledWith("Floor", "mesh");
    expect(client.sent).toHaveLength(0);
    expect(result).toMatchObject({ ok: true, data: { resource_type: "PlaneMesh" } });
  });

  it("the client asks state:resource with nodePath and property, not path", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    await EngineApiClient.prototype.inspectNodeResource.call({ request } as never, "World/Floor", "material_override");
    expect(request).toHaveBeenCalledWith("GET", "/api/state/resource?nodePath=World%2FFloor&property=material_override");
  });
});

describe("summer_inspect_resource arguments", () => {
  it("takes exactly one form", async () => {
    const client = fakeClient(() => OUTLET_MESH);
    await expect(inspectResource(client, { path: "res://a.res", nodePath: "Floor", property: "mesh" })).rejects.toBeInstanceOf(ToolInputError);
    await expect(inspectResource(client, {})).rejects.toBeInstanceOf(ToolInputError);
    await expect(inspectResource(client, { nodePath: "Floor" })).rejects.toThrow("nodePath and property go together");
    expect(inspectResourceInputSchema.safeParse({ path: "/tmp/a.res" }).success).toBe(false);
    expect(inspectResourceInputSchema.safeParse({ path: "res://../outside.res" }).success).toBe(false);
    expect(inspectResourceInputSchema.safeParse({ path: "res://kit/model (1).glb" }).success).toBe(true);
  });

  it("carries the path only as base64 data in a structurally sound probe", () => {
    const template = inspectResourceProbeTemplate();
    expect(template.split(INSPECT_RESOURCE_ARGS_TOKEN)).toHaveLength(2);
    expect(gdscriptStructureProblems(template)).toEqual([]);
    const hostile = 'res://a"); OS.execute("rm", ["-rf", "/"]); #.res';
    const source = buildInspectResourceScript({ path: hostile });
    const [before, after] = template.split(INSPECT_RESOURCE_ARGS_TOKEN) as [string, string];
    const literal = source.slice(before.length, source.length - after.length);
    expect(literal).toMatch(/^"[A-Za-z0-9+/]*={0,2}"$/);
    // Mesh surfaces are read through ArrayMesh-only calls only on an ArrayMesh.
    expect(template).toContain("if mesh is ArrayMesh:\n\t\t\tprim = mesh.surface_get_primitive_type(s)");
  });
});
