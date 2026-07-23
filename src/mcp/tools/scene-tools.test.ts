import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const executeOpsMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/telemetry.js", () => ({
  recordMcpSession: vi.fn(),
}));

vi.mock("../server.js", () => ({
  getClient: vi.fn(async () => ({
    executeOps: executeOpsMock,
  })),
  resetClient: vi.fn(),
}));

import { MAX_BATCH_OPERATIONS } from "./operation-classification.js";
import { registerSceneTools } from "./scene-tools.js";

type RegisteredTool = {
  name: string;
  description: string;
  schema: Record<string, any>;
  handler: (args: any) => Promise<any>;
};

function createFakeServer() {
  const tools: RegisteredTool[] = [];
  const server = {
    tool(
      name: string,
      description: string,
      schema: Record<string, any>,
      handler: (args: any) => Promise<any>
    ) {
      tools.push({ name, description, schema, handler });
      return { name };
    },
  };
  return { server, tools };
}

function getTool(tools: RegisteredTool[], name: string): RegisteredTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return tool;
}

function parseResult(result: any): Record<string, unknown> {
  const text = result?.content?.[0]?.text;
  if (!text) throw new Error("Tool result did not include text content.");
  return JSON.parse(text) as Record<string, unknown>;
}

beforeEach(() => {
  executeOpsMock.mockReset();
  executeOpsMock.mockResolvedValue({
    ok: true,
    terminalState: "applied",
    results: [],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("summer_batch batch allowlist", () => {
  it("registers a bounded array schema and no raw verification tool", () => {
    const { server, tools } = createFakeServer();
    registerSceneTools(server as any);

    const batch = getTool(tools, "summer_batch");
    expect(batch.schema.ops.safeParse([]).success).toBe(false);
    expect(
      batch.schema.ops.safeParse(
        Array.from({ length: MAX_BATCH_OPERATIONS + 1 }, () => ({
          op: "SetProp",
        }))
      ).success
    ).toBe(false);
    expect(tools.some((tool) => tool.name === "summer_run_verification")).toBe(
      false
    );
  });

  it("forwards an allowed multi-node scene batch in one undo group", async () => {
    const { server, tools } = createFakeServer();
    registerSceneTools(server as any);
    const ops = [
      {
        op: "AddNode",
        parent: ".",
        type: "Node3D",
        name: "World",
      },
      {
        op: "AddNode",
        parent: "./World",
        type: "MeshInstance3D",
        name: "Floor",
      },
      {
        op: "SetProp",
        path: "./World/Floor",
        key: "mesh",
        value: "PlaneMesh",
      },
    ];

    const result = await getTool(tools, "summer_batch").handler({ ops });

    expect(result.isError).toBeFalsy();
    expect(executeOpsMock).toHaveBeenCalledOnce();
    expect(executeOpsMock).toHaveBeenCalledWith(ops, { groupUndo: true });
  });

  it.each([
    "WriteFile",
    "DeleteFile",
    "GitStatus",
    "RunCommand",
    "SummerGitRestore",
    "AcceptAIDiff",
    "RunVerification",
    "SimulateInput",
    "UnknownNewOp",
  ])("rejects denied operation %s before an engine request", async (op) => {
    const { server, tools } = createFakeServer();
    registerSceneTools(server as any);

    const result = await getTool(tools, "summer_batch").handler({
      ops: [{ op, secret: "must-not-be-echoed" }],
    });

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatchObject({
      error: "batch_rejected",
      rejectedIndex: 0,
      operation: op,
    });
    expect(result.content[0].text).not.toContain("must-not-be-echoed");
    expect(executeOpsMock).not.toHaveBeenCalled();
  });

  it("validates a mixed batch completely before transport", async () => {
    const { server, tools } = createFakeServer();
    registerSceneTools(server as any);

    const result = await getTool(tools, "summer_batch").handler({
      ops: [
        { op: "AddNode", parent: ".", type: "Node3D", name: "Safe" },
        { op: "GitPush", remote: "origin" },
      ],
    });

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatchObject({
      rejectedIndex: 1,
      operation: "GitPush",
    });
    expect(executeOpsMock).not.toHaveBeenCalled();
  });

  it.each([
    { item: {}, expectedIndex: 0 },
    { item: { op: "" }, expectedIndex: 0 },
    { item: { op: 42 }, expectedIndex: 0 },
    { item: "SetProp", expectedIndex: 0 },
  ])("rejects missing, non-string, or non-object ops", async ({
    item,
    expectedIndex,
  }) => {
    const { server, tools } = createFakeServer();
    registerSceneTools(server as any);

    const result = await getTool(tools, "summer_batch").handler({
      ops: [item],
    });

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatchObject({
      error: "batch_rejected",
      rejectedIndex: expectedIndex,
    });
    expect(executeOpsMock).not.toHaveBeenCalled();
  });

  it("accepts the maximum batch size and rejects one operation over it", async () => {
    const { server, tools } = createFakeServer();
    registerSceneTools(server as any);
    const batch = getTool(tools, "summer_batch");
    const maxOps = Array.from({ length: MAX_BATCH_OPERATIONS }, (_, index) => ({
      op: "SetProp",
      path: ".",
      key: `value_${index}`,
      value: index,
    }));

    const accepted = await batch.handler({ ops: maxOps });
    expect(accepted.isError).toBeFalsy();
    expect(executeOpsMock).toHaveBeenCalledOnce();

    executeOpsMock.mockClear();
    const rejected = await batch.handler({
      ops: [...maxOps, { op: "SetProp", path: ".", key: "extra", value: 1 }],
    });
    expect(rejected.isError).toBe(true);
    expect(parseResult(rejected).reason).toContain(
      `between 1 and ${MAX_BATCH_OPERATIONS}`
    );
    expect(executeOpsMock).not.toHaveBeenCalled();
  });
});
