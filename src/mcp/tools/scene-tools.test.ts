import { describe, expect, it, vi } from "vitest";

vi.mock("../server.js", () => ({
  getClient: vi.fn(),
  resetClient: vi.fn(),
}));

vi.mock("../../lib/telemetry.js", () => ({
  recordMcpSession: vi.fn(),
}));

import { getClient } from "../server.js";
import { registerSceneTools } from "./scene-tools.js";

type RegisteredTool = {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

function sceneTool(name: string): RegisteredTool {
  const registered: RegisteredTool[] = [];
  registerSceneTools({
    tool(
      toolName: string,
      _description: string,
      _schema: Record<string, unknown>,
      handler: (args: Record<string, unknown>) => Promise<unknown>,
    ) {
      registered.push({ name: toolName, handler });
      return { name: toolName };
    },
  } as never);
  const found = registered.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`${name} was not registered`);
  return found;
}

function batchTool(): RegisteredTool {
  return sceneTool("summer_batch");
}

const okReceipt = (ops: Array<Record<string, unknown>>) => ({
  status: "ok",
  terminalState: "applied",
  results: ops.map((op) => ({ ok: true, op: String(op.op ?? "") })),
});

describe("summer_create_scene guarded create-only write", () => {
  function mockCreateClient(overrides?: {
    executeIdentityBoundOps?: ReturnType<typeof vi.fn>;
    readProjectFile?: ReturnType<typeof vi.fn>;
  }) {
    const executeIdentityBoundOps =
      overrides?.executeIdentityBoundOps ??
      vi.fn(async (ops: Record<string, unknown>[]) => okReceipt(ops));
    const readProjectFile =
      overrides?.readProjectFile ??
      vi.fn(async (path: string) => ({
        ok: true,
        data: {
          content: `[gd_scene format=3]\n\n[node name="Main" type="Node3D"]\n`,
          sha256: "a".repeat(64),
        },
      }));
    const executeOps = vi.fn();
    const health = vi.fn();
    const getSceneState = vi.fn();
    vi.mocked(getClient).mockResolvedValue({
      getBoundProjectIdHash: () => "hash-a",
      executeIdentityBoundOps,
      executeOps,
      readProjectFile,
      health,
      getSceneState,
    } as never);
    return { executeIdentityBoundOps, readProjectFile, executeOps, health, getSceneState };
  }

  const createArgs = {
    path: "res://scenes/empty_level.tscn",
    rootName: "Main",
    rootType: "Node3D",
  };

  it("sends exactly one identity-bound create-only WriteFile with the minimal scene text", async () => {
    const { executeIdentityBoundOps, executeOps, health, getSceneState } = mockCreateClient();

    const result = (await sceneTool("summer_create_scene").handler(createArgs)) as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };

    expect(result.isError).toBeUndefined();
    expect(executeIdentityBoundOps).toHaveBeenCalledTimes(1);
    expect(executeIdentityBoundOps.mock.calls[0]?.[0]).toEqual([
      {
        op: "WriteFile",
        path: "res://scenes/empty_level.tscn",
        content: `[gd_scene format=3]\n\n[node name="Main" type="Node3D"]\n`,
        mustNotExist: true,
      },
    ]);
    // The open scene is never touched: no OpenScene/RemoveNode/SaveScene, no
    // template-scene resolution.
    expect(executeOps).not.toHaveBeenCalled();
    expect(health).not.toHaveBeenCalled();
    expect(getSceneState).not.toHaveBeenCalled();

    const body = JSON.parse(result.content?.[0]?.text ?? "{}");
    expect(body.ok).toBe(true);
    expect(body.created).toBe("res://scenes/empty_level.tscn");
    expect(body.verified).toBe(true);
  });

  it("honors a custom rootType", async () => {
    const { executeIdentityBoundOps } = mockCreateClient({
      readProjectFile: vi.fn(async () => ({
        ok: true,
        data: { content: `[gd_scene format=3]\n\n[node name="Hud" type="Control"]\n` },
      })),
    });

    await sceneTool("summer_create_scene").handler({
      path: "res://ui/hud.tscn",
      rootName: "Hud",
      rootType: "Control",
    });

    const ops = executeIdentityBoundOps.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
    expect(ops[0]?.content).toBe(`[gd_scene format=3]\n\n[node name="Hud" type="Control"]\n`);
  });

  it("accepts the deprecated allow_temporary_scene_mutation param as a no-op", async () => {
    const { executeIdentityBoundOps, executeOps } = mockCreateClient();

    for (const deprecatedValue of [true, false, undefined]) {
      executeIdentityBoundOps.mockClear();
      const result = (await sceneTool("summer_create_scene").handler({
        ...createArgs,
        allow_temporary_scene_mutation: deprecatedValue,
      })) as { isError?: boolean };
      expect(result.isError).toBeUndefined();
      expect(executeIdentityBoundOps).toHaveBeenCalledTimes(1);
    }
    expect(executeOps).not.toHaveBeenCalled();
  });

  it("surfaces the engine's create-only refusal when the path already exists", async () => {
    const { executeOps } = mockCreateClient({
      executeIdentityBoundOps: vi.fn(async () => ({
        status: "error",
        terminalState: "failed",
        results: [
          {
            ok: false,
            op: "WriteFile",
            error: "WriteFile new-file-only guard: target already exists. Use ReplaceText/strReplace for edits.",
          },
        ],
      })),
    });

    const result = (await sceneTool("summer_create_scene").handler(createArgs)) as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain("target already exists");
    expect(executeOps).not.toHaveBeenCalled();
  });

  it("reports a read-back verification failure honestly without failing the create", async () => {
    mockCreateClient({
      readProjectFile: vi.fn(async () => {
        throw new Error("read-file endpoint unavailable");
      }),
    });

    const result = (await sceneTool("summer_create_scene").handler(createArgs)) as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content?.[0]?.text ?? "{}");
    expect(body.ok).toBe(true);
    expect(body.verified).toBe(false);
    expect(body.verifyError).toContain("read-file endpoint unavailable");
  });

  it.each([
    ["not res://", { ...createArgs, path: "user://a.tscn" }, "res://"],
    ["traversal", { ...createArgs, path: "res://../a.tscn" }, "traversal-free"],
    ["not .tscn", { ...createArgs, path: "res://a.scn" }, ".tscn"],
    ["bad rootName", { ...createArgs, rootName: 'evil" type="Node' }, "Invalid rootName"],
    ["bad rootType", { ...createArgs, rootType: 'Node3D"]' }, "Invalid rootType"],
  ])("rejects invalid input (%s) before any engine write", async (_label, args, expected) => {
    const { executeIdentityBoundOps } = mockCreateClient();

    const result = (await sceneTool("summer_create_scene").handler(args)) as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain(expected);
    expect(executeIdentityBoundOps).not.toHaveBeenCalled();
  });
});

describe("summer_batch file mutation boundary", () => {
  it.each(["WriteFile", "ReplaceText"])(
    "rejects raw %s so guarded dedicated tools cannot be bypassed",
    async (op) => {
      const executeOps = vi.fn();
      vi.mocked(getClient).mockResolvedValue({
        getBoundProjectIdHash: () => "hash-a",
        executeOps,
      } as never);

      const result = (await batchTool().handler({
        ops: [{ op, path: "res://scripts/player.gd" }],
      })) as { content?: Array<{ text?: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("does not accept raw");
      expect(result.content?.[0]?.text).toContain("summer_write_file or summer_replace_text");
      expect(executeOps).not.toHaveBeenCalled();
    },
  );
});

// Engine 0.5.60+ (_summer_requires_single_async_dispatch) rejects any multi-op
// batch containing SaveScene/InstantiateScene/ReplaceNode/SimulateInput/... —
// wholesale, before anything executes. The MCP must never put the appended
// SaveScene in the same request as the mutations it saves.
describe("single-op dispatch contract (engine 0.5.60+)", () => {
  function mockClient() {
    const calls: Array<Record<string, unknown>[]> = [];
    const executeIdentityBoundOps = vi.fn(async (ops: Record<string, unknown>[]) => {
      calls.push(ops);
      return okReceipt(ops);
    });
    vi.mocked(getClient).mockResolvedValue({
      getBoundProjectIdHash: () => "hash-a",
      executeIdentityBoundOps,
      executeOps: vi.fn(async (ops: Record<string, unknown>[]) => okReceipt(ops)),
    } as never);
    return { calls, executeIdentityBoundOps };
  }

  it("summer_add_node sends the mutation and the appended SaveScene as two sequential requests", async () => {
    const { calls } = mockClient();
    const result = (await sceneTool("summer_add_node").handler({
      scenePath: "res://main.tscn",
      parent: "./World",
      type: "MeshInstance3D",
      name: "Floor",
    })) as { isError?: boolean; content?: Array<{ text?: string }> };

    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([{ op: "AddNode", parent: "./World", type: "MeshInstance3D", name: "Floor" }]);
    expect(calls[1]).toEqual([{ op: "SaveScene" }]);
    // No request may mix SaveScene with other ops.
    for (const ops of calls) {
      if (ops.some((op) => op.op === "SaveScene")) expect(ops).toHaveLength(1);
    }
  });

  it("summer_batch keeps batchable mutations grouped and splits only around single-only ops", async () => {
    const { calls } = mockClient();
    await batchTool().handler({
      scenePath: "res://main.tscn",
      ops: [
        { op: "AddNode", parent: "/", type: "Node3D", name: "A" },
        { op: "SetProp", path: "A", key: "visible", value: true },
        { op: "InstantiateScene", parent: "/", scene: "res://b.tscn" },
        { op: "SetProp", path: "B", key: "visible", value: false },
      ],
    });

    expect(calls).toEqual([
      [
        { op: "AddNode", parent: "/", type: "Node3D", name: "A" },
        { op: "SetProp", path: "A", key: "visible", value: true },
      ],
      [{ op: "InstantiateScene", parent: "/", scene: "res://b.tscn" }],
      [{ op: "SetProp", path: "B", key: "visible", value: false }],
      [{ op: "SaveScene" }],
    ]);
  });

  it("merges all receipts on success so every op result stays visible", async () => {
    mockClient();
    const result = (await sceneTool("summer_set_prop").handler({
      scenePath: "res://main.tscn",
      path: "./Floor",
      key: "visible",
      value: true,
    })) as { content?: Array<{ text?: string }> };

    const body = JSON.parse(result.content?.[0]?.text ?? "{}");
    expect(body.requests).toBe(2);
    expect(body.results.map((entry: { op: string }) => entry.op)).toEqual(["SetProp", "SaveScene"]);
  });

  it("reports an applied mutation followed by a failed save honestly", async () => {
    const executeIdentityBoundOps = vi.fn(async (ops: Record<string, unknown>[]) => {
      if (ops.some((op) => op.op === "SaveScene")) {
        return {
          status: "error",
          terminalState: "failed",
          error: "disk full",
          results: [{ ok: false, op: "SaveScene", failure_reason: "io_error" }],
        };
      }
      return okReceipt(ops);
    });
    vi.mocked(getClient).mockResolvedValue({
      getBoundProjectIdHash: () => "hash-a",
      executeIdentityBoundOps,
      executeOps: vi.fn(),
    } as never);

    const result = (await sceneTool("summer_add_node").handler({
      scenePath: "res://main.tscn",
      parent: "./World",
      type: "MeshInstance3D",
      name: "Floor",
    })) as { isError?: boolean; content?: Array<{ text?: string }> };

    expect(result.isError).toBe(true);
    const text = result.content?.[0]?.text ?? "";
    expect(text).toContain("disk full");
    expect(text).toContain("already applied");
    expect(text).toContain("NOT saved");
    expect(text).toContain("io_error");
  });

  it("sends a lone SimulateInput through summer_batch as a single op with no SaveScene appended", async () => {
    const executeOps = vi.fn(async (ops: Record<string, unknown>[]) => okReceipt(ops));
    vi.mocked(getClient).mockResolvedValue({
      getBoundProjectIdHash: () => "hash-a",
      executeIdentityBoundOps: vi.fn(),
      executeOps,
    } as never);

    await batchTool().handler({
      ops: [{ op: "SimulateInput", type: "action", action: "jump", pressed: true }],
    });

    expect(executeOps).toHaveBeenCalledTimes(1);
    expect(executeOps.mock.calls[0]?.[0]).toEqual([
      { op: "SimulateInput", type: "action", action: "jump", pressed: true },
    ]);
  });
});
