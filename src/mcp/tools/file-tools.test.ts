import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../server.js", () => ({
  getClient: vi.fn(),
  resetClient: vi.fn(),
}));

vi.mock("../../lib/telemetry.js", () => ({
  recordMcpSession: vi.fn(),
}));

import { getClient } from "../server.js";
import { registerFileTools } from "./file-tools.js";

type RegisteredTool = {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

function tools(): RegisteredTool[] {
  const registered: RegisteredTool[] = [];
  registerFileTools({
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
  vi.restoreAllMocks();
});

describe("identity-bound MCP file tools", () => {
  it("registers read, guarded write, and guarded replace tools", () => {
    expect(tools().map((candidate) => candidate.name)).toEqual([
      "summer_read_file",
      "summer_write_file",
      "summer_replace_text",
    ]);
  });

  it("refuses an unguarded full-file write before submission", async () => {
    const executeIdentityBoundOps = vi.fn();
    vi.mocked(getClient).mockResolvedValue({
      getBoundProjectIdHash: () => "hash-a",
      executeIdentityBoundOps,
    } as never);

    const result = await tool(tools(), "summer_write_file").handler({
      path: "res://main.tscn",
      content: "[gd_scene format=3]",
    });

    expect(text(result)).toContain("exactly one guard");
    expect(executeIdentityBoundOps).not.toHaveBeenCalled();
  });

  it("submits a create-only scene write through the identity-bound path", async () => {
    const executeIdentityBoundOps = vi.fn(async () => ({
      status: "ok",
      results: [{ ok: true, op: "WriteFile" }],
    }));
    vi.mocked(getClient).mockResolvedValue({
      getBoundProjectIdHash: () => "hash-a",
      executeIdentityBoundOps,
    } as never);

    await tool(tools(), "summer_write_file").handler({
      path: "res://levels/new_level.tscn",
      content: "[gd_scene format=3]",
      create_only: true,
    });

    expect(executeIdentityBoundOps).toHaveBeenCalledWith([
      {
        op: "WriteFile",
        path: "res://levels/new_level.tscn",
        content: "[gd_scene format=3]",
        mustNotExist: true,
      },
    ]);
  });

  it("reads, uniquely replaces, then writes with the engine sha receipt", async () => {
    const sha = "a".repeat(64);
    const executeIdentityBoundOps = vi.fn(async () => ({
      status: "ok",
      results: [{ ok: true, op: "WriteFile" }],
    }));
    vi.mocked(getClient).mockResolvedValue({
      getBoundProjectIdHash: () => "hash-a",
      readProjectFile: vi.fn(async () => ({
        ok: true,
        data: {
          content: "speed = 10\nname = \"runner\"\n",
          encoding: "utf-8",
          sha256: sha,
          size: 27,
        },
      })),
      executeIdentityBoundOps,
    } as never);

    await tool(tools(), "summer_replace_text").handler({
      path: "res://scripts/player.gd",
      old_text: "speed = 10",
      new_text: "speed = 12",
      replace_all: false,
    });

    expect(executeIdentityBoundOps).toHaveBeenCalledWith([
      {
        op: "WriteFile",
        path: "res://scripts/player.gd",
        content: "speed = 12\nname = \"runner\"\n",
        expectedSha256: sha,
      },
    ]);
  });

  it("refuses ambiguous replacement text", async () => {
    vi.mocked(getClient).mockResolvedValue({
      getBoundProjectIdHash: () => "hash-a",
      readProjectFile: vi.fn(async () => ({
        ok: true,
        data: {
          content: "pass\npass\n",
          encoding: "utf-8",
          sha256: "b".repeat(64),
        },
      })),
      executeIdentityBoundOps: vi.fn(),
    } as never);

    const result = await tool(tools(), "summer_replace_text").handler({
      path: "res://scripts/player.gd",
      old_text: "pass",
      new_text: "return",
      replace_all: false,
    });
    expect(text(result)).toContain("matched 2 times");
  });
});
