import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../server.js", () => ({
  getClient: vi.fn(),
  resetClient: vi.fn(),
}));

vi.mock("../../core/telemetry.js", () => ({
  recordMcpSession: vi.fn(),
}));

import { getClient } from "../server.js";
import { registerPlacementTools, renderPlacementResult } from "./placement-tools.js";
import { registerSceneTools } from "./scene-tools.js";

type Handler = (args: Record<string, unknown>) => Promise<unknown>;
type Registered = { name: string; description: string; schema: Record<string, { safeParse: (v: unknown) => { success: boolean } }>; handler: Handler };
type Response = { isError?: boolean; content: Array<{ type: string; text: string }> };

function collect(register: (server: never) => void): Registered[] {
  const out: Registered[] = [];
  register({
    tool(name: string, description: string, schema: Registered["schema"], handler: Handler) {
      out.push({ name, description, schema, handler });
      return { name };
    },
  } as never);
  return out;
}

const placement = () => collect(registerPlacementTools);
const tool = (name: string, list = placement()) => list.find((entry) => entry.name === name)!;
const body = (result: unknown) => JSON.parse((result as Response).content[0]!.text) as Record<string, unknown>;

afterEach(() => vi.clearAllMocks());

describe("placement tool registration", () => {
  it("registers the seven placement tools with the existing ops named in their descriptions", () => {
    const names = placement().map((entry) => entry.name);
    expect(names).toEqual([
      "summer_inspect_asset",
      "summer_place_adjacent",
      "summer_attach_to_surface",
      "summer_repeat_along",
      "summer_connect_ports",
      "summer_raycast",
      "summer_measure",
    ]);
    expect(tool("summer_attach_to_surface").description).toContain("SnapToSurface");
    expect(tool("summer_raycast").description).toContain("summer_starcast");
    expect(tool("summer_measure").description).toContain("summer_starcast");
    expect(tool("summer_place_adjacent").description).toContain("summer_align_distribute_3d");
  });

  it("rejects malformed arguments at the schema boundary", () => {
    const adjacent = tool("summer_place_adjacent").schema;
    expect(adjacent.axis!.safeParse("w").success).toBe(false);
    expect(adjacent.alignOtherAxes!.safeParse({ y: "min", z: "max" }).success).toBe(true);
    expect(adjacent.alignOtherAxes!.safeParse("left").success).toBe(false);
    expect(tool("summer_measure").schema.scenePath!.safeParse("main.tscn").success).toBe(false);
    expect(tool("summer_repeat_along").schema.count!.safeParse(65).success).toBe(false);
    expect(tool("summer_attach_to_surface").schema.backAxis!.safeParse("back").success).toBe(false);
  });
});

describe("placement result rendering", () => {
  it("renders failures verbatim as isError so structured fields survive", () => {
    const rendered = renderPlacementResult({ ok: false, tool: "summer_raycast", failure_reason: "scene_not_open", error: "open it" });
    expect(rendered.isError).toBe(true);
    expect(JSON.parse(rendered.content[0]!.text)).toMatchObject({ failure_reason: "scene_not_open" });
  });

  it("refuses to forward a result over 5 KB", () => {
    const rendered = renderPlacementResult({ ok: true, tool: "summer_measure", blob: "x".repeat(6000) });
    expect(rendered.isError).toBe(true);
    expect(JSON.parse(rendered.content[0]!.text)).toMatchObject({ failure_reason: "result_exceeded_byte_limit" });
  });

  it("returns an input error before contacting the engine for an under-specified call", async () => {
    const executeIdentityBoundOps = vi.fn();
    vi.mocked(getClient).mockResolvedValue({ getBoundProjectIdHash: () => "h", executeIdentityBoundOps } as never);
    const result = (await tool("summer_attach_to_surface").handler({
      scenePath: "res://a.tscn",
      subject: "Lamp",
      backAxis: "-z",
      upAxis: "+y",
      worldUp: [0, 1, 0],
      standoff: 0,
      maxDistance: 20,
      collisionMask: 0xffffffff,
    })) as Response;
    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({ failure_reason: "invalid_input", sent: false });
    expect(executeIdentityBoundOps).not.toHaveBeenCalled();
  });

  it("runs the probe through the live client and returns the compact result", async () => {
    const executeIdentityBoundOps = vi.fn(async () => ({
      status: "ok",
      terminalState: "applied",
      results: [{ ok: true, op: "RunSceneScript", result: { ok: true, physics_available: true, physics: { path: "Wall", point: [0, 1, -2], normal: [0, 0, 1], distance: 2 } } }],
    }));
    vi.mocked(getClient).mockResolvedValue({ getBoundProjectIdHash: () => "h", executeIdentityBoundOps } as never);
    const result = (await tool("summer_raycast").handler({
      scenePath: "res://a.tscn",
      origin: [0, 1, 0],
      direction: [0, 0, -1],
      maxDistance: 100,
      collisionMask: 0xffffffff,
      collideWithAreas: false,
      evidence: "auto",
    })) as Response;
    expect(result.isError).toBeUndefined();
    expect(body(result)).toMatchObject({ ok: true, hit: true, evidence: "physics", path: "Wall" });
  });
});

describe("summer_instantiate_scene and summer_batch placement through MCP", () => {
  function engine() {
    const requests: Array<Array<Record<string, unknown>>> = [];
    const executeIdentityBoundOps = vi.fn(async (ops: Array<Record<string, unknown>>) => {
      requests.push(ops);
      return {
        status: "ok",
        terminalState: "applied",
        results: ops.map((op) =>
          op.op === "InstantiateScene" ? { ok: true, op: op.op, meta: { nodePath: `World/${String(op.name)}` } } : { ok: true, op: op.op }
        ),
      };
    });
    vi.mocked(getClient).mockResolvedValue({ getBoundProjectIdHash: () => "h", executeIdentityBoundOps, executeOps: vi.fn() } as never);
    return requests;
  }

  it("instantiates with position and rotation in one call", async () => {
    const requests = engine();
    const scene = collect(registerSceneTools);
    const result = (await tool("summer_instantiate_scene", scene).handler({
      scenePath: "res://a.tscn",
      parent: "./World",
      scene: "res://kit/wall.tscn",
      name: "Wall",
      position: [2, 0, 0],
      rotation_degrees: [0, 180, 0],
    })) as Response;
    expect(result.isError).toBeUndefined();
    expect(requests.map((chunk) => chunk.map((op) => op.op))).toEqual([["InstantiateScene"], ["SetProp", "SetProp"], ["SaveScene"]]);
    expect(body(result).placement).toMatchObject({ nodePath: "World/Wall", applied: true });
  });

  it("returns a summary receipt for a batch of placed pieces", async () => {
    const requests = engine();
    const scene = collect(registerSceneTools);
    const ops = Array.from({ length: 40 }, (_, i) => ({
      op: "InstantiateScene",
      parent: "./World",
      scene: "res://kit/wall.tscn",
      name: `Wall_${i}`,
      position: [i, 0, 0],
    }));
    const result = (await tool("summer_batch", scene).handler({ scenePath: "res://a.tscn", ops, receipt: "summary" })) as Response;
    expect(result.isError).toBeUndefined();
    expect(Buffer.byteLength(result.content[0]!.text)).toBeLessThan(5 * 1024);
    expect(body(result)).toMatchObject({ receipt: "summary", ops: 40, applied: 40, failed: 0, saved: true, created_total: 40, requests: 42 });
    // 40 instances, one request with every transform, the save.
    expect(requests).toHaveLength(42);
    expect(requests[40]).toHaveLength(40);
  });
});
