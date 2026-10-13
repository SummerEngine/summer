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
    [{ status: "ok", pending: true, results: [{ ok: true }] }, "completed ImportFromUrl receipt"],
    [{ status: "ok", results: [{ op: "ImportFromUrl", ok: true, pending: true, meta: { status: "pending" } }] }, "completed ImportFromUrl receipt"],
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

  it("reports the Engine's corrected raster path, not the requested extension", async () => {
    const raster: GatewayAsset = { ...asset, type: "texture", fileUrl: "https://cdn.example/texture.png" };
    const receipt = { status: "ok", results: [{ op: "ImportFromUrl", ok: true, meta: { path: "res://assets/texture.jpg", imported: true } }] };
    const { client } = engine(receipt);
    const result = await importResolvedAsset(client, { asset: raster });
    expect(result.importedTo).toBe("res://assets/texture.jpg");
    expect(result.importReceipt).toBe(receipt);
  });

  it.each([
    { path: 42 },
    { path: undefined },
    { path: "res://assets/../outside.jpg" },
    { path: "res://assets/texture.jpg ", imported: true },
    { path: "res://assets/unrelated.jpg" },
  ])("refuses malformed supplied path metadata %j", async (meta) => {
    const raster: GatewayAsset = { ...asset, type: "texture", fileUrl: "https://cdn.example/texture.png" };
    const receipt = { status: "ok", results: [{ op: "ImportFromUrl", ok: true, meta }] };
    const { client } = engine(receipt);
    await expect(importResolvedAsset(client, { asset: raster })).rejects.toMatchObject({ name: "EngineReceiptError", receipt });
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

  it("does not place a model while the native batch import is still pending", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
    const kenney: GatewayAsset = { ...asset, fileUrl: "https://cdn.example/kenney/3d/swords/iron_sword.glb" };
    const receipt = { status: "ok", results: [{ op: "ImportFromUrlBatch", ok: true, pending: true, meta: { status: "pending" } }] };
    const { client, executeIdentityBoundOps } = engine(receipt);
    await expect(importResolvedAsset(client, { asset: kenney, parent: "./World", scenePath: "res://main.tscn" }))
      .rejects.toMatchObject({ name: "EngineReceiptError", receipt });
    expect(executeIdentityBoundOps).not.toHaveBeenCalled();
  });

  it("accepts the current verified batch receipt with both files imported", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
    const kenney: GatewayAsset = { ...asset, fileUrl: "https://cdn.example/kenney/3d/swords/iron_sword.glb" };
    const receipt = {
      status: "ok", terminalState: "applied", requestId: "batch-ok-1",
      results: [{ ok: true, op: "ImportFromUrlBatch", meta: { paths: ["res://assets/models/kenney/swords/Textures/colormap.jpg", "res://assets/models/kenney/swords/iron_sword.glb"], imported: [true, true], applicationStates: ["applied", "applied"] } }],
    };
    const { client, executeIdentityBoundOps } = engine(receipt);
    const result = await importResolvedAsset(client, { asset: kenney, parent: "./World", scenePath: "res://main.tscn" });
    expect(result).toMatchObject({ success: true, addedToScene: true, importedTo: "res://assets/models/kenney/swords/iron_sword.glb", importReceipt: receipt });
    expect(executeIdentityBoundOps).toHaveBeenCalledTimes(1);
  });

  it("refuses a batch receipt with missing ordered path metadata", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
    const kenney: GatewayAsset = { ...asset, fileUrl: "https://cdn.example/kenney/3d/swords/iron_sword.glb" };
    const receipt = { status: "ok", results: [{ ok: true, op: "ImportFromUrlBatch", meta: { paths: ["res://assets/models/kenney/swords/iron_sword.glb"] } }] };
    const { client, executeIdentityBoundOps } = engine(receipt);
    await expect(importResolvedAsset(client, { asset: kenney, parent: "./World", scenePath: "res://main.tscn" }))
      .rejects.toMatchObject({ name: "EngineReceiptError", receipt });
    expect(executeIdentityBoundOps).not.toHaveBeenCalled();
  });

  it("refuses a batch receipt whose paths do not match the submitted import order", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
    const kenney: GatewayAsset = { ...asset, fileUrl: "https://cdn.example/kenney/3d/swords/iron_sword.glb" };
    const receipt = { status: "ok", results: [{ ok: true, op: "ImportFromUrlBatch", meta: {
      paths: ["res://assets/models/kenney/swords/iron_sword.glb", "res://assets/models/kenney/swords/Textures/colormap.jpg"],
    } }] };
    const { client, executeIdentityBoundOps } = engine(receipt);
    await expect(importResolvedAsset(client, { asset: kenney, parent: "./World", scenePath: "res://main.tscn" }))
      .rejects.toMatchObject({ name: "EngineReceiptError", receipt });
    expect(executeIdentityBoundOps).not.toHaveBeenCalled();
  });

  it("retains an uncertain placement receipt instead of claiming a placed model", async () => {
    const importReceipt = { status: "ok", requestId: "import-1", results: [{ ok: true }] };
    const sceneReceipt = { terminalState: "timed_out", requestId: "place-1", results: [{ ok: true }, { ok: true }] };
    const { client } = engine(importReceipt, sceneReceipt);
    await expect(importResolvedAsset(client, { asset, parent: "./World", scenePath: "res://main.tscn" }))
      .rejects.toMatchObject({ name: "EngineReceiptError", receipt: { importReceipt, importedTo: "res://assets/models/iron_sword.glb", scenePath: "res://main.tscn", sceneReceipt } });
  });

  it("keeps the completed import receipt when placement acknowledgement is lost", async () => {
    const importReceipt = { status: "ok", requestId: "import-1", results: [{ ok: true }] };
    const { client, executeIdentityBoundOps } = engine(importReceipt);
    executeIdentityBoundOps.mockRejectedValueOnce(new Error("Request place-2 dispatch state is unknown. Do not retry blindly."));
    await expect(importResolvedAsset(client, { asset, parent: "./World", scenePath: "res://main.tscn" }))
      .rejects.toMatchObject({ name: "EngineReceiptError", message: expect.stringContaining("place-2"),
        receipt: { importReceipt, importedTo: "res://assets/models/iron_sword.glb", sceneError: expect.stringContaining("place-2") } });
  });

  it("does not claim placement when a positive-looking scene op is pending", async () => {
    const sceneReceipt = { status: "ok", results: [{ ok: true, pending: true, meta: { status: "pending" } }, { ok: true }] };
    const { client } = engine({ status: "ok", results: [{ ok: true }] }, sceneReceipt);
    await expect(importResolvedAsset(client, { asset, parent: "./World", scenePath: "res://main.tscn" }))
      .rejects.toMatchObject({ name: "EngineReceiptError", receipt: { sceneReceipt } });
  });

  it("does not claim placement from success flags on unrelated operations", async () => {
    const sceneReceipt = { status: "ok", results: [{ ok: true, op: "DeleteNode" }, { ok: true, op: "SaveScene" }] };
    const { client } = engine({ status: "ok", results: [{ ok: true }] }, sceneReceipt);
    await expect(importResolvedAsset(client, { asset, parent: "./World", scenePath: "res://main.tscn" }))
      .rejects.toMatchObject({ name: "EngineReceiptError", receipt: { sceneReceipt } });
  });
});
