import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../server.js", () => ({
  getClient: vi.fn(),
  resetClient: vi.fn(),
}));

vi.mock("../../core/telemetry.js", () => ({
  recordMcpSession: vi.fn(),
}));

import { getClient } from "../server.js";
import { registerPerceptionTools } from "./perception-tools.js";

type RegisteredTool = {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

function tools(): RegisteredTool[] {
  const registered: RegisteredTool[] = [];
  registerPerceptionTools({
    tool(
      name: string,
      _description: string,
      _schema: Record<string, unknown>,
      handler: (args: Record<string, unknown>) => Promise<unknown>
    ) {
      registered.push({ name, handler });
      return { name };
    },
  } as never);
  return registered;
}

function tool(registered: RegisteredTool[], name: string): RegisteredTool {
  const found = registered.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

function text(result: unknown): string {
  const envelope = result as { content?: Array<{ text?: string }> };
  return envelope.content?.[0]?.text ?? "";
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("registration", () => {
  it("registers the four perception tools (no second feedback tool — summer_library_feedback owns outcomes)", () => {
    expect(tools().map((t) => t.name)).toEqual([
      "summer_world_snapshot",
      "summer_snapshot_diff",
      "summer_get_runtime_tree",
      "summer_inspect_runtime_node",
    ]);
  });
});

describe("summer_world_snapshot", () => {
  it("submits a single GetWorldSnapshot op with only the provided params", async () => {
    const executeOps = vi.fn().mockResolvedValue({
      ok: true,
      results: [{ ok: true, op: "GetWorldSnapshot", snapshot_id: "snap-1" }],
    });
    vi.mocked(getClient).mockResolvedValue({ executeOps } as never);

    const handler = tool(tools(), "summer_world_snapshot");
    const result = (await handler.handler({ max_nodes: 500 })) as { isError?: boolean };

    expect(result.isError).toBeUndefined();
    expect(executeOps).toHaveBeenCalledWith([{ op: "GetWorldSnapshot", max_nodes: 500 }]);
  });

  it("maps an unknown-op failure (no capability advert) to the engine-too-old hint", async () => {
    const executeOps = vi.fn().mockResolvedValue({
      ok: false,
      results: [{ ok: false, op: "GetWorldSnapshot", error: "unknown op: GetWorldSnapshot" }],
    });
    vi.mocked(getClient).mockResolvedValue({ executeOps } as never);

    const handler = tool(tools(), "summer_world_snapshot");
    const result = (await handler.handler({})) as { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("doesn't support GetWorldSnapshot yet");
    expect(text(result)).toContain("summer_get_scene_tree");
    // Same marker as the pre-flight, so the model keys off one field either way.
    expect(text(result)).toContain("engine_lacks_op");
  });

  it("refuses before sending when the engine advertises ops without GetWorldSnapshot", async () => {
    const executeOps = vi.fn();
    vi.mocked(getClient).mockResolvedValue({
      executeOps,
      getEngineCapabilities: () => ({ opKinds: ["AddNode", "SetProp"] }),
      getEngineVersion: () => "0.5.61",
    } as never);

    const result = (await tool(tools(), "summer_world_snapshot").handler({})) as {
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(executeOps).not.toHaveBeenCalled();
    expect(text(result)).toContain("engine_lacks_op");
    expect(text(result)).toContain("GetWorldSnapshot");
    expect(text(result)).toContain("engine version 0.5.61");
    expect(text(result)).toContain("summer_get_scene_tree");
  });

  it("sends when the advertised op list includes GetWorldSnapshot", async () => {
    const executeOps = vi.fn().mockResolvedValue({
      ok: true,
      results: [{ ok: true, op: "GetWorldSnapshot", snapshot_id: "snap-2" }],
    });
    vi.mocked(getClient).mockResolvedValue({
      executeOps,
      getEngineCapabilities: () => ({ opKinds: ["GetWorldSnapshot", "DiffWorldSnapshot"] }),
    } as never);

    const result = (await tool(tools(), "summer_world_snapshot").handler({})) as {
      isError?: boolean;
    };
    expect(result.isError).toBeUndefined();
    expect(executeOps).toHaveBeenCalledTimes(1);
  });
});

describe("summer_snapshot_diff", () => {
  it("maps unknown-op and unknown_snapshot failures to prescriptive text", async () => {
    const executeOps = vi.fn().mockResolvedValue({
      ok: false,
      results: [{ ok: false, op: "DiffWorldSnapshot", error: "unknown op: DiffWorldSnapshot" }],
    });
    vi.mocked(getClient).mockResolvedValue({ executeOps } as never);

    const registered = tools();
    const handler = tool(registered, "summer_snapshot_diff");
    const oldEngine = (await handler.handler({ from_id: "snap-1" })) as { isError?: boolean };
    expect(oldEngine.isError).toBe(true);
    expect(text(oldEngine)).toContain("doesn't support DiffWorldSnapshot yet");
    expect(executeOps).toHaveBeenCalledWith([{ op: "DiffWorldSnapshot", from_id: "snap-1" }]);

    executeOps.mockResolvedValue({
      ok: false,
      results: [
        {
          ok: false,
          op: "DiffWorldSnapshot",
          error: "unknown snapshot id",
          failure_reason: "unknown_snapshot",
        },
      ],
    });
    const expired = (await handler.handler({ from_id: "snap-gone" })) as { isError?: boolean };
    expect(expired.isError).toBe(true);
    expect(text(expired)).toContain("fresh summer_world_snapshot baseline");
  });
});

describe("runtime reads", () => {
  it("teaches summer_play on game_not_running", async () => {
    const executeOps = vi.fn().mockResolvedValue({
      ok: false,
      results: [
        {
          ok: false,
          op: "GetRuntimeSceneTree",
          error: "no running game",
          failure_reason: "game_not_running",
        },
      ],
    });
    vi.mocked(getClient).mockResolvedValue({ executeOps } as never);

    const registered = tools();
    const treeResult = (await tool(registered, "summer_get_runtime_tree").handler({
      depth: 5,
    })) as { isError?: boolean };
    expect(treeResult.isError).toBe(true);
    expect(text(treeResult)).toContain("summer_play");
    expect(text(treeResult)).toContain("summer_get_scene_tree");
    expect(executeOps).toHaveBeenCalledWith([{ op: "GetRuntimeSceneTree", depth: 5 }]);

    executeOps.mockResolvedValue({
      ok: false,
      results: [
        {
          ok: false,
          op: "GetRuntimeNode",
          error: "no running game",
          failure_reason: "game_not_running",
        },
      ],
    });
    const nodeResult = (await tool(registered, "summer_inspect_runtime_node").handler({
      path: "/root/Main/Player",
    })) as { isError?: boolean };
    expect(nodeResult.isError).toBe(true);
    expect(text(nodeResult)).toContain("summer_play");
  });

  it("passes a successful runtime tree through untouched", async () => {
    const payload = {
      ok: true,
      results: [
        { ok: true, op: "GetRuntimeSceneTree", tree: { name: "root" }, total_nodes: 3, truncated: false },
      ],
    };
    const executeOps = vi.fn().mockResolvedValue(payload);
    vi.mocked(getClient).mockResolvedValue({ executeOps } as never);

    const result = (await tool(tools(), "summer_get_runtime_tree").handler({})) as {
      isError?: boolean;
    };
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain("total_nodes");
  });

  it("refuses runtime node reads before sending on an engine that provably lacks GetRuntimeNode", async () => {
    const executeOps = vi.fn();
    vi.mocked(getClient).mockResolvedValue({
      executeOps,
      getEngineCapabilities: () => ({ opKinds: ["GetRuntimeSceneTree"] }),
    } as never);

    const result = (await tool(tools(), "summer_inspect_runtime_node").handler({
      path: "/root/Main/Player",
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(executeOps).not.toHaveBeenCalled();
    expect(text(result)).toContain("engine_lacks_op");
    expect(text(result)).toContain("RunVerification");
  });
});
