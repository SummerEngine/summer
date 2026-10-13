import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineApiClient } from "../api-client.js";
import { importResolvedAsset, type GatewayAsset } from "./asset-import.js";
import { EngineReceiptError } from "./engine-receipt.js";

const asset: GatewayAsset = {
  id: "asset-1", title: "Iron Sword", type: "3d_model",
  fileUrl: "https://cdn.example/iron_sword.glb",
};

function engine(importReceipt: unknown, sceneReceipt: unknown = { status: "ok", results: [{ ok: true }, { ok: true }] }) {
  const executeOps = vi.fn(async (_ops: Record<string, unknown>[]) => importReceipt);
  const executeIdentityBoundOps = vi.fn(async (_ops: Record<string, unknown>[]) => sceneReceipt);
  return { client: { executeOps, executeIdentityBoundOps } as unknown as EngineApiClient, executeOps, executeIdentityBoundOps };
}

afterEach(() => vi.unstubAllGlobals());

describe("importResolvedAsset completed receipts", () => {
  it.each([
    [{ terminalState: "identity_mismatch", requestId: "denied-1" }, "identity_mismatch"],
    [{ ok: false, requestId: "failed-1" }, "ok: false"],
    [{ status: "ok", requestId: "missing-1", results: [] }, "completed ImportFromUrl receipt"],
    [{ status: "ok", requestId: "malformed-1", results: {} }, "completed ImportFromUrl receipt"],
    [{ status: "pending", requestId: "pending-1", results: [{ ok: true }] }, "completed ImportFromUrl receipt"],
    [{ status: "ok", results: [{ ok: true, terminalState: "uncertain" }] }, "completed ImportFromUrl receipt"],
    [{ status: "ok", results: [{ ok: true, error: "asset was not ready" }] }, "completed ImportFromUrl receipt"],
    [{ status: "ok", requestId: "unimported-1", results: [{ ok: true, meta: { imported: false } }] }, "completed ImportFromUrl receipt"],
    [{ status: "ok", results: [{ ok: true, meta: { imported: true, applicationState: "rollback_failed" } }] }, "completed ImportFromUrl receipt"],
  ])("keeps a %j refusal or incomplete receipt and never places the model", async (receipt, message) => {
    const { client, executeIdentityBoundOps } = engine(receipt);
    const rejected = importResolvedAsset(client, { asset, parent: "./World", scenePath: "res://main.tscn" });
    await expect(rejected).rejects.toMatchObject({ name: "EngineReceiptError", receipt, message: expect.stringContaining(message) });
    expect(executeIdentityBoundOps).not.toHaveBeenCalled();
  });

  it("accepts an older positive op receipt and returns it with the placement receipt", async () => {
    const importReceipt = { status: "ok", results: [{ ok: true }] };
    const sceneReceipt = { status: "ok", results: [{ ok: true }, { ok: true }] };
    const { client, executeIdentityBoundOps } = engine(importReceipt, sceneReceipt);
    const result = await importResolvedAsset(client, { asset, parent: "./World", scenePath: "res://main.tscn" });
    expect(result).toMatchObject({ success: true, importedTo: "res://assets/models/iron_sword.glb", addedToScene: true, importReceipt, sceneReceipt });
    expect(executeIdentityBoundOps).toHaveBeenCalledTimes(1);
  });

  it("rejects a batch receipt whose second file was not imported", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
    const kenney: GatewayAsset = { ...asset, fileUrl: "https://cdn.example/kenney/3d/swords/iron_sword.glb" };
    const receipt = { status: "ok", results: [{ ok: true, op: "ImportFromUrlBatch", meta: { imported: [true, false] } }] };
    const { client, executeOps, executeIdentityBoundOps } = engine(receipt);
    await expect(importResolvedAsset(client, { asset: kenney, parent: "./World", scenePath: "res://main.tscn" }))
      .rejects.toBeInstanceOf(EngineReceiptError);
    expect(executeOps.mock.calls[0]?.[0]).toMatchObject([{ op: "ImportFromUrlBatch" }]);
    expect(executeIdentityBoundOps).not.toHaveBeenCalled();
  });

  it("accepts the current verified batch receipt with both files imported", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
    const kenney: GatewayAsset = { ...asset, fileUrl: "https://cdn.example/kenney/3d/swords/iron_sword.glb" };
    const receipt = {
      status: "ok", terminalState: "applied", requestId: "batch-ok-1",
      results: [{ ok: true, op: "ImportFromUrlBatch", meta: { imported: [true, true], applicationStates: ["applied", "applied"] } }],
    };
    const { client, executeIdentityBoundOps } = engine(receipt);
    const result = await importResolvedAsset(client, { asset: kenney, parent: "./World", scenePath: "res://main.tscn" });
    expect(result).toMatchObject({ success: true, addedToScene: true, importReceipt: receipt });
    expect(executeIdentityBoundOps).toHaveBeenCalledTimes(1);
  });

  it("retains an uncertain placement receipt instead of claiming a placed model", async () => {
    const sceneReceipt = { terminalState: "timed_out", requestId: "place-1", results: [{ ok: true }, { ok: true }] };
    const { client } = engine({ status: "ok", results: [{ ok: true }] }, sceneReceipt);
    await expect(importResolvedAsset(client, { asset, parent: "./World", scenePath: "res://main.tscn" }))
      .rejects.toMatchObject({ name: "EngineReceiptError", receipt: sceneReceipt });
  });
});
