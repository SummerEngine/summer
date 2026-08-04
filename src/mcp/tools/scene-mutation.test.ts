import { describe, expect, it, vi } from "vitest";

vi.mock("../server.js", () => ({
  getClient: vi.fn(),
  resetClient: vi.fn(),
}));

vi.mock("../../lib/telemetry.js", () => ({
  recordMcpSession: vi.fn(),
}));

import { executeSceneMutation } from "./scene-mutation.js";

describe("executeSceneMutation", () => {
  it("sends SaveScene as a separate single-op request", async () => {
    const executeIdentityBoundOps = vi.fn()
      .mockResolvedValueOnce({
        status: "ok",
        terminalState: "applied",
        appliedSeq: 10,
        results: [{ ok: true, op: "AddNode" }],
      })
      .mockResolvedValueOnce({
        status: "ok",
        terminalState: "applied",
        appliedSeq: 11,
        results: [{ ok: true, op: "SaveScene" }],
      });

    const result = await executeSceneMutation(
      { executeIdentityBoundOps } as never,
      "res://main.tscn",
      [{ op: "AddNode", parent: "./", type: "Node3D", name: "Marker" }],
      { groupUndo: true },
    ) as Record<string, unknown>;

    expect(executeIdentityBoundOps).toHaveBeenNthCalledWith(1, [
      { op: "AddNode", parent: "./", type: "Node3D", name: "Marker" },
    ], { groupUndo: true, scenePath: "res://main.tscn" });
    expect(executeIdentityBoundOps).toHaveBeenNthCalledWith(2, [
      { op: "SaveScene" },
    ], { groupUndo: true, scenePath: "res://main.tscn" });
    expect(result).toMatchObject({
      ok: true,
      status: "ok",
      terminalState: "applied",
      appliedSeq: 11,
      results: [
        { ok: true, op: "AddNode" },
        { ok: true, op: "SaveScene" },
      ],
    });
  });

  it("does not save when the mutation failed", async () => {
    const failure = {
      status: "error",
      terminalState: "identity_mismatch",
      results: [{ ok: false, op: "AddNode", error: "wrong project" }],
    };
    const executeIdentityBoundOps = vi.fn().mockResolvedValue(failure);

    const result = await executeSceneMutation(
      { executeIdentityBoundOps } as never,
      "res://main.tscn",
      [{ op: "AddNode" }],
    );

    expect(result).toBe(failure);
    expect(executeIdentityBoundOps).toHaveBeenCalledTimes(1);
  });

  it("reports that the editor may contain unsaved changes when save fails", async () => {
    const executeIdentityBoundOps = vi.fn()
      .mockResolvedValueOnce({
        status: "ok",
        terminalState: "applied",
        results: [{ ok: true, op: "SetProp" }],
      })
      .mockResolvedValueOnce({
        status: "error",
        terminalState: "failed",
        results: [{ ok: false, op: "SaveScene", error: "disk full" }],
      });

    const result = await executeSceneMutation(
      { executeIdentityBoundOps } as never,
      "res://main.tscn",
      [{ op: "SetProp" }],
    ) as Record<string, unknown>;

    expect(result).toMatchObject({
      ok: false,
      status: "error",
      terminalState: "failed",
    });
    expect(result.error).toContain("mutation applied");
    expect(result.error).toContain("unsaved changes");
  });

  it("preserves an explicit save-as path in the single-op request", async () => {
    const executeIdentityBoundOps = vi.fn().mockResolvedValue({
      status: "ok",
      terminalState: "applied",
      results: [{ ok: true, op: "SaveScene" }],
    });

    await executeSceneMutation(
      { executeIdentityBoundOps } as never,
      "res://main.tscn",
      [{ op: "SaveScene", path: "res://levels/copy.tscn" }],
    );

    expect(executeIdentityBoundOps).toHaveBeenCalledOnce();
    expect(executeIdentityBoundOps).toHaveBeenCalledWith(
      [{ op: "SaveScene", path: "res://levels/copy.tscn" }],
      { scenePath: "res://main.tscn" },
    );
  });
});
