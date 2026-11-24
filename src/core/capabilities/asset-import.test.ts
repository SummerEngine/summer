import { describe, expect, it, vi } from "vitest";
import { FALLBACK_SINGLE_ONLY_OPS } from "../capability-skew.js";
import type { EngineApiClient } from "../api-client.js";
import { importResolvedAsset } from "./asset-import.js";

function createSingleOnlyRejectingClient() {
  const identityCalls: Array<{ ops: Record<string, unknown>[]; options?: Record<string, unknown> }> = [];
  const opsCalls: Array<{ ops: Record<string, unknown>[]; options?: Record<string, unknown> }> = [];

  const client = {
    async executeOps(ops: Record<string, unknown>[], options?: Record<string, unknown>) {
      opsCalls.push({ ops, options });
      return {
        status: "ok",
        results: ops.map((op) => ({ ok: true, op: op.op })),
      };
    },
    async executeIdentityBoundOps(ops: Record<string, unknown>[], options?: Record<string, unknown>) {
      identityCalls.push({ ops, options });
      // Mirror Summer Engine 0.5.60+: reject any multi-op batch containing a single-only op.
      if (ops.length > 1 && ops.some((op) => FALLBACK_SINGLE_ONLY_OPS.has(String(op.op ?? "")))) {
        return {
          status: "error",
          terminalState: "failed",
          failure_reason: "unsupported_transport",
          results: ops.map((op) => ({
            ok: false,
            op: op.op,
            skipped: true,
            error: `${String(op.op)} must be sent as a single op.`,
          })),
        };
      }
      return {
        status: "ok",
        terminalState: "applied",
        results: ops.map((op) => ({ ok: true, op: op.op })),
      };
    },
  } as unknown as EngineApiClient;

  return { client, identityCalls, opsCalls };
}

describe("importResolvedAsset single-op scene mutation contract", () => {
  it("dispatches InstantiateScene and SaveScene as separate identity-bound requests when placing a 3D model", async () => {
    const { client, identityCalls, opsCalls } = createSingleOnlyRejectingClient();

    const result = await importResolvedAsset(client, {
      asset: {
        id: "asset-1",
        title: "Iron Sword",
        type: "3d_model",
        fileUrl: "https://cdn.example/iron_sword.glb",
      },
      parent: "./World/Props",
      scenePath: "res://main.tscn",
      name: "HeroSword",
    });

    expect(opsCalls).toHaveLength(1);
    expect(identityCalls.map((call) => call.ops)).toEqual([
      [
        {
          op: "InstantiateScene",
          parent: "./World/Props",
          scene: "res://assets/models/iron_sword.glb",
          name: "HeroSword",
        },
      ],
      [{ op: "SaveScene" }],
    ]);
    for (const call of identityCalls) {
      expect(call.options).toMatchObject({ scenePath: "res://main.tscn" });
    }
    expect(result).toMatchObject({
      success: true,
      assetId: "asset-1",
      importedTo: "res://assets/models/iron_sword.glb",
      addedToScene: true,
    });
  });

  it("propagates a placement refusal if InstantiateScene fails before SaveScene", async () => {
    const identityCalls: Record<string, unknown>[][] = [];
    const client = {
      executeOps: vi.fn(async (ops: Record<string, unknown>[]) => ({
        status: "ok",
        results: ops.map((op) => ({ ok: true, op: op.op })),
      })),
      executeIdentityBoundOps: vi.fn(async (ops: Record<string, unknown>[]) => {
        identityCalls.push(ops);
        if (ops[0]?.op === "InstantiateScene") {
          return {
            status: "error",
            terminalState: "failed",
            results: [{ ok: false, op: "InstantiateScene", error: "parent not found: ./Missing" }],
          };
        }
        return {
          status: "ok",
          terminalState: "applied",
          results: ops.map((op) => ({ ok: true, op: op.op })),
        };
      }),
    } as unknown as EngineApiClient;

    await expect(
      importResolvedAsset(client, {
        asset: {
          id: "asset-2",
          title: "Torch",
          type: "3d_model",
          fileUrl: "https://cdn.example/torch.glb",
        },
        parent: "./Missing",
        scenePath: "res://main.tscn",
      }),
    ).rejects.toThrow("parent not found: ./Missing");

    expect(identityCalls.map((ops) => ops.map((op) => op.op))).toEqual([["InstantiateScene"]]);
  });
});
