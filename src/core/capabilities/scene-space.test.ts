import { expect, it, vi } from "vitest";
import { readSceneNodeTransform } from "./scene-space.js";

it("keeps native vector arrays and the full transform without Euler reconstruction", async () => {
  const local = { position: "Vector3(0.125, 3, 4)", rotation_degrees: "Vector3(0, 0, 0)", scale: "Vector3(1, 1, 1)", rotation_order: 2, transform: "Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0.125, 3, 4)" };
  const result = { ok: true, local, world_origin: "Vector3(2.125, 3, 4)", origin: [2.125, 3, 4], position: [2.125, 3, 4], transform: "Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 2.125, 3, 4)", parent_transform: "Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0)", independent_geometry: ["Group/Plain/Mesh"] };
  const client = { executeIdentityBoundOps: vi.fn(async () => ({ results: [{ op: "RunSceneScript", ok: true, result }] })) };
  expect(await readSceneNodeTransform(client, "Group", "res://room.tscn", true)).toEqual({ local, worldOrigin: result.world_origin, origin: [2.125, 3, 4], position: [2.125, 3, 4], transform: result.transform, independentGeometry: ["Group/Plain/Mesh"] });
  expect(client.executeIdentityBoundOps.mock.calls[0]).toEqual([expect.arrayContaining([expect.objectContaining({ op: "RunSceneScript", undo: "none", checkpoint: false })]), { scenePath: "res://room.tscn" }, expect.any(Number)]);
});

it("does not fabricate transforms when the engine lacks the native read", async () => {
  const client = { getEngineCapabilities: () => ({ opKinds: ["GetWorldSnapshot"] }), executeOps: vi.fn() };
  expect(await readSceneNodeTransform(client, "Top")).toMatchObject({ error: expect.stringContaining("RunSceneScript") });
  expect(client.executeOps).not.toHaveBeenCalled();
});

it("reports malformed native data instead of treating a missing transform as identity", async () => {
  const client = { executeOps: vi.fn(async () => ({ results: [{ op: "RunSceneScript", ok: true, result: { ok: true, origin: [0, 1] } }] })) };
  expect(await readSceneNodeTransform(client, "Top")).toEqual({ error: "native transform read returned incomplete data" });
});

it("requires a native position before a requested world movement can be written", async () => {
  const result = { ok: true, origin: [0, 0, 0], position: [0, 0, 0], transform: "Transform3D()" };
  const client = { executeOps: async () => ({ results: [{ op: "RunSceneScript", ok: true, result }] }) };
  expect(await readSceneNodeTransform(client, "Child", "res://a.tscn", false, [1, 2, 3]))
    .toEqual({ error: "native transform read returned no translated position" });
});
