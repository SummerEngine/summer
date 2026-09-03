import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../server.js", () => ({
  getClient: vi.fn(),
  resetClient: vi.fn(),
}));

vi.mock("../../core/telemetry.js", () => ({
  recordMcpSession: vi.fn(),
}));

import { getClient } from "../server.js";
import { registerFabricateTools } from "./fabricate-tools.js";

type RegisteredTool = {
  name: string;
  description: string;
  shape: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

function registered(): RegisteredTool {
  const tools: RegisteredTool[] = [];
  registerFabricateTools({
    tool(
      name: string,
      description: string,
      shape: Record<string, unknown>,
      handler: (args: Record<string, unknown>) => Promise<unknown>
    ) {
      tools.push({ name, description, shape, handler });
      return { name };
    },
  } as never);
  const found = tools.find((tool) => tool.name === "summer_fabricate_3d");
  if (!found) throw new Error("summer_fabricate_3d not registered");
  return found;
}

function text(result: unknown): string {
  const envelope = result as { content?: Array<{ text?: string }> };
  return envelope.content?.[0]?.text ?? "";
}

const SCRIPT = "import bmesh\nbpy.ops.mesh.primitive_cube_add(size=2)\n";

afterEach(() => {
  vi.clearAllMocks();
});

describe("summer_fabricate_3d", () => {
  it("registers exactly the op's parameter surface", () => {
    expect(Object.keys(registered().shape).sort()).toEqual(
      ["blender_path", "checkpoint", "import_to_scene", "max_seconds", "name", "out_path", "source", "target_size"].sort()
    );
  });

  it("teaches routing, the Blender prerequisite, the script contract and the verify loop", () => {
    const description = registered().description;
    for (const phrase of [
      "summer_search_assets",
      "summer_generate_3d",
      "SUMMER_BLENDER_BIN",
      "blender_not_found",
      "never bundles",
      "do NOT export",
      "Principled BSDF",
      "summer_snapshot_diff",
      "summer_screenshot",
      "engine_lacks_op",
      "busy",
    ]) {
      expect(description, phrase).toContain(phrase);
    }
  });

  it("submits a single identity-bound FabricateMesh op with the clamped budget and a longer client timeout", async () => {
    const executeIdentityBoundOps = vi.fn().mockResolvedValue({
      ok: true,
      results: [{ ok: true, op: "FabricateMesh", ran: true, out_path: "res://assets/fabricated/crate.glb" }],
    });
    vi.mocked(getClient).mockResolvedValue({ executeIdentityBoundOps } as never);

    const result = (await registered().handler({
      source: SCRIPT,
      name: "crate",
      max_seconds: 9_000,
      import_to_scene: { parent: "./Props", position: "Vector3(1, 0, 2)" },
      target_size: 1.2,
    })) as { isError?: boolean };

    expect(result.isError).toBeUndefined();
    const [ops, options, timeoutMs] = executeIdentityBoundOps.mock.calls[0]!;
    expect(options).toBeUndefined();
    expect(ops).toEqual([
      {
        op: "FabricateMesh",
        script_source: SCRIPT,
        name: "crate",
        max_seconds: 600, // clamped from 9000
        import_to_scene: { parent: "./Props", position: "Vector3(1, 0, 2)" },
        target_size: 1.2,
      },
    ]);
    expect(timeoutMs).toBe(600_000 + 60_000);
    expect(text(result)).toContain("res://assets/fabricated/crate.glb");
  });

  it("refuses BEFORE sending when the engine advertises an op list without FabricateMesh", async () => {
    const executeIdentityBoundOps = vi.fn();
    vi.mocked(getClient).mockResolvedValue({
      executeIdentityBoundOps,
      getEngineCapabilities: () => ({ opKinds: ["AddNode", "RunEditorScript", "RunSceneScript"] }),
      getEngineVersion: () => "0.5.65",
    } as never);

    const result = (await registered().handler({ source: SCRIPT, name: "crate" })) as { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(executeIdentityBoundOps).not.toHaveBeenCalled();
    const body = text(result);
    expect(body).toContain("engine_lacks_op");
    expect(body).toContain("FabricateMesh");
    expect(body).toContain("0.5.65");
    expect(body).toContain("nothing was sent");
    expect(body).toContain("summer_generate_3d");
    expect(body).toContain("summer_search_assets");
  });

  it("maps an old engine's unknown-op answer (no capability advert) to the engine-too-old hint", async () => {
    const executeIdentityBoundOps = vi.fn().mockResolvedValue({
      ok: false,
      results: [{ ok: false, op: "FabricateMesh", error: "unknown op: FabricateMesh" }],
    });
    vi.mocked(getClient).mockResolvedValue({ executeIdentityBoundOps } as never);

    const result = (await registered().handler({ source: SCRIPT, name: "crate" })) as { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(executeIdentityBoundOps).toHaveBeenCalledTimes(1);
    const body = text(result);
    expect(body).toContain("doesn't support FabricateMesh yet");
    expect(body).toContain("engine_lacks_op");
    expect(body).toContain("summer_generate_3d");
    expect(body).toContain("unknown op: FabricateMesh");
  });

  it("sends normally when the advertised op list includes FabricateMesh", async () => {
    const executeIdentityBoundOps = vi.fn().mockResolvedValue({
      ok: true,
      results: [{ ok: true, op: "FabricateMesh", ran: true }],
    });
    vi.mocked(getClient).mockResolvedValue({
      executeIdentityBoundOps,
      getEngineCapabilities: () => ({ opKinds: ["FabricateMesh"] }),
      getEngineVersion: () => "0.6.0",
    } as never);

    const result = (await registered().handler({ source: SCRIPT, name: "crate" })) as { isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(executeIdentityBoundOps).toHaveBeenCalledTimes(1);
  });

  it("surfaces the engine's own failure taxonomy (blender_not_found) as a classified failure, not a transport error", async () => {
    const executeIdentityBoundOps = vi.fn().mockResolvedValue({
      ok: false,
      results: [
        {
          ok: false,
          op: "FabricateMesh",
          failure_reason: "blender_not_found",
          error: "No Blender executable was found on this machine (checked: /usr/bin/blender). Fix one of: ...",
        },
      ],
    });
    vi.mocked(getClient).mockResolvedValue({ executeIdentityBoundOps } as never);

    const result = (await registered().handler({ source: SCRIPT, name: "crate" })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    const body = text(result);
    expect(body).toContain("blender_not_found");
    expect(body).toContain("No Blender executable was found");
    expect(body).not.toContain("may have partially applied");
  });

  it("classifies a bad destination as invalid_input with sent:false — nothing reaches the engine", async () => {
    const executeIdentityBoundOps = vi.fn();
    vi.mocked(getClient).mockResolvedValue({ executeIdentityBoundOps } as never);

    const result = (await registered().handler({
      source: SCRIPT,
      name: "crate",
      out_path: "res://../escape.glb",
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(executeIdentityBoundOps).not.toHaveBeenCalled();
    const body = text(result);
    expect(body).toContain("invalid_input");
    expect(body).toContain('"sent": false');
    expect(body).toContain("may not contain '..'");
  });
});
