import { describe, expect, it, vi } from "vitest";
import {
  executePlacementBatch,
  instantiateScene,
  runBatch,
  splitInstantiatePlacement,
  summarizeTrace,
  traceEnvelope,
} from "./placement-batch.js";
import { FALLBACK_SINGLE_ONLY_OPS } from "../capability-skew.js";
import { sceneMutationOps } from "./engine-ops.js";

type Op = Record<string, unknown>;

/** Engine stand-in: InstantiateScene reports `<parent>/<name>` (or a renamed
 *  path from `renames`), everything else succeeds; `failOn` fails one op kind. */
function fakeEngine(options: { renames?: Record<string, string>; failOn?: (op: Op) => string | null; noNodePath?: boolean } = {}) {
  const requests: Op[][] = [];
  const send = vi.fn(async (chunk: Op[]) => {
    requests.push(chunk);
    const results = chunk.map((op) => {
      const failure = options.failOn?.(op);
      if (failure) return { ok: false, op: op.op, error: failure };
      if (op.op === "InstantiateScene" && !options.noNodePath) {
        const requested = `${String(op.parent).replace(/^\.\//, "")}/${String(op.name)}`;
        return { ok: true, op: op.op, meta: { nodePath: options.renames?.[requested] ?? requested } };
      }
      return { ok: true, op: op.op };
    });
    const failed = results.find((r) => r.ok === false);
    return failed
      ? { status: "error", error: failed.error, results }
      : { status: "ok", terminalState: "applied", results };
  });
  return { send, requests };
}

const piece = (name: string, extra: Op = {}): Op => ({
  op: "InstantiateScene",
  parent: "./Facade",
  scene: "res://kit/wall.tscn",
  name,
  ...extra,
});

describe("splitInstantiatePlacement", () => {
  it("turns position/rotation/scale into SetProp values and strips them from the engine op", () => {
    const split = splitInstantiatePlacement(
      piece("Wall", { position: [1, 0, 2], rotation_degrees: "Vector3(0, 90, 0)", scale: [1, 1, 1] }),
      "ops[0]"
    );
    expect(split.op).toEqual(piece("Wall"));
    expect(split.props).toEqual([
      { key: "rotation_degrees", value: "Vector3(0, 90, 0)" },
      { key: "scale", value: "Vector3(1, 1, 1)" },
      { key: "position", value: "Vector3(1, 0, 2)" },
    ]);
  });

  it("accepts a full Transform3D and rejects ambiguous or malformed placement", () => {
    expect(
      splitInstantiatePlacement(piece("W", { transform: "Transform3D(1,0,0, 0,1,0, 0,0,1, 0,5,0)" }), "x").props
    ).toEqual([{ key: "transform", value: "Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 0)" }]);
    expect(() => splitInstantiatePlacement(piece("W", { transform: "Transform3D(1,0,0)" }), "ops[2]")).toThrow(/ops\[2\]\.transform/);
    expect(() =>
      splitInstantiatePlacement(piece("W", { transform: "Transform3D(1,0,0, 0,1,0, 0,0,1, 0,5,0)", position: [0, 0, 0] }), "x")
    ).toThrow(/either transform/);
    expect(() => splitInstantiatePlacement(piece("W", { target_size: 2, scale: [2, 2, 2] }), "x")).toThrow(/target_size/);
    expect(() => splitInstantiatePlacement(piece("W", { position: [0, Number.NaN, 0] }), "x")).toThrow(/position/);
    expect(() => splitInstantiatePlacement(piece("W", { position: { x: 1 } }), "x")).toThrow(/position/);
  });

  it("leaves an op without placement fields untouched", () => {
    const op = piece("W", { target_size: 2 });
    expect(splitInstantiatePlacement(op, "x")).toEqual({ op, props: [] });
  });
});

describe("executePlacementBatch", () => {
  it("sets each piece's transform on the receipt's node path before any later op", async () => {
    const { send, requests } = fakeEngine({ renames: { "Facade/Wall": "Facade/Wall_1" } });
    const ops = sceneMutationOps([
      piece("Wall", { position: [1, 0, 0], rotation_degrees: [0, 180, 0] }),
      piece("Window", { position: [2, 0, 0] }),
      { op: "SetProp", path: "Facade", key: "visible", value: true },
    ]);
    const trace = await executePlacementBatch(send, ops, FALLBACK_SINGLE_ONLY_OPS, 3);
    expect(trace.failed).toBe(false);
    // The held-back transforms ride along with the next batchable op.
    expect(requests.map((chunk) => chunk.map((op) => op.op))).toEqual([
      ["InstantiateScene"],
      ["InstantiateScene"],
      ["SetProp", "SetProp", "SetProp", "SetProp"],
      ["SaveScene"],
    ]);
    // The rename is followed, and placement fields never reach the engine op.
    expect(requests[2]).toEqual([
      { op: "SetProp", path: "Facade/Wall_1", key: "rotation_degrees", value: "Vector3(0, 180, 0)" },
      { op: "SetProp", path: "Facade/Wall_1", key: "position", value: "Vector3(1, 0, 0)" },
      { op: "SetProp", path: "Facade/Window", key: "position", value: "Vector3(2, 0, 0)" },
      { op: "SetProp", path: "Facade", key: "visible", value: true },
    ]);
    expect(requests[0]![0]).not.toHaveProperty("position");
    expect(trace.entries.map((entry) => [entry.index, entry.op, entry.derived ?? null])).toEqual([
      [0, "InstantiateScene", null],
      [0, "SetProp", "transform"],
      [0, "SetProp", "transform"],
      [1, "InstantiateScene", null],
      [1, "SetProp", "transform"],
      [2, "SetProp", null],
      [null, "SaveScene", null],
    ]);
  });

  it("validates every op before sending anything", async () => {
    const { send } = fakeEngine();
    await expect(
      executePlacementBatch(send, [piece("A", { position: [0, 0, 0] }), piece("B", { position: "nope" })], FALLBACK_SINGLE_ONLY_OPS)
    ).rejects.toThrow(/ops\[1\]\.position/);
    expect(send).not.toHaveBeenCalled();
  });

  // Field evidence (proof run, 2026-10-04): a 28-piece batch took 57 engine
  // requests (2N + 1).
  it("costs N + 2 requests for N placed pieces, at most 200 transforms per request", async () => {
    const { send, requests } = fakeEngine();
    const ops = Array.from({ length: 250 }, (_, i) => piece(`P${i}`, { position: [i, 0, 0] }));
    const trace = await executePlacementBatch(send, sceneMutationOps(ops), FALLBACK_SINGLE_ONLY_OPS, ops.length);
    expect(trace.failed).toBe(false);
    // 250 instances, then 200 + 50 transforms, then the save.
    expect(requests).toHaveLength(253);
    expect(requests.slice(0, 250).every((chunk) => chunk.length === 1 && chunk[0]!.op === "InstantiateScene")).toBe(true);
    expect(requests[250]!.map((op) => op.op)).toEqual(Array(200).fill("SetProp"));
    expect(requests[251]).toHaveLength(50);
    expect(requests[252]).toEqual([{ op: "SaveScene" }]);
    expect(summarizeTrace(trace, ops)).toMatchObject({ ok: true, requests: 253, applied: 250, saved: true });
  });

  it("lands a piece's transform before a later op that reads it", async () => {
    const { send, requests } = fakeEngine();
    const ops = sceneMutationOps([
      piece("Crate", { position: [0, 2, 0] }),
      { op: "SnapToSurface", subject_path: "Facade/Crate", direction: [0, -1, 0] },
    ]);
    await executePlacementBatch(send, ops, FALLBACK_SINGLE_ONLY_OPS, 2);
    expect(requests.map((chunk) => chunk.map((op) => op.op))).toEqual([["InstantiateScene"], ["SetProp", "SnapToSurface"], ["SaveScene"]]);
  });

  it("stops at a failure, reports what applied, and never saves", async () => {
    const { send, requests } = fakeEngine({ failOn: (op) => (op.name === "B" ? "parent not found: ./Facade" : null) });
    const ops = [piece("A", { position: [0, 0, 0] }), piece("B", { position: [1, 0, 0] }), piece("C")];
    const trace = await executePlacementBatch(send, sceneMutationOps(ops), FALLBACK_SINGLE_ONLY_OPS, ops.length);
    expect(trace.failed).toBe(true);
    // A, the failing B, then A's transform: the created piece is not left at the origin.
    expect(requests.map((chunk) => chunk.map((op) => String(op.name ?? op.path)))).toEqual([["A"], ["B"], ["Facade/A"]]);
    expect(trace.error).toContain("parent not found");
    expect(trace.error).toContain("NOT saved");
    const summary = summarizeTrace(trace, ops);
    expect(summary).toMatchObject({ ok: false, ops: 3, applied: 1, failed: 1, not_sent: 1, saved: false, created: ["Facade/A"] });
    expect(summary.failures).toEqual([{ index: 1, op: "InstantiateScene", error: "parent not found: ./Facade" }]);
    expect(traceEnvelope(trace)).toMatchObject({ ok: false, status: "error" });
  });

  it("fails loudly when an instantiate receipt has no node path instead of guessing one", async () => {
    const { send, requests } = fakeEngine({ noNodePath: true });
    const trace = await executePlacementBatch(send, sceneMutationOps([piece("A", { position: [1, 2, 3] })]), FALLBACK_SINGLE_ONLY_OPS, 1);
    expect(trace.failed).toBe(true);
    expect(requests).toHaveLength(1);
    expect(trace.entries[0]).toMatchObject({ ok: false, failureReason: "instantiate_receipt_missing_node_path" });
  });
});

describe("summary receipts stay compact", () => {
  it("summarizes a 682-piece batch under 5 KB and declares the cut", async () => {
    const { send } = fakeEngine();
    const ops = Array.from({ length: 682 }, (_, i) => piece(`Piece_${i}`, { position: [i, 0, 0] }));
    const trace = await executePlacementBatch(send, sceneMutationOps(ops), FALLBACK_SINGLE_ONLY_OPS, ops.length);
    const summary = summarizeTrace(trace, ops);
    expect(Buffer.byteLength(JSON.stringify(summary), "utf8")).toBeLessThan(5 * 1024);
    expect(summary).toMatchObject({ ok: true, ops: 682, applied: 682, failed: 0, saved: true, created_total: 682 });
    expect((summary.truncated as Record<string, unknown>).created).toMatchObject({ total: 682 });
    expect(summary.truncation_note).toContain("split the batch");
  });

  it("lists renames so unlisted paths are predictable", async () => {
    const { send } = fakeEngine({ renames: { "Facade/A": "Facade/A_1" } });
    const ops = [piece("A"), piece("B")];
    const trace = await executePlacementBatch(send, sceneMutationOps(ops), FALLBACK_SINGLE_ONLY_OPS, ops.length);
    expect(summarizeTrace(trace, ops).renamed).toEqual([{ index: 0, requested: "A", actual: "Facade/A_1" }]);
  });
});

describe("runBatch", () => {
  function client() {
    const engine = fakeEngine();
    return {
      engine,
      client: {
        executeIdentityBoundOps: vi.fn((ops: Op[]) => engine.send(ops)),
        executeOps: vi.fn((ops: Op[]) => engine.send(ops)),
      },
    };
  }

  it("keeps the previous path for plain batches with a full receipt", async () => {
    const { client: c, engine } = client();
    const result = (await runBatch(c, { scenePath: "res://a.tscn", ops: [piece("A"), { op: "SetProp", path: "A", key: "visible", value: false }] })) as Op;
    expect(engine.requests.map((chunk) => chunk.map((op) => op.op))).toEqual([["InstantiateScene"], ["SetProp"], ["SaveScene"]]);
    expect(result.requests).toBe(3);
    expect(c.executeIdentityBoundOps).toHaveBeenCalledWith(expect.any(Array), { groupUndo: true, scenePath: "res://a.tscn" });
  });

  it("returns the compact summary when asked", async () => {
    const { client: c } = client();
    const result = (await runBatch(c, {
      scenePath: "res://a.tscn",
      ops: [piece("A", { position: [0, 1, 0] })],
      receipt: "summary",
    })) as Op;
    expect(result).toMatchObject({ ok: true, receipt: "summary", ops: 1, applied: 1, created: ["Facade/A"], saved: true });
    expect(result).not.toHaveProperty("receipts");
  });

  it("requires scenePath for scene ops", async () => {
    const { client: c } = client();
    await expect(runBatch(c, { ops: [piece("A")] })).rejects.toThrow(/scenePath/);
  });
});

describe("instantiateScene", () => {
  it("instances, sets the transform on the reported path, then saves", async () => {
    const engine = fakeEngine({ renames: { "World/Lamp": "World/Lamp_2" } });
    const c = { executeIdentityBoundOps: vi.fn((ops: Op[]) => engine.send(ops)) };
    const result = (await instantiateScene(c, {
      scenePath: "res://a.tscn",
      parent: "./World",
      scene: "res://lamp.tscn",
      name: "Lamp",
      position: [0, 3, 0.1],
      rotation_degrees: [0, 90, 0],
    })) as Op;
    expect(engine.requests.map((chunk) => chunk.map((op) => `${op.op}:${String(op.path ?? op.name ?? "")}`))).toEqual([
      ["InstantiateScene:Lamp"],
      ["SetProp:World/Lamp_2", "SetProp:World/Lamp_2"],
      ["SaveScene:"],
    ]);
    expect(result).not.toHaveProperty("receipts");
    expect(result.placement).toEqual({
      nodePath: "World/Lamp_2",
      applied: true,
      fields: ["position", "rotation_degrees"],
      space: "parent_local",
    });
  });

  it("is a single InstantiateScene plus save without placement fields", async () => {
    const engine = fakeEngine();
    const c = { executeIdentityBoundOps: vi.fn((ops: Op[]) => engine.send(ops)) };
    await instantiateScene(c, { scenePath: "res://a.tscn", parent: "./World", scene: "res://lamp.tscn", name: "Lamp" });
    expect(engine.requests.map((chunk) => chunk.map((op) => op.op))).toEqual([["InstantiateScene"], ["SaveScene"]]);
  });
});
