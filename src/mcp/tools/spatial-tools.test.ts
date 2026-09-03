import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../server.js", () => ({
  getClient: vi.fn(),
  resetClient: vi.fn(),
}));

vi.mock("../../core/telemetry.js", () => ({
  recordMcpSession: vi.fn(),
}));

import { getClient } from "../server.js";
import { registerSpatialTools } from "./spatial-tools.js";

type RegisteredTool = {
  name: string;
  schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

type ParsableSchema = { safeParse: (value: unknown) => { success: boolean } };

type Response = { isError?: boolean; content: Array<{ type: string; text: string }> };

function tools(): RegisteredTool[] {
  const registered: RegisteredTool[] = [];
  registerSpatialTools({
    tool(
      name: string,
      _description: string,
      schema: Record<string, unknown>,
      handler: (args: Record<string, unknown>) => Promise<unknown>,
    ) {
      registered.push({ name, schema, handler });
      return { name };
    },
  } as never);
  return registered;
}

function tool(name: string): RegisteredTool {
  const found = tools().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

function input(registered: RegisteredTool, field: string): ParsableSchema {
  const schema = registered.schema[field] as Partial<ParsableSchema> | undefined;
  if (!schema || typeof schema.safeParse !== "function") {
    throw new Error(`${registered.name}.${field} did not register a Zod input schema`);
  }
  return schema as ParsableSchema;
}

function text(result: unknown): string {
  return (result as Response).content?.[0]?.text ?? "";
}

const okReceipt = (ops: Array<Record<string, unknown>>) => ({
  status: "ok",
  terminalState: "applied",
  results: ops.map((op) => ({ ok: true, op: String(op.op ?? "") })),
});

/** Client whose identity-bound calls are recorded; executeOps is a trap. */
function mockClient(overrides: Record<string, unknown> = {}) {
  const calls: Array<Record<string, unknown>[]> = [];
  const optionsSeen: unknown[] = [];
  const executeIdentityBoundOps = vi.fn(async (ops: Record<string, unknown>[], options?: unknown) => {
    calls.push(ops);
    optionsSeen.push(options);
    return okReceipt(ops);
  });
  const executeOps = vi.fn();
  vi.mocked(getClient).mockResolvedValue({
    getBoundProjectIdHash: () => "hash-a",
    executeIdentityBoundOps,
    executeOps,
    ...overrides,
  } as never);
  return { calls, optionsSeen, executeIdentityBoundOps, executeOps };
}

/** A native op result padded to EXACTLY targetBytes of UTF-8 JSON. */
function nativeResultAtUtf8Bytes(op: string, targetBytes: number): Record<string, unknown> {
  const result = { ok: true, op, padding: "" };
  const fixedBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (fixedBytes > targetBytes) throw new Error("Result framing exceeds target byte length");
  result.padding = "x".repeat(targetBytes - fixedBytes);
  expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBe(targetBytes);
  return result;
}

afterEach(() => {
  vi.clearAllMocks();
});

const ARGS = {
  summer_test_placement: {
    scenePath: "res://levels/shelf_test.tscn",
    subjectPath: " ./World/Crate ",
    candidateGlobalPosition: [1.25, 1.1, -0.5],
    candidateGlobalRotationDegrees: [0, 90, 0],
    collisionMask: 5,
    collideWithAreas: false,
    maxFloorDistance: 4,
    groundTolerance: 0.025,
    margin: 0.002,
  },
  summer_snap_to_surface: {
    scenePath: "res://levels/market.tscn",
    subjectPath: "./Props/Crate",
    direction: [0, -1, 0],
    maxDistance: 20,
    gap: 0.01,
    alignUp: false,
  },
  summer_align_distribute_3d: {
    scenePath: "res://levels/market.tscn",
    subjectPaths: ["./Stalls/A", "./Stalls/B", "./Stalls/C"],
    axis: [1, 0, 0],
    mode: "distribute_gaps",
  },
  summer_navigation_probe: {
    scenePath: "res://levels/courtyard.tscn",
    start: [0, 0, 0],
    end: [4, 0, -2],
    navigationLayers: 1,
    optimize: true,
  },
  summer_starcast: {
    scenePath: "res://levels/test_room.tscn",
    path: " ./World/Crate ",
    detail: "full",
    maxDistance: 30,
    nearbyRadius: 12,
    directionSpace: "local",
    collisionMask: 5,
    collideWithAreas: false,
    maxHitsPerDirection: 4,
    maxResults: 48,
    margin: 0.002,
  },
} as const;

const OPS: Record<keyof typeof ARGS, { op: string; mutation: boolean; failure: string; fallback: string }> = {
  summer_test_placement: { op: "TestPlacement3D", mutation: false, failure: "placement_result_exceeded_byte_limit", fallback: "summer_inspect_node" },
  summer_snap_to_surface: { op: "SnapToSurface", mutation: true, failure: "snap_to_surface_result_exceeded_byte_limit", fallback: "summer_set_prop" },
  summer_align_distribute_3d: { op: "AlignDistribute3D", mutation: true, failure: "align_result_exceeded_byte_limit", fallback: "summer_set_prop" },
  summer_navigation_probe: { op: "NavigationProbe3D", mutation: false, failure: "navigation_probe_result_exceeded_byte_limit", fallback: "RunVerification" },
  summer_starcast: { op: "Starcast3D", mutation: false, failure: "starcast_result_exceeded_byte_limit", fallback: "summer_inspect_node" },
};

const TOOL_NAMES = Object.keys(ARGS) as Array<keyof typeof ARGS>;
/** The four tools sharing the exclusive 5 KiB compactResult cap. Starcast has
 *  its own inclusive ceilings (5 KiB summary / 12 KiB full), tested below. */
const COMPACT_TOOL_NAMES = TOOL_NAMES.filter((name) => name !== "summer_starcast");

describe("registration", () => {
  it("registers the five spatial tools", () => {
    expect(tools().map((t) => t.name)).toEqual([
      "summer_test_placement",
      "summer_snap_to_surface",
      "summer_align_distribute_3d",
      "summer_navigation_probe",
      "summer_starcast",
    ]);
  });
});

describe("capability pre-flight (engine advertises opKinds without the op)", () => {
  it.each(TOOL_NAMES)("%s refuses before sending and names the fallback", async (name) => {
    const { executeIdentityBoundOps, executeOps } = mockClient({
      getEngineCapabilities: () => ({ opKinds: ["AddNode", "SetProp", "SaveScene"] }),
      getEngineVersion: () => "0.5.61",
    });
    const result = (await tool(name).handler({ ...ARGS[name] })) as Response;
    expect(result.isError).toBe(true);
    expect(executeIdentityBoundOps).not.toHaveBeenCalled();
    expect(executeOps).not.toHaveBeenCalled();
    expect(text(result)).toContain("engine_lacks_op");
    expect(text(result)).toContain(OPS[name].op);
    expect(text(result)).toContain("engine version 0.5.61");
    expect(text(result)).toContain(OPS[name].fallback);
  });

  it.each(TOOL_NAMES)("%s sends when the advert includes the op", async (name) => {
    const { executeIdentityBoundOps } = mockClient({
      getEngineCapabilities: () => ({ opKinds: [OPS[name].op, "SaveScene"] }),
    });
    const result = (await tool(name).handler({ ...ARGS[name] })) as Response;
    expect(result.isError).toBeUndefined();
    expect(executeIdentityBoundOps).toHaveBeenCalled();
  });
});

describe("old engine with no capability advert (per-op unknown op)", () => {
  it("rewrites a read-only tool's unknown-op failure into the upgrade path", async () => {
    mockClient({
      executeIdentityBoundOps: vi.fn(async () => ({
        ok: false,
        results: [{ ok: false, op: "TestPlacement3D", error: "unknown op: TestPlacement3D" }],
      })),
    });
    const result = (await tool("summer_test_placement").handler({ ...ARGS.summer_test_placement })) as Response;
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("doesn't support TestPlacement3D yet");
    expect(text(result)).toContain("summer_get_scene_tree");
    // E2E 2026-09-03 F-16: never send an engine_lacks_op agent to another op
    // that is engine_lacks_op on the same build.
    expect(text(result)).not.toContain("summer_world_snapshot");
  });

  it("rewrites starcast's unknown-op failure into the upgrade path and stamps engine_lacks_op", async () => {
    mockClient({
      executeIdentityBoundOps: vi.fn(async () => ({
        ok: false,
        results: [{ ok: false, op: "Starcast3D", error: "unknown op: Starcast3D" }],
      })),
    });
    const result = (await tool("summer_starcast").handler({ ...ARGS.summer_starcast })) as Response;
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("doesn't support Starcast3D yet");
    expect(text(result)).toContain("summer_inspect_node");
    expect(text(result)).toContain('"failure_reason": "engine_lacks_op"');
  });

  it("rewrites a chunked mutation's unknown-op failure too (SaveScene never sent)", async () => {
    const calls: Array<Record<string, unknown>[]> = [];
    mockClient({
      executeIdentityBoundOps: vi.fn(async (ops: Record<string, unknown>[]) => {
        calls.push(ops);
        return {
          ok: false,
          results: [{ ok: false, op: "SnapToSurface", error: "unknown op: SnapToSurface" }],
        };
      }),
    });
    const result = (await tool("summer_snap_to_surface").handler({ ...ARGS.summer_snap_to_surface })) as Response;
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("doesn't support SnapToSurface yet");
    expect(text(result)).toContain("unknown op: SnapToSurface");
    expect(calls).toEqual([[expect.objectContaining({ op: "SnapToSurface" })]]);
  });
});

describe("summer_test_placement", () => {
  it("sends one exact identity-bound op, never appends SaveScene, and returns only the compact op result", async () => {
    const { calls, optionsSeen, executeOps } = mockClient();
    const result = (await tool("summer_test_placement").handler({ ...ARGS.summer_test_placement })) as Response;
    expect(result.isError).toBeUndefined();
    expect(calls).toEqual([[{
      op: "TestPlacement3D",
      subject_path: "./World/Crate",
      candidate_global_position: [1.25, 1.1, -0.5],
      candidate_global_rotation_degrees: [0, 90, 0],
      collision_mask: 5,
      collide_with_areas: false,
      max_floor_distance: 4,
      ground_tolerance: 0.025,
      margin: 0.002,
    }]]);
    expect(optionsSeen).toEqual([{ scenePath: "res://levels/shelf_test.tscn" }]);
    expect(executeOps).not.toHaveBeenCalled();
    expect(text(result)).toBe('{"ok":true,"op":"TestPlacement3D"}');
  });

  it("accepts the native 0.001 max-floor-distance boundary and rejects just below it", async () => {
    const { executeIdentityBoundOps } = mockClient();
    const registered = tool("summer_test_placement");
    const justBelow = 0.001 - Number.EPSILON;
    expect(input(registered, "maxFloorDistance").safeParse(0.001).success).toBe(true);
    expect(input(registered, "maxFloorDistance").safeParse(justBelow).success).toBe(false);

    const accepted = (await registered.handler({ ...ARGS.summer_test_placement, maxFloorDistance: 0.001 })) as Response;
    expect(accepted.isError).toBeUndefined();
    const rejected = (await registered.handler({ ...ARGS.summer_test_placement, maxFloorDistance: justBelow })) as Response;
    expect(rejected.isError).toBe(true);
    expect(text(rejected)).toContain("maxFloorDistance must be at least 0.001");
    expect(executeIdentityBoundOps).toHaveBeenCalledTimes(1);
  });

  it("returns the native result untouched (not the transport envelope)", async () => {
    const native = { ok: true, op: "TestPlacement3D", readOnly: true, fits: null, grounded: true, floorGap: 0.004, overlapPaths: [] };
    mockClient({
      executeIdentityBoundOps: vi.fn(async () => ({ status: "ok", terminalState: "applied", results: [native] })),
    });
    const result = (await tool("summer_test_placement").handler({ ...ARGS.summer_test_placement })) as Response;
    expect(JSON.parse(text(result))).toEqual(native);
  });

  it("rejects oversized scene/subject paths (bytes, not chars) before dispatch", async () => {
    const { executeIdentityBoundOps } = mockClient();
    for (const oversized of [
      { ...ARGS.summer_test_placement, scenePath: `res://${"x".repeat(42 * 1024)}` },
      { ...ARGS.summer_test_placement, subjectPath: `./World/${"x".repeat(42 * 1024)}` },
      // Below Zod's character max but above the engine's UTF-8 byte max.
      { ...ARGS.summer_test_placement, scenePath: `res://${"界".repeat(170)}` },
      { ...ARGS.summer_test_placement, subjectPath: `./${"界".repeat(85)}` },
    ]) {
      const result = (await tool("summer_test_placement").handler(oversized)) as Response;
      expect(result.isError).toBe(true);
      // The 42 KB input must never echo back into the model-visible text —
      // only the bounded message plus withEngine's fixed recovery recipe.
      expect(Buffer.byteLength(text(result), "utf8")).toBeLessThan(1024);
      expect(text(result)).toMatch(/path.*UTF-8 bytes/i);
    }
    expect(executeIdentityBoundOps).not.toHaveBeenCalled();
  });
});

describe("summer_snap_to_surface", () => {
  it("sends the mutation then one SaveScene as separate identity-bound requests and returns only the snap receipt", async () => {
    const { calls, optionsSeen } = mockClient();
    const result = (await tool("summer_snap_to_surface").handler({ ...ARGS.summer_snap_to_surface })) as Response;
    expect(result.isError).toBeUndefined();
    expect(calls).toEqual([
      [{ op: "SnapToSurface", subject_path: "./Props/Crate", direction: [0, -1, 0], max_distance: 20, gap: 0.01, align_up: false }],
      [{ op: "SaveScene" }],
    ]);
    for (const options of optionsSeen) {
      expect((options as { scenePath: string }).scenePath).toBe("res://levels/market.tscn");
    }
    expect(JSON.parse(text(result))).toEqual({ ok: true, op: "SnapToSurface" });
  });

  it("rejects direction at/below the native squared-length minimum, gap > maxDistance, and blank subjectPath", async () => {
    const { executeIdentityBoundOps } = mockClient();
    const registered = tool("summer_snap_to_surface");
    const direction = input(registered, "direction");
    expect(direction.safeParse([0, -0.0031622776, 0]).success).toBe(false);
    expect(direction.safeParse([0, -0.0031623, 0]).success).toBe(true);

    const tooShort = (await registered.handler({ ...ARGS.summer_snap_to_surface, direction: [0, -0.001, 0] })) as Response;
    expect(tooShort.isError).toBe(true);
    expect(text(tooShort)).toContain("direction squared length must exceed 0.00001");

    const gapTooBig = (await registered.handler({ ...ARGS.summer_snap_to_surface, gap: 21 })) as Response;
    expect(gapTooBig.isError).toBe(true);
    expect(text(gapTooBig)).toContain("gap must not exceed maxDistance");

    const blank = (await registered.handler({ ...ARGS.summer_snap_to_surface, subjectPath: "   " })) as Response;
    expect(blank.isError).toBe(true);
    expect(text(blank)).toContain("selection fallback is not supported");
    expect(executeIdentityBoundOps).not.toHaveBeenCalled();
  });
});

describe("summer_align_distribute_3d", () => {
  it("dispatches one ordered mutation then SaveScene and returns the op result", async () => {
    const { calls } = mockClient();
    const result = (await tool("summer_align_distribute_3d").handler({ ...ARGS.summer_align_distribute_3d })) as Response;
    expect(result.isError).toBeUndefined();
    expect(calls).toEqual([
      [{ op: "AlignDistribute3D", subject_paths: ["./Stalls/A", "./Stalls/B", "./Stalls/C"], axis: [1, 0, 0], mode: "distribute_gaps" }],
      [{ op: "SaveScene" }],
    ]);
    expect(JSON.parse(text(result))).toEqual({ ok: true, op: "AlignDistribute3D" });
  });

  it("rejects duplicate subjects and a zero axis before dispatch", async () => {
    const { executeIdentityBoundOps } = mockClient();
    const registered = tool("summer_align_distribute_3d");
    const dup = (await registered.handler({ ...ARGS.summer_align_distribute_3d, subjectPaths: ["./A", " ./A "] })) as Response;
    expect(dup.isError).toBe(true);
    expect(text(dup)).toContain("must not contain duplicates");
    const zero = (await registered.handler({ ...ARGS.summer_align_distribute_3d, axis: [0, 0, 0] })) as Response;
    expect(zero.isError).toBe(true);
    expect(text(zero)).toMatch(/axis must/);
    expect(executeIdentityBoundOps).not.toHaveBeenCalled();
  });
});

describe("summer_navigation_probe", () => {
  it("sends exactly one identity-bound op and never saves", async () => {
    const { calls } = mockClient();
    const result = (await tool("summer_navigation_probe").handler({ ...ARGS.summer_navigation_probe })) as Response;
    expect(result.isError).toBeUndefined();
    expect(calls).toEqual([[{ op: "NavigationProbe3D", start: [0, 0, 0], end: [4, 0, -2], navigation_layers: 1, optimize: true }]]);
  });

  it("rejects an out-of-range layer mask and a non-finite point before dispatch", async () => {
    const { executeIdentityBoundOps } = mockClient();
    const registered = tool("summer_navigation_probe");
    expect(input(registered, "navigationLayers").safeParse(0).success).toBe(false);
    expect(input(registered, "start").safeParse([0, Number.NaN, 0]).success).toBe(false);
    const result = (await registered.handler({ ...ARGS.summer_navigation_probe, navigationLayers: 0 })) as Response;
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("navigationLayers must be an integer from 1");
    expect(executeIdentityBoundOps).not.toHaveBeenCalled();
  });
});

describe("summer_starcast", () => {
  it("sends one exact identity-bound op, never appends SaveScene, and returns only the compact op result", async () => {
    const { calls, optionsSeen, executeOps } = mockClient();
    const result = (await tool("summer_starcast").handler({ ...ARGS.summer_starcast })) as Response;
    expect(result.isError).toBeUndefined();
    expect(calls).toEqual([[{
      op: "Starcast3D",
      path: "./World/Crate",
      detail: "full",
      max_distance: 30,
      nearby_radius: 12,
      direction_space: "local",
      collision_mask: 5,
      collide_with_areas: false,
      max_hits_per_direction: 4,
      max_results: 48,
      margin: 0.002,
    }]]);
    expect(optionsSeen).toEqual([{ scenePath: "res://levels/test_room.tscn" }]);
    expect(executeOps).not.toHaveBeenCalled();
    expect(text(result)).toBe('{"ok":true,"op":"Starcast3D"}');
  });

  it("returns the engine's compact receipt untouched (schemaVersion 1 summary shape)", async () => {
    const native = {
      schemaVersion: 1,
      ok: true,
      op: "Starcast3D",
      readOnly: true,
      requestedDetail: "summary",
      returnedDetail: "summary",
      subject: { path: "./World/Crate", position: [1.25, 0.5, -0.5], size: [1, 1, 1] },
      grounded: true,
      contactStatus: "none_detected",
      contacts: [],
      directions: {
        down: { status: "blocked", distance: 0, object: "./World/Floor", evidence: "physics", relationship: "contact_or_overlap" },
        forward: { status: "open" },
        back: { status: "blocked", distance: 0.04, object: "./World/Shelf/BackPanel", evidence: "visual_aabb" },
      },
      coverage: { physics: true, visualBounds: true, directionCount: 26, truncated: false },
      warnings: [],
    };
    mockClient({
      executeIdentityBoundOps: vi.fn(async () => ({ status: "ok", terminalState: "applied", results: [native] })),
    });
    const result = (await tool("summer_starcast").handler({ ...ARGS.summer_starcast, detail: "summary" })) as Response;
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(text(result))).toEqual(native);
  });

  it("requires one exact path — no editor-selection fallback — and rejects blank or oversized paths before dispatch", async () => {
    const { executeIdentityBoundOps } = mockClient();
    const registered = tool("summer_starcast");
    expect(input(registered, "path").safeParse(undefined).success).toBe(false);
    expect(input(registered, "path").safeParse("   ").success).toBe(false);
    expect(input(registered, "path").safeParse("./" + "€".repeat(200)).success).toBe(false);
    const blank = (await registered.handler({ ...ARGS.summer_starcast, path: "   " })) as Response;
    expect(blank.isError).toBe(true);
    expect(text(blank)).toContain("selection fallback is not supported");
    const oversized = (await registered.handler({ ...ARGS.summer_starcast, path: `./World/${"x".repeat(42 * 1024)}` })) as Response;
    expect(oversized.isError).toBe(true);
    expect(Buffer.byteLength(text(oversized), "utf8")).toBeLessThan(1024);
    expect(executeIdentityBoundOps).not.toHaveBeenCalled();
  });

  it("schema pins detail, directionSpace, and the integer bounds the engine enforces", () => {
    const registered = tool("summer_starcast");
    expect(input(registered, "detail").safeParse("full").success).toBe(true);
    expect(input(registered, "detail").safeParse("verbose").success).toBe(false);
    expect(input(registered, "directionSpace").safeParse("local").success).toBe(true);
    expect(input(registered, "directionSpace").safeParse("camera").success).toBe(false);
    expect(input(registered, "maxHitsPerDirection").safeParse(8).success).toBe(true);
    expect(input(registered, "maxHitsPerDirection").safeParse(9).success).toBe(false);
    expect(input(registered, "maxHitsPerDirection").safeParse(0).success).toBe(false);
    expect(input(registered, "maxResults").safeParse(128).success).toBe(true);
    expect(input(registered, "maxResults").safeParse(129).success).toBe(false);
    expect(input(registered, "maxDistance").safeParse(0).success).toBe(false);
    expect(input(registered, "margin").safeParse(1.5).success).toBe(false);
  });

  /** A Starcast receipt padded to EXACTLY targetBytes of UTF-8 JSON. */
  function starcastReceiptAtUtf8Bytes(targetBytes: number, detail: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = { ok: true, op: "Starcast3D", ...detail, padding: "" };
    const fixedBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    if (fixedBytes > targetBytes) throw new Error("Result framing exceeds target byte length");
    result.padding = "x".repeat(targetBytes - fixedBytes);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBe(targetBytes);
    return result;
  }

  it.each([
    ["summary", { returnedDetail: "summary" }, 5 * 1024],
    ["full", { returnedDetail: "full" }, 12 * 1024],
    ["downgraded full", { requestedDetail: "full", returnedDetail: "summary" }, 5 * 1024],
    ["legacy (no returnedDetail)", {}, 5 * 1024],
  ] as const)("%s receipts forward at the ceiling and fail loud one byte past it", async (_label, detail, limit) => {
    for (const targetBytes of [limit, limit + 1]) {
      const native = starcastReceiptAtUtf8Bytes(targetBytes, { ...detail });
      mockClient({
        executeIdentityBoundOps: vi.fn(async () => ({ status: "ok", terminalState: "applied", results: [native] })),
      });
      const result = (await tool("summer_starcast").handler({ ...ARGS.summer_starcast })) as Response;
      if (targetBytes === limit) {
        expect(result.isError).toBeUndefined();
        expect(Buffer.byteLength(text(result), "utf8")).toBe(limit);
        expect(JSON.parse(text(result))).toEqual(native);
      } else {
        expect(result.isError).toBe(true);
        expect(Buffer.byteLength(text(result), "utf8")).toBeLessThan(512);
        expect(JSON.parse(text(result))).toMatchObject({
          ok: false,
          op: "Starcast3D",
          failure_reason: "starcast_result_exceeded_byte_limit",
          readOnly: true,
          returnedDetail: limit === 12 * 1024 ? "full" : "summary",
          actualBytes: limit + 1,
          limitBytes: limit,
        });
      }
    }
  });
});

describe("compact-result byte boundary", () => {
  it.each(COMPACT_TOOL_NAMES)("%s forwards 5119 bytes but fails loud at 5120", async (name) => {
    const { op, mutation, failure } = OPS[name];
    for (const targetBytes of [5119, 5120]) {
      const native = nativeResultAtUtf8Bytes(op, targetBytes);
      mockClient({
        executeIdentityBoundOps: vi.fn(async (ops: Record<string, unknown>[]) =>
          ops[0]?.op === op
            ? { status: "ok", terminalState: "applied", results: [native] }
            : okReceipt(ops)),
      });
      const result = (await tool(name).handler({ ...ARGS[name] })) as Response;
      if (targetBytes === 5119) {
        expect(result.isError).toBeUndefined();
        expect(Buffer.byteLength(text(result), "utf8")).toBe(5119);
        expect(JSON.parse(text(result))).toEqual(native);
      } else {
        expect(result.isError).toBe(true);
        expect(Buffer.byteLength(text(result), "utf8")).toBeLessThan(512);
        const envelope = JSON.parse(text(result)) as Record<string, unknown>;
        expect(envelope).toMatchObject({ ok: false, op, failure_reason: failure, actualBytes: 5120, limitBytes: 5120 });
        // A mutation has already landed and been saved by the time the receipt
        // is judged oversized — the envelope must say so and forbid blind retry.
        if (mutation) {
          expect(envelope).toMatchObject({ mutationApplied: true, saved: true, retrySafe: false });
        } else {
          expect(envelope).toMatchObject({ readOnly: true });
        }
      }
    }
  });
});

describe("schema-level validation (rejected by the host before the handler runs)", () => {
  it("subjectPaths refuse duplicates and the combined UTF-8 cap in the schema itself", () => {
    const align = input(tool("summer_align_distribute_3d"), "subjectPaths");
    expect(align.safeParse(["./A", "./B"]).success).toBe(true);
    expect(align.safeParse(["./A", " ./A "]).success).toBe(false);
    // 16 paths x 255 bytes passes the per-path cap but blows the 1536-byte combined cap.
    const wide = Array.from({ length: 16 }, (_, index) => `./${"x".repeat(250)}${index.toString(36).padStart(3, "0")}`);
    expect(align.safeParse(wide).success).toBe(false);
  });

  it("paths are capped in UTF-8 bytes, not UTF-16 code units", () => {
    // 200 three-byte characters: 200 code units (passes .max(256)), 600 bytes (fails the engine cap).
    const multiByte = "./" + "€".repeat(200);
    expect(input(tool("summer_test_placement"), "subjectPath").safeParse(multiByte).success).toBe(false);
    expect(input(tool("summer_test_placement"), "scenePath").safeParse("res://" + "€".repeat(300)).success).toBe(false);
    expect(input(tool("summer_test_placement"), "subjectPath").safeParse("./Props/Crate").success).toBe(true);
  });

  it("handler-level argument rejections are classified input (nothing sent), never transport", async () => {
    const { executeIdentityBoundOps } = mockClient();
    const result = (await tool("summer_snap_to_surface").handler({ ...ARGS.summer_snap_to_surface, gap: 21 })) as Response;
    expect(result.isError).toBe(true);
    const body = JSON.parse(text(result)) as Record<string, unknown>;
    expect(body.failure_reason).toBe("invalid_input");
    expect(body.sent).toBe(false);
    expect(text(result)).not.toContain("may have partially applied");
    expect(executeIdentityBoundOps).not.toHaveBeenCalled();
  });
});
