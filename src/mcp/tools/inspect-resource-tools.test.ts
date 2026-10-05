import { describe, expect, it, vi } from "vitest";

vi.mock("../server.js", () => ({ getClient: vi.fn(), resetClient: vi.fn(), getCachedBootDriftNotice: () => null }));
vi.mock("../../core/telemetry.js", () => ({ recordMcpSession: vi.fn() }));

import { getClient } from "../server.js";
import { registerSceneTools } from "./scene-tools.js";
import { dispatchTool } from "../../core/capabilities/tool-dispatch.js";

type Op = Record<string, unknown>;

/** What the probe returns for a small single-surface kit mesh. */
const MESH = {
  ok: true,
  path: "res://kit/meshes/gutter_outlet.res",
  resource_type: "ArrayMesh",
  mesh: { surface_count: 1, surfaces: [{ index: 0, primitive: "triangles", triangles: 1200 }], triangles: 1200 },
};

function fakeClient() {
  return {
    executeIdentityBoundOps: vi.fn(async (_ops: Op[]) => ({
      status: "ok",
      terminalState: "applied",
      results: [{ ok: true, op: "RunSceneScript", ran: true, result: MESH }],
    })),
    getEngineCapabilities: () => undefined,
  };
}

describe("summer_inspect_resource faces", () => {
  it("MCP and CLI both run the file probe", async () => {
    vi.mocked(getClient).mockResolvedValue(fakeClient() as never);
    const registered: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }> = [];
    registerSceneTools({
      tool(name: string, _description: string, _schema: unknown, handler: (typeof registered)[number]["handler"]) {
        registered.push({ name, handler });
        return { name };
      },
    } as never);
    const mcp = await registered.find((t) => t.name === "summer_inspect_resource")!.handler({ path: MESH.path });
    expect(mcp.isError).toBeFalsy();
    expect(JSON.parse(mcp.content[0]!.text)).toMatchObject({ ok: true, mesh: { surface_count: 1 } });

    const cli = (await dispatchTool("inspect-resource", { path: MESH.path }, { engine: async () => fakeClient() as never })) as Record<string, unknown>;
    expect(cli).toMatchObject({ ok: true, mesh: { triangles: 1200 } });
  });
});
