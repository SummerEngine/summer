import { describe, expect, it, vi } from "vitest";
import {
  CANARY_RAW_OP_NAMES,
  CANARY_TOOL_NAMES,
  CallBudget,
  type McpToolRecord,
  catalogSnapshot,
  filterCatalog,
  gateAndInvoke,
  sanitizeMediaBlocks,
} from "./canary-gateway-core.ts";

function tool(name: string, schema: Record<string, unknown> = {}): McpToolRecord {
  return { name, description: `${name} description`, inputSchema: schema };
}

const upstream = [
  tool("summer_get_scene_tree"),
  tool("summer_batch"),
  ...CANARY_TOOL_NAMES.map((name) => tool(name)),
  tool("summer_screenshot"),
];

describe("canary catalog policy", () => {
  it("makes the treatment catalog differ from control by exactly its one canary", () => {
    const control = filterCatalog(upstream, { mode: "control" });
    for (const canary of CANARY_TOOL_NAMES) {
      const treatment = filterCatalog(upstream, { mode: "treatment", canary });
      const controlNames = new Set(control.map((candidate) => candidate.name));
      expect(treatment.filter((candidate) => !controlNames.has(candidate.name))).toEqual([
        upstream.find((candidate) => candidate.name === canary),
      ]);
      expect(treatment.filter((candidate) => !CANARY_TOOL_NAMES.includes(candidate.name as never)))
        .toEqual(control);
      expect(catalogSnapshot(treatment).sha256).not.toBe(catalogSnapshot(control).sha256);
    }
  });

  it("denies a hidden call before the MCP invoke mock runs", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const budget = new CallBudget(3);
    await expect(
      gateAndInvoke({
        toolName: "summer_test_placement",
        args: {},
        visibleTools: filterCatalog(upstream, { mode: "control" }),
        budget,
        invoke,
      })
    ).rejects.toMatchObject({ code: "tool_not_visible" });
    expect(invoke).not.toHaveBeenCalled();
    expect(budget.usedCalls).toBe(1);
  });

  it.each(CANARY_RAW_OP_NAMES)(
    "denies raw prototype op %s through summer_batch's escape hatch",
    async (rawOp) => {
      const invoke = vi.fn(async () => ({ ok: true }));
      const budget = new CallBudget(3);
      await expect(
        gateAndInvoke({
          toolName: "summer_batch",
          args: {
            scenePath: "res://trial.tscn",
            ops: [{ op: rawOp, subject: "Crate" }],
          },
          visibleTools: filterCatalog(upstream, { mode: "control" }),
          budget,
          invoke,
        })
      ).rejects.toMatchObject({ code: "canary_raw_op_denied" });
      expect(invoke).not.toHaveBeenCalled();
      expect(budget.usedCalls).toBe(1);
    }
  );
});

describe("fixed call budget", () => {
  it("allows exactly maxCalls attempts and then fails closed", async () => {
    const visible = filterCatalog(upstream, { mode: "control" });
    const invoke = vi.fn(async () => ({ ok: true }));
    const budget = new CallBudget(2);

    await gateAndInvoke({
      toolName: "summer_get_scene_tree",
      args: {},
      visibleTools: visible,
      budget,
      invoke,
    });
    await gateAndInvoke({
      toolName: "summer_get_scene_tree",
      args: {},
      visibleTools: visible,
      budget,
      invoke,
    });
    await expect(
      gateAndInvoke({
        toolName: "summer_get_scene_tree",
        args: {},
        visibleTools: visible,
        budget,
        invoke,
      })
    ).rejects.toMatchObject({ code: "call_budget_exhausted" });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(budget.remainingCalls).toBe(0);
  });
});

describe("canonical catalog hash", () => {
  it("is independent of tool order and object key insertion order", () => {
    const left = [
      tool("b", { type: "object", properties: { z: { type: "number" } } }),
      tool("a", { required: ["x"], type: "object" }),
    ];
    const right: McpToolRecord[] = [
      {
        inputSchema: { type: "object", required: ["x"] },
        description: "a description",
        name: "a",
      },
      {
        inputSchema: { properties: { z: { type: "number" } }, type: "object" },
        name: "b",
        description: "b description",
      },
    ];
    expect(catalogSnapshot(left)).toEqual(catalogSnapshot(right));
  });
});

describe("media sanitization", () => {
  it("replaces image and audio base64 with concise local-file metadata", () => {
    const persisted: Array<{ type: string; bytes: Buffer }> = [];
    const sanitized = sanitizeMediaBlocks(
      {
        content: [
          { type: "image", data: Buffer.from("pixels").toString("base64"), mimeType: "image/png" },
          { type: "text", text: "frame" },
          { type: "audio", data: Buffer.from("sound").toString("base64"), mimeType: "audio/wav" },
        ],
      },
      (media) => {
        persisted.push({ type: media.type, bytes: media.bytes });
        return { filePath: `/trial/media/${media.blockIndex}` };
      }
    );

    expect(persisted.map((item) => [item.type, item.bytes.toString("utf8")])).toEqual([
      ["image", "pixels"],
      ["audio", "sound"],
    ]);
    expect(sanitized.result).toMatchObject({
      content: [
        { type: "image", filePath: "/trial/media/0", mimeType: "image/png" },
        { type: "text", text: "frame" },
        { type: "audio", filePath: "/trial/media/2", mimeType: "audio/wav" },
      ],
    });
    expect(JSON.stringify(sanitized.result)).not.toContain("cGl4ZWxz");
    expect(JSON.stringify(sanitized.result)).not.toContain("c291bmQ=");
  });
});
