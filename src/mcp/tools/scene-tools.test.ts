import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

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
  schema: Record<string, z.ZodTypeAny>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

function sceneTool(toolName: string): RegisteredTool {
  const registered: RegisteredTool[] = [];
  registerSceneTools({
    tool(
      name: string,
      _description: string,
      schema: Record<string, z.ZodTypeAny>,
      handler: (args: Record<string, unknown>) => Promise<unknown>,
    ) {
      registered.push({ name, schema, handler });
      return { name };
    },
  } as never);
  const found = registered.find((candidate) => candidate.name === toolName);
  if (!found) throw new Error(`${toolName} was not registered`);
  return found;
}

function batchTool(): RegisteredTool {
  return sceneTool("summer_batch");
}

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

describe("summer_batch weak-model compatibility", () => {
  it("infers AddNode and SetProp for unambiguous individual-tool-shaped ops", async () => {
    const executeIdentityBoundOps = vi.fn().mockResolvedValue({
      ok: true,
      status: "ok",
      terminalState: "applied",
      results: [{ ok: true }, { ok: true }],
    });
    vi.mocked(getClient).mockResolvedValue({
      getBoundProjectIdHash: () => "hash-a",
      executeIdentityBoundOps,
    } as never);

    const tool = sceneTool("summer_batch");
    const args = z.object(tool.schema).parse({
      scenePath: "res://main.tscn",
      ops: [
        {
          scenePath: "res://main.tscn",
          parent: "./",
          type: "MeshInstance3D",
          name: "Cube",
        },
        {
          scenePath: "res://main.tscn",
          path: "./Cube",
          key: "mesh",
          value: "BoxMesh",
        },
      ],
    });

    await tool.handler(args);

    expect(executeIdentityBoundOps).toHaveBeenNthCalledWith(
      1,
      [
        { op: "AddNode", parent: "./", type: "MeshInstance3D", name: "Cube" },
        { op: "SetProp", path: "./Cube", key: "mesh", value: "BoxMesh" },
      ],
      { groupUndo: true, scenePath: "res://main.tscn" },
    );
    expect(executeIdentityBoundOps).toHaveBeenNthCalledWith(
      2,
      [{ op: "SaveScene" }],
      { groupUndo: true, scenePath: "res://main.tscn" },
    );
  });
});

describe("summer_remove_node weak-model compatibility", () => {
  it("accepts add-node-shaped name and parent aliases and resolves one exact path", async () => {
    const executeIdentityBoundOps = vi.fn().mockResolvedValue({
      ok: true,
      status: "ok",
      terminalState: "applied",
      results: [{ ok: true }],
    });
    vi.mocked(getClient).mockResolvedValue({
      getBoundProjectIdHash: () => "hash-a",
      executeIdentityBoundOps,
    } as never);

    const tool = sceneTool("summer_remove_node");
    const args = z.object(tool.schema).parse({
      scenePath: "res://main.tscn",
      parent: "./",
      name: "Marker",
      type: "Node3D",
    });

    await tool.handler(args);

    expect(executeIdentityBoundOps).toHaveBeenNthCalledWith(
      1,
      [{ op: "RemoveNode", path: "./Marker" }],
      { scenePath: "res://main.tscn" },
    );
  });
});
