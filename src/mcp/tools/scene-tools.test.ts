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

function batchTool(): RegisteredTool {
  const registered: RegisteredTool[] = [];
  registerSceneTools({
    tool(
      name: string,
      _description: string,
      _schema: Record<string, unknown>,
      handler: (args: Record<string, unknown>) => Promise<unknown>,
    ) {
      registered.push({ name, handler });
      return { name };
    },
  } as never);
  const found = registered.find((candidate) => candidate.name === "summer_batch");
  if (!found) throw new Error("summer_batch was not registered");
  return found;
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
