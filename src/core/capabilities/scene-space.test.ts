import { expect, it, vi } from "vitest";
import { localPositionAfterWorldDelta } from "./placement-math.js";
import { readSceneNodeTransform } from "./scene-space.js";

it("keeps native vector arrays and the full transform without Euler reconstruction", async () => {
  const result = { ok: true, origin: [2.125, 3, 4], position: [2.125, 3, 4], transform: "Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 2.125, 3, 4)", parent_transform: "Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0)", independent_geometry: ["Group/Plain/Mesh"] };
  const client = { executeIdentityBoundOps: vi.fn(async () => ({ results: [{ op: "RunSceneScript", ok: true, result }] })) };
  expect(await readSceneNodeTransform(client, "Group", "res://room.tscn", true)).toEqual({ origin: [2.125, 3, 4], position: [2.125, 3, 4], transform: result.transform, parentBasis: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], independentGeometry: ["Group/Plain/Mesh"] });
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

it("decodes a reflected and sheared native parent for a world-space translation", async () => {
  const literal = "Transform3D(0, 3, 1, 2, 0.5, 0, -1, 0, 4, 50, -30, 7)";
  const result = { ok: true, origin: [0, 0, 0], position: [0.25, 2, -0.75], transform: literal, parent_transform: literal };
  const client = { executeOps: async () => ({ results: [{ op: "RunSceneScript", ok: true, result }] }) };
  const native = await readSceneNodeTransform(client, "Child");
  if ("error" in native) throw new Error(native.error);
  expect(native.parentBasis).toEqual([[0, 2, -1], [3, 0.5, 0], [1, 0, 4]]);
  const local = localPositionAfterWorldDelta(native.position, native.parentBasis, [-5.5, 1, 1]);
  local.forEach((value, i) => expect(value).toBeCloseTo([1.25, 0, -0.25][i]!, 12));
});
