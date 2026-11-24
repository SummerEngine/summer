import { describe, expect, it, vi } from "vitest";
import { createScene } from "./create-scene.js";

function client(info: Record<string, unknown> = {}) {
  let content = '[gd_scene format=3]\n[node name="Main" type="MeshInstance3D"]\n';
  const executeIdentityBoundOps = vi.fn(async (ops: Record<string, unknown>[]) => {
    const write = ops.find((op) => op.op === "WriteFile");
    if (typeof write?.content === "string") content = write.content;
    return {
      status: "ok",
      results: ops.map((op) => op.op === "GetClassInfo"
        ? { ok: true, op: op.op, native_class: true, ...info }
        : { ok: true, op: op.op }),
    };
  });
  const readProjectFile = vi.fn(async () => ({ ok: true, data: {
    content,
  } }));
  return { executeIdentityBoundOps, readProjectFile };
}

const args = { path: "res://new_scene.tscn", rootType: "MeshInstance3D" };

describe("createScene root validation", () => {
  it.each(["Node", "Node2D", "Node3D", "Control"])("keeps the core %s root on the write-only fast path", async (rootType) => {
    const c = client();
    expect(await createScene(c, { ...args, rootType })).toMatchObject({ ok: true, verified: true });
    expect(c.executeIdentityBoundOps).toHaveBeenCalledTimes(1);
    expect(c.executeIdentityBoundOps.mock.calls[0][0][0]).toMatchObject({ op: "WriteFile", mustNotExist: true });
  });

  it("checks core roots on a new editor so restricted builds cannot falsely verify them", async () => {
    const c = { ...client({ class_name: "Node3D", exists: false, native_class: false, is_node: false, can_instantiate: false }),
      getEngineCapabilities: () => ({ opKinds: ["GetClassInfo", "WriteFile"] }) };
    expect(await createScene(c, { ...args, rootType: "Node3D" })).toMatchObject({ ok: false, failure_reason: "invalid_root_type" });
    expect(c.executeIdentityBoundOps).toHaveBeenCalledExactlyOnceWith([{ op: "GetClassInfo", class_name: "Node3D" }]);
  });

  it("checks an arbitrary native Node before the create-only write", async () => {
    const c = client({ class_name: "MeshInstance3D", exists: true, is_node: true, can_instantiate: true });
    const result = await createScene(c, args);
    expect(c.executeIdentityBoundOps.mock.calls.map(([ops]) => ops[0].op)).toEqual(["GetClassInfo", "WriteFile"]);
    expect(c.executeIdentityBoundOps.mock.calls[0][0][0]).toMatchObject({ op: "GetClassInfo", class_name: "MeshInstance3D" });
    expect(result).toMatchObject({ ok: true, rootType: "MeshInstance3D", verified: true });
  });

  it.each([
    ["MeshInstanc3D", false, false, false],
    ["BoxMesh", true, false, true],
    ["CanvasItem", true, true, false],
  ])("refuses unsupported root %s before any destination write", async (type, exists, node, instantiable) => {
    const c = client({ class_name: type, exists, is_node: node, can_instantiate: instantiable });
    const result = await createScene(c, { ...args, rootType: type });
    expect(result).toMatchObject({ ok: false, failure_reason: "invalid_root_type" });
    expect(c.executeIdentityBoundOps.mock.calls.flatMap(([ops]) => ops).map((op) => op.op)).toEqual(["GetClassInfo"]);
    expect(c.readProjectFile).not.toHaveBeenCalled();
  });

  it("explains the native-base plus script convention for a project class_name", async () => {
    const c = client({ class_name: "Enemy", kind: "script", native_class: false, exists: true, is_node: true, can_instantiate: false,
      script_path: "res://enemy.gd", native_base: "Node3D" });
    const result = await createScene(c, { ...args, rootType: "Enemy" });
    expect(result).toMatchObject({ ok: false, failure_reason: "invalid_root_type" });
    expect(result.error).toContain("native base");
    expect(result.error).toContain("res://enemy.gd");
    expect(c.executeIdentityBoundOps).toHaveBeenCalledTimes(1);
  });

  it("does not treat the core fast path as an exhaustive class list", async () => {
    const c = client({ class_name: "ExtensionNode", exists: true, is_node: true, can_instantiate: true });
    expect((await createScene(c, { ...args, rootType: "ExtensionNode" })).ok).toBe(true);
    expect(c.executeIdentityBoundOps.mock.calls[1][0][0]).toMatchObject({ op: "WriteFile" });
  });

  it("reports older-engine verification limits without misclassifying an extension root", async () => {
    const c = { ...client(), getEngineCapabilities: () => ({ opKinds: ["WriteFile"] }) };
    const result = await createScene(c, { ...args, rootType: "ExtensionNode" });
    expect(result).toMatchObject({ ok: false, failure_reason: "class_verification_unavailable" });
    expect(c.executeIdentityBoundOps).not.toHaveBeenCalled();
    expect(c.readProjectFile).not.toHaveBeenCalled();
  });

  it("preserves a class-query failure without writing a destination", async () => {
    const c = client();
    c.executeIdentityBoundOps.mockResolvedValueOnce({ status: "error", results: [{
      ok: false, op: "GetClassInfo", error: "query unavailable", failure_reason: "engine_lacks_op",
    }] } as never);
    expect(await createScene(c, args)).toMatchObject({ status: "error" });
    expect(c.executeIdentityBoundOps).toHaveBeenCalledTimes(1);
    expect(c.readProjectFile).not.toHaveBeenCalled();
  });

  it("refuses a missing validation result without writing a file", async () => {
    const c = client();
    expect(await createScene(c, args)).toMatchObject({ ok: false, failure_reason: "class_verification_unavailable" });
    expect(c.executeIdentityBoundOps).toHaveBeenCalledTimes(1);
  });

  it("preserves an existing destination refusal without deleting anything", async () => {
    const c = client();
    c.executeIdentityBoundOps.mockResolvedValueOnce({ status: "error", results: [{
      ok: false, op: "WriteFile", error: "target already exists",
    }] } as never);
    const result = await createScene(c, { ...args, rootType: "Node3D" });
    expect(result).toMatchObject({ status: "error" });
    expect(c.executeIdentityBoundOps).toHaveBeenCalledTimes(1);
    expect(c.readProjectFile).not.toHaveBeenCalled();
  });

  it("does not verify a read-back with the correct name and wrong root type", async () => {
    const c = client();
    c.readProjectFile.mockResolvedValueOnce({ ok: true, data: {
      content: '[gd_scene format=3]\n[node name="Main" type="Node"]\n',
    } });
    const result = await createScene(c, { ...args, rootType: "Node3D" });
    expect(result).toMatchObject({ ok: true, verified: false });
    expect(result.verifyError).toContain("name and type");
    expect(c.executeIdentityBoundOps).toHaveBeenCalledTimes(1);
  });
});
