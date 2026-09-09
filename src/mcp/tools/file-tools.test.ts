import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../server.js", () => ({
  getClient: vi.fn(),
  resetClient: vi.fn(),
}));

vi.mock("../../core/telemetry.js", () => ({
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

  it("serializes complete replace transactions for the same project file", async () => {
    let currentContent = "speed = 10\nname = \"runner\"\n";
    let currentSha = "a".repeat(64);
    let releaseFirstWrite!: () => void;
    let firstWriteStarted!: () => void;
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const firstWriteObserved = new Promise<void>((resolve) => {
      firstWriteStarted = resolve;
    });
    const readProjectFile = vi.fn(async () => ({
      ok: true,
      data: {
        content: currentContent,
        encoding: "utf-8",
        sha256: currentSha,
      },
    }));
    let writeCount = 0;
    const executeIdentityBoundOps = vi.fn(async (ops: Array<Record<string, unknown>>) => {
      writeCount++;
      if (writeCount === 1) {
        firstWriteStarted();
        await firstWriteGate;
      }
      currentContent = String(ops[0].content);
      currentSha = String(writeCount + 1).repeat(64);
      return { status: "ok", results: [{ ok: true, op: "WriteFile" }] };
    });
    vi.mocked(getClient).mockResolvedValue({
      getBoundProjectIdHash: () => "hash-a",
      readProjectFile,
      executeIdentityBoundOps,
    } as never);

    const registered = tools();
    const replace = tool(registered, "summer_replace_text");
    const first = replace.handler({
      path: "res://Scripts/Player.gd",
      old_text: "speed = 10",
      new_text: "speed = 12",
      replace_all: false,
    });
    await firstWriteObserved;
    const second = replace.handler({
      path: "res://scripts/player.gd",
      old_text: "name = \"runner\"",
      new_text: "name = \"sprinter\"",
      replace_all: false,
    });
    await Promise.resolve();

    expect(readProjectFile).toHaveBeenCalledTimes(1);
    releaseFirstWrite();
    await Promise.all([first, second]);

    expect(readProjectFile).toHaveBeenCalledTimes(2);
    expect(executeIdentityBoundOps).toHaveBeenCalledTimes(2);
    expect(executeIdentityBoundOps.mock.calls[1][0][0]).toMatchObject({
      content: "speed = 12\nname = \"sprinter\"\n",
      expectedSha256: "2".repeat(64),
    });
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

describe("file tool input errors classify as invalid_input, not transport", () => {
  function body(result: unknown): { failure_reason?: string; error?: string } {
    return JSON.parse(text(result).split("\nHint:")[0]!.trim().replace(/\n\n[\s\S]*$/, ""));
  }

  it("a traversal path is refused as input before anything is sent", async () => {
    const readProjectFile = vi.fn();
    vi.mocked(getClient).mockResolvedValue({ readProjectFile } as never);

    const result = await tool(tools(), "summer_read_file").handler({
      path: "res://../secrets.gd",
      max_bytes: 1000,
    });

    expect(body(result).failure_reason).toBe("invalid_input");
    expect(text(result)).not.toContain("partially applied");
    expect(readProjectFile).not.toHaveBeenCalled();
  });

  it("an unguarded write is refused as input, keeping the client", async () => {
    const executeIdentityBoundOps = vi.fn();
    vi.mocked(getClient).mockResolvedValue({
      getBoundProjectIdHash: () => "hash-a",
      executeIdentityBoundOps,
    } as never);

    const result = await tool(tools(), "summer_write_file").handler({
      path: "res://main.tscn",
      content: "x",
      expected_sha256: "not-a-sha",
    });

    expect(body(result).failure_reason).toBe("invalid_input");
    expect(body(result).error).toContain("64-character");
    expect(executeIdentityBoundOps).not.toHaveBeenCalled();
  });
});
