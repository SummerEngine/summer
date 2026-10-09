import { describe, expect, it, vi } from "vitest";

vi.mock("../server.js", () => ({ getClient: vi.fn(), resetClient: vi.fn() }));
vi.mock("../../core/telemetry.js", () => ({ recordMcpSession: vi.fn() }));

import { getClient } from "../server.js";
import { registerSpatialTools } from "./spatial-tools.js";
import { snapToSurface, type SnapToSurfaceArgs } from "../../core/capabilities/surface-snap.js";
import { SNAP_MESH_ARGS_TOKEN, buildSnapMeshScript, snapMeshProbeTemplate } from "../../core/capabilities/surface-snap-mesh.js";
import { gdscriptStructureProblems } from "../../test-helpers/gdscript-structure.js";
import { dispatchTool } from "../../core/capabilities/tool-dispatch.js";
import { findTscnNode, parseTscn } from "../../core/capabilities/tscn.js";
import { parseTransform3D } from "../../core/capabilities/math3d.js";

const SCENE = "res://town.tscn";

/**
 * A one-axis fake of SurfaceSnapOps::snap_to_surface for a downward cast:
 * the subject (origin at its centre, half height H) lives under a parent
 * scaled 2x and raised 0.5 m; supports are horizontal tops. It follows the
 * engine's logic: overlap -> back off upward (0.05 doubling) -> sweep down ->
 * hitTravel measured from the ORIGINAL pose -> gap > hitTravel fails with
 * gap_exceeds_hit_travel, even when the backed-off sweep verified the space.
 */
class FakeSnapEngine {
  readonly sent: Array<Array<Record<string, unknown>>> = [];
  local: [number, number, number];
  disk: string;
  starcastContacts?: string[];
  readonly options: { opKinds?: string[] };

  constructor(
    localY: number,
    readonly supports: Array<{ path: string; top: number }>,
    readonly half = 0.145,
    options: { opKinds?: string[]; blockedBelowMax?: boolean } = {}
  ) {
    this.local = [1.25, localY, 2];
    this.options = options;
    this.blocked = options.blockedBelowMax ?? false;
    this.disk = this.pack();
  }
  private readonly blocked: boolean;

  worldY(localY = this.local[1]) {
    return 2 * localY + 0.5;
  }

  pack(): string {
    const [x, y, z] = this.local;
    return `[gd_scene format=3]

[node name="Root" type="Node3D"]

[node name="Ground" type="Node3D" parent="."]

[node name="Floor" type="StaticBody3D" parent="Ground"]

[node name="Props" type="Node3D" parent="."]
transform = Transform3D(2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0.5, 0)

[node name="Bottle" type="RigidBody3D" parent="Props"]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, ${x}, ${y}, ${z})
`;
  }

  private overlapping(bottom: number) {
    return this.supports.filter((s) => bottom < s.top - 1e-9);
  }

  private snap(op: Record<string, unknown>): Record<string, unknown> {
    const gap = Number(op.gap);
    const max = Number(op.max_distance);
    const bottom = this.worldY() - this.half;
    let backoff = 0;
    if (this.overlapping(bottom).length > 0) {
      if (this.blocked) {
        return { ok: false, op: "SnapToSurface", failure_reason: "overlap_recovery_exceeded", error: "Subject overlap could not be cleared opposite direction within max_distance", evidence: "physics", initiallyOverlapping: true, backoffDistance: max };
      }
      backoff = Math.min(0.05, max);
      while (this.overlapping(bottom + backoff).length > 0) {
        if (backoff >= max || this.blocked) {
          return { ok: false, op: "SnapToSurface", failure_reason: "overlap_recovery_exceeded", error: "Subject overlap could not be cleared opposite direction within max_distance", evidence: "physics", initiallyOverlapping: true, backoffDistance: max };
        }
        backoff = Math.min(max, backoff * 2);
      }
    }
    const start = bottom + backoff;
    const below = this.supports.filter((s) => s.top <= start + 1e-9).sort((a, b) => b.top - a.top)[0];
    if (!below || start - below.top > max) return { ok: false, op: "SnapToSurface", failure_reason: "surface_not_found", error: "No support surface was found within max_distance" };
    const hitTravel = -backoff + (start - below.top);
    if (gap > hitTravel + 1e-12) {
      return { ok: false, op: "SnapToSurface", failure_reason: "gap_exceeds_hit_travel", error: "Requested gap would move opposite the verified sweep into untested space", evidence: "physics", hitTravel: Math.round(hitTravel * 1000) / 1000, requestedGap: gap };
    }
    const beforeY = this.worldY();
    const newWorldY = beforeY - (hitTravel - gap);
    this.local = [this.local[0], (newWorldY - 0.5) / 2, this.local[2]];
    return { ok: true, op: "SnapToSurface", before: { origin: [2.5, beforeY, 4] }, after: { origin: [2.5, newWorldY, 4] }, supportPath: below.path, finalGap: gap, evidence: "physics" };
  }

  private apply(op: Record<string, unknown>): Record<string, unknown> {
    switch (op.op) {
      case "SnapToSurface":
        return this.snap(op);
      case "SaveScene":
        this.disk = this.pack();
        return { ok: true, op: "SaveScene" };
      case "SetProp": {
        const match = /^Vector3\(([^,]+),([^,]+),([^)]+)\)$/.exec(String(op.value).replace(/\s/g, ""));
        if (op.key !== "position" || !match) return { ok: false, op: "SetProp", error: "bad SetProp" };
        this.local = [Number(match[1]), Number(match[2]), Number(match[3])];
        return { ok: true, op: "SetProp" };
      }
      case "Starcast3D": {
        const bottom = this.worldY() - this.half;
        const contacts = this.starcastContacts ?? this.supports.filter((s) => bottom <= s.top + 0.001).map((s) => s.path);
        return {
          ok: true,
          op: "Starcast3D",
          readOnly: true,
          subject: { path: "Props/Bottle", position: [2.5, this.worldY(), 4], size: [0.2, this.half * 2, 0.2] },
          grounded: contacts.length > 0,
          contactStatus: contacts.length ? "contact_or_overlap" : "none_detected",
          contacts,
          directions: { down: { status: "blocked", distance: 0, object: contacts[0] ?? null, evidence: "physics" } },
        };
      }
      default:
        return { ok: false, op: String(op.op), error: `unknown op: ${String(op.op)}` };
    }
  }

  getEngineCapabilities = () => (this.options.opKinds ? { opKinds: this.options.opKinds } : undefined);
  getEngineVersion = () => "0.5.70-fake";

  executeIdentityBoundOps = async (ops: Array<Record<string, unknown>>): Promise<unknown> => {
    this.sent.push(ops);
    const results: Array<Record<string, unknown>> = [];
    for (const op of ops) {
      const r = this.apply(op);
      results.push(r);
      if (r.ok === false) break;
    }
    const failed = results.some((r) => r.ok === false);
    return { ok: !failed, status: failed ? "error" : "ok", terminalState: "applied", results };
  };

  readProjectFile = async () => ({ ok: true, data: { content: this.disk, encoding: "utf-8", truncated: false } });

  ops(): string[] {
    return this.sent.map((request) => request.map((op) => String(op.op)).join("+"));
  }

  savedLocalY(): number {
    const node = findTscnNode(parseTscn(this.disk), "Props/Bottle")!;
    return parseTransform3D(node.props.find((p) => p.key === "transform")!.value)!.origin[1];
  }
}

const FLOOR = [{ path: "Ground/Floor", top: 0 }];
const args = (extra: Partial<SnapToSurfaceArgs> = {}): SnapToSurfaceArgs => ({
  scenePath: SCENE,
  subjectPath: "./Props/Bottle",
  direction: [0, -1, 0],
  maxDistance: 20,
  gap: 0,
  alignUp: false,
  ...extra,
});
// World y 0.095 with half height 0.145: the bottle's bottom is 5 cm inside the floor.
const SUNK_5CM = -0.2025;

describe("summer_snap_to_surface: sunk props", () => {
  it("the fake reproduces the engine failure: a sunk prop gets gap_exceeds_hit_travel from the engine op", async () => {
    const fake = new FakeSnapEngine(SUNK_5CM, FLOOR);
    const raw = (await fake.executeIdentityBoundOps([{ op: "SnapToSurface", gap: 0, max_distance: 20 }])) as { results: Array<Record<string, unknown>> };
    expect(raw.results[0]).toMatchObject({ failure_reason: "gap_exceeds_hit_travel", hitTravel: -0.05 });
  });

  it("lifts it by the overlap depth plus a margin, settles it on the floor, and saves", async () => {
    const fake = new FakeSnapEngine(SUNK_5CM, FLOOR);
    const result = (await snapToSurface(fake, args())) as { ok?: boolean; results: Array<Record<string, unknown>> };
    expect(result.ok).not.toBe(false);
    const snap = result.results.find((r) => r.op === "SnapToSurface")!;
    expect(snap).toMatchObject({ ok: true, supportPath: "Ground/Floor" });
    expect(snap.recovery).toMatchObject({ recovered_from: "gap_exceeds_hit_travel", lifted_by: 0.07, start_contacts: ["Ground/Floor"] });
    expect(String((snap.warnings as string[]).join(" "))).toContain("lifted 0.07 m");
    // Bottom exactly on the floor: world y 0.145 -> local (0.145 - 0.5) / 2.
    expect(fake.worldY() - fake.half).toBeCloseTo(0, 9);
    expect(fake.savedLocalY()).toBeCloseTo(-0.1775, 9);
    // The local lift was mapped through the parent's 2x scale (0.035 local for 0.07 world).
    expect(fake.sent[3]![0]).toEqual({ op: "SetProp", path: "./Props/Bottle", key: "position", value: "Vector3(1.25, -0.1675, 2)" });
    expect(fake.ops()).toEqual(["SnapToSurface", "Starcast3D", "SaveScene", "SetProp+SnapToSurface", "SaveScene"]);
  });

  it("refuses to lift deeper than the subject's own extent, names the support and says what to do", async () => {
    const fake = new FakeSnapEngine(-0.4, FLOOR); // world y -0.3: bottom 0.445 below the floor
    const result = (await snapToSurface(fake, args())) as { ok: boolean; error: string; results: Array<Record<string, unknown>> };
    expect(result.ok).toBe(false);
    const snap = result.results[0]!;
    expect(snap).toMatchObject({ failure_reason: "gap_exceeds_hit_travel", start_overlap: true, blocking: ["Ground/Floor"] });
    expect(String(snap.next_step)).toContain("Raise it about 0.465 m");
    expect(result.error).toContain("Ground/Floor");
    expect(result.error).toContain("Next step:");
    expect(fake.ops()).toEqual(["SnapToSurface", "Starcast3D"]);
    expect(fake.savedLocalY()).toBe(-0.4);
  });

  it("restores the original position when the lifted pose settles on something it was not sunk into", async () => {
    const fake = new FakeSnapEngine(SUNK_5CM, [{ path: "Ground/Floor", top: 0 }, { path: "Counter/Board", top: 0.01 }]);
    fake.starcastContacts = ["Ground/Floor"]; // the board was not reported as a contact
    const result = (await snapToSurface(fake, args())) as { ok: boolean; error: string; results: Array<Record<string, unknown>> };
    expect(result.ok).toBe(false);
    expect(result.results[0]!.recovery).toMatchObject({ settled_on: "Counter/Board", restored: true });
    expect(result.error).toContain("settled on Counter/Board");
    expect(fake.local[1]).toBe(SUNK_5CM);
    expect(fake.savedLocalY()).toBe(SUNK_5CM);
  });

  it("still lifts on an engine without Starcast3D when the contact is behind the start pose", async () => {
    const fake = new FakeSnapEngine(SUNK_5CM, FLOOR, 0.145, { opKinds: ["SnapToSurface", "SetProp", "SaveScene"] });
    const result = (await snapToSurface(fake, args())) as { results: Array<Record<string, unknown>> };
    expect(result.results.find((r) => r.op === "SnapToSurface")).toMatchObject({ ok: true, supportPath: "Ground/Floor" });
    expect(fake.ops()).not.toContain("Starcast3D");
  });
});

describe("summer_snap_to_surface: failures name the obstacle and the next step", () => {
  it("overlap_recovery_exceeded: start_overlap, the blocking node, and a concrete next step", async () => {
    const fake = new FakeSnapEngine(SUNK_5CM, FLOOR, 0.145, { blockedBelowMax: true });
    const result = (await snapToSurface(fake, args())) as { ok: boolean; error: string; results: Array<Record<string, unknown>> };
    expect(result.ok).toBe(false);
    expect(result.results[0]).toMatchObject({ failure_reason: "overlap_recovery_exceeded", start_overlap: true, blocking: ["Ground/Floor"] });
    expect(String(result.results[0]!.next_step)).toContain("Move it clear of Ground/Floor");
    expect(fake.ops()).toEqual(["SnapToSurface", "Starcast3D"]);
  });

  it("a gap larger than the distance to the surface (no overlap) is explained, not lifted", async () => {
    const fake = new FakeSnapEngine(-0.1675, FLOOR); // bottom 2 cm above the floor
    const result = (await snapToSurface(fake, args({ gap: 0.05 }))) as { ok: boolean; results: Array<Record<string, unknown>> };
    expect(result.ok).toBe(false);
    expect(result.results[0]).toMatchObject({ failure_reason: "gap_exceeds_hit_travel", start_overlap: false });
    expect(String(result.results[0]!.next_step)).toContain("Pass gap of at most 0.02");
    expect(fake.ops()).toEqual(["SnapToSurface", "Starcast3D"]);
  });

  it("a normal snap is unchanged: one SnapToSurface, one SaveScene, no starcast", async () => {
    const fake = new FakeSnapEngine(-0.1675, FLOOR);
    await snapToSurface(fake, args());
    expect(fake.ops()).toEqual(["SnapToSurface", "SaveScene"]);
    expect(fake.worldY() - fake.half).toBeCloseTo(0, 9);
  });

  it("MCP face: the failure text carries the diagnosis and next step", async () => {
    const fake = new FakeSnapEngine(-0.4, FLOOR);
    vi.mocked(getClient).mockResolvedValue(fake as never);
    const result = (await spatialTool("summer_snap_to_surface").handler({ scenePath: SCENE, subjectPath: "./Props/Bottle", direction: [0, -1, 0], maxDistance: 20, gap: 0, alignUp: false })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("gap_exceeds_hit_travel");
    expect(result.content[0]!.text).toContain("Ground/Floor");
    expect(result.content[0]!.text).toContain("Next step:");
  });

  it("MCP and CLI faces both run the lift", async () => {
    const mcpFake = new FakeSnapEngine(SUNK_5CM, FLOOR);
    vi.mocked(getClient).mockResolvedValue(mcpFake as never);
    const mcp = (await spatialTool("summer_snap_to_surface").handler({ scenePath: SCENE, subjectPath: "./Props/Bottle", direction: [0, -1, 0], maxDistance: 20, gap: 0, alignUp: false })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(mcp.isError).toBeFalsy();
    expect(JSON.parse(mcp.content[0]!.text)).toMatchObject({ ok: true, recovery: { lifted_by: 0.07 } });

    const cliFake = new FakeSnapEngine(SUNK_5CM, FLOOR);
    const cli = (await dispatchTool("snap-to-surface", { scenePath: SCENE, subjectPath: "./Props/Bottle" }, { engine: async () => cliFake as never })) as {
      results: Array<Record<string, unknown>>;
    };
    expect(cli.results.find((r) => r.op === "SnapToSurface")).toMatchObject({ ok: true, supportPath: "Ground/Floor" });
    expect(cliFake.savedLocalY()).toBeCloseTo(-0.1775, 9);
  });
});

/**
 * A fake for a prop WITHOUT a collider over a ground PlaneMesh (a fern).
 * The engine op falls back to visual_aabb: the subject's AABB sits
 * inside a big obstacle AABB (a birch's crown box reaching the ground), so
 * no back-off clears it and it answers overlap_recovery_exceeded, while the
 * starcast reports an overlap with no named contact ("(unnamed)"). The
 * RunSceneScript answers follow the visible-mesh probe's contract
 * (surface-snap-mesh.ts) for a flat support: travel = the subject's lowest
 * vertex minus the plane's top. Same parent as FakeSnapEngine (2x, +0.5 m).
 */
class FakeMeshSnapEngine {
  readonly sent: Array<Array<Record<string, unknown>>> = [];
  readonly probes: Array<Record<string, unknown>> = [];
  local: [number, number, number];
  disk: string;
  unsaved = false;
  /** Overrides the probe answer of call N (0-based). */
  probeOverride: Record<number, (answer: Record<string, unknown>) => Record<string, unknown>> = {};

  constructor(
    localY: number,
    readonly planeTop = 0,
    readonly bottomAboveOrigin = 0.045,
    readonly engine: { seatOnAabbTop?: number } = {}
  ) {
    this.local = [1.25, localY, 2];
    this.disk = this.pack();
  }

  worldY(localY = this.local[1]) {
    return 2 * localY + 0.5;
  }

  bottom() {
    return this.worldY() + this.bottomAboveOrigin;
  }

  pack(): string {
    const [x, y, z] = this.local;
    return `[gd_scene format=3]\n\n[node name="Root" type="Node3D"]\n\n[node name="Ground" type="Node3D" parent="."]\n\n[node name="Tile_3" type="MeshInstance3D" parent="Ground"]\n\n[node name="Props" type="Node3D" parent="."]\ntransform = Transform3D(2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0.5, 0)\n\n[node name="Fern" type="Node3D" parent="Props"]\ntransform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, ${x}, ${y}, ${z})\n`;
  }

  private literal(v: [number, number, number]) {
    return `Vector3(${v.join(", ")})`;
  }

  private probe(source: string): Record<string, unknown> {
    const line = source.split("\n").find((l) => l.startsWith("const ARGS_B64 = "))!;
    const args = JSON.parse(Buffer.from(JSON.parse(line.slice("const ARGS_B64 = ".length)) as string, "base64").toString("utf8")) as Record<string, unknown>;
    this.probes.push(args);
    this.unsaved = true; // RunSceneScript marks the tab unsaved after every run
    const travel = this.bottom() - this.planeTop;
    const shift = travel - Number(args.gap);
    const after: [number, number, number] = [this.local[0], this.local[1] - shift / 2, this.local[2]];
    const answer: Record<string, unknown> = {
      ok: true,
      found: travel <= Number(args.max_distance),
      travel,
      shift,
      support: "Ground/Tile_3",
      support_has_collider: false,
      subject_colliders: 0,
      hit_point: [2.5, this.planeTop, 4],
      hit_normal: [0, 1, 0],
      contact_from: "subject_vertex",
      extent: 0.4,
      position: this.literal(this.local),
      position_after: this.literal(after),
      origin_before: [2.5, this.worldY(), 4],
      origin_after: [2.5, this.worldY() - shift, 4],
      samples: 412,
      subject_vertices: 412,
      support_meshes: 2,
      support_triangles: 4,
      skipped: { screen_space: 1, not_mesh: 0 },
    };
    const override = this.probeOverride[this.probes.length - 1];
    return override ? override(answer) : answer;
  }

  private snap(op: Record<string, unknown>): Record<string, unknown> {
    if (this.engine.seatOnAabbTop !== undefined) {
      // A seat on an AABB top above the real surface (a bench's bounds).
      const beforeY = this.worldY();
      const newWorldY = this.engine.seatOnAabbTop - this.bottomAboveOrigin + Number(op.gap);
      this.local = [this.local[0], (newWorldY - 0.5) / 2, this.local[2]];
      return { ok: true, op: "SnapToSurface", before: { origin: [2.5, beforeY, 4] }, after: { origin: [2.5, newWorldY, 4] }, supportPath: "Lane3/Bench", finalGap: Number(op.gap), evidence: "visual_aabb", changed: true };
    }
    return { ok: false, op: "SnapToSurface", failure_reason: "overlap_recovery_exceeded", error: "Visual subject overlap could not be cleared opposite direction within max_distance", evidence: "visual_aabb", initiallyOverlapping: true, backoffDistance: Number(op.max_distance) };
  }

  private apply(op: Record<string, unknown>): Record<string, unknown> {
    switch (op.op) {
      case "SnapToSurface":
        return this.snap(op);
      case "SaveScene":
        this.disk = this.pack();
        this.unsaved = false;
        return { ok: true, op: "SaveScene" };
      case "SetProp": {
        const match = /^Vector3\(([^,]+),([^,]+),([^)]+)\)$/.exec(String(op.value).replace(/\s/g, ""));
        if (op.key !== "position" || !match) return { ok: false, op: "SetProp", error: "bad SetProp" };
        this.local = [Number(match[1]), Number(match[2]), Number(match[3])];
        this.unsaved = true;
        return { ok: true, op: "SetProp" };
      }
      case "RunSceneScript":
        if (!String(op.script_source).includes("TriangleMesh.new()")) return { ok: false, op: "RunSceneScript", error: "unexpected script" };
        return { ok: true, op: "RunSceneScript", ran: true, result: this.probe(String(op.script_source)) };
      case "Starcast3D":
        return { ok: true, op: "Starcast3D", readOnly: true, subject: { path: "Props/Fern", position: [2.5, this.worldY(), 4], size: [0.6, 0.4, 0.6] }, grounded: false, contactStatus: "contact_or_overlap", contacts: [], directions: { down: { status: "blocked", distance: 0, object: null, evidence: "visual_aabb" } } };
      default:
        return { ok: false, op: String(op.op), error: `unknown op: ${String(op.op)}` };
    }
  }

  getEngineCapabilities = () => undefined;
  getEngineVersion = () => "0.6.0-fake";

  executeIdentityBoundOps = async (ops: Array<Record<string, unknown>>): Promise<unknown> => {
    this.sent.push(ops);
    const results: Array<Record<string, unknown>> = [];
    for (const op of ops) {
      const r = this.apply(op);
      results.push(r);
      if (r.ok === false) break;
    }
    const failed = results.some((r) => r.ok === false);
    return { ok: !failed, status: failed ? "error" : "ok", terminalState: "applied", results };
  };

  readProjectFile = async () => ({ ok: true, data: { content: this.disk, encoding: "utf-8", truncated: false } });

  ops(): string[] {
    return this.sent.map((request) => request.map((op) => String(op.op)).join("+"));
  }

  savedLocalY(): number {
    const node = findTscnNode(parseTscn(this.disk), "Props/Fern")!;
    return parseTransform3D(node.props.find((p) => p.key === "transform")!.value)!.origin[1];
  }
}

const fernArgs = (extra: Partial<SnapToSurfaceArgs> = {}): SnapToSurfaceArgs => ({ ...args(extra), subjectPath: "./Props/Fern", ...extra });
// World y -0.01 with its lowest vertex 4.5 cm above its origin: 3.5 cm above the ground plane.
const FLOATING_3_5CM = -0.255;

describe("summer_snap_to_surface: props without colliders (visible-mesh fallback)", () => {
  it("the fake reproduces the engine failure: visual_aabb overlap_recovery_exceeded with no named contact", async () => {
    const fake = new FakeMeshSnapEngine(FLOATING_3_5CM);
    const raw = (await fake.executeIdentityBoundOps([{ op: "SnapToSurface", gap: 0, max_distance: 20 }])) as { results: Array<Record<string, unknown>> };
    expect(raw.results[0]).toMatchObject({ failure_reason: "overlap_recovery_exceeded", evidence: "visual_aabb" });
  });

  it("seats a collider-less prop on the plane's triangles, verifies the gap, saves, and says visual_mesh", async () => {
    const fake = new FakeMeshSnapEngine(FLOATING_3_5CM);
    const result = (await snapToSurface(fake, fernArgs())) as { ok?: boolean; results: Array<Record<string, unknown>> };
    expect(result.ok).not.toBe(false);
    const snap = result.results.find((r) => r.op === "SnapToSurface")!;
    expect(snap).toMatchObject({
      ok: true,
      evidence: "visual_mesh",
      supportPath: "Ground/Tile_3",
      finalGap: 0,
      hitTravel: 0.035,
      changed: true,
      engine: { evidence: "visual_aabb", failure_reason: "overlap_recovery_exceeded" },
      verify: { final_gap: 0, ok: true },
      evidenceDetails: { method: "visible_triangles", subjectColliders: 0, supportHasCollider: false },
    });
    expect((snap.warnings as string[]).join(" ")).toContain("no enabled collider");
    expect((snap.warnings as string[]).join(" ")).toContain("screen-space mesh");
    expect(fake.bottom()).toBeCloseTo(0, 9);
    expect(fake.savedLocalY()).toBeCloseTo(-0.2725, 9);
    expect(fake.unsaved).toBe(false);
    // Engine op, measure, one SetProp with the probe's position, verify, save. No starcast.
    expect(fake.ops()).toEqual(["SnapToSurface", "RunSceneScript", "SetProp", "RunSceneScript", "SaveScene"]);
    expect(fake.sent[2]![0]).toEqual({ op: "SetProp", path: "./Props/Fern", key: "position", value: "Vector3(1.25, -0.2725, 2)" });
    const probeOp = fake.sent[1]![0]!;
    expect(probeOp).toMatchObject({ op: "RunSceneScript", undo: "none", checkpoint: false });
    expect(fake.probes[0]).toEqual({ scene_path: SCENE, subject: "./Props/Fern", direction: [0, -1, 0], max_distance: 20, gap: 0 });
  });

  it("lifts a collider-less prop sunk into the plane out onto it, at the requested gap", async () => {
    const fake = new FakeMeshSnapEngine(-0.2725 - 0.01); // lowest vertex 2 cm below the plane
    const result = (await snapToSurface(fake, fernArgs({ gap: 0.005 }))) as { results: Array<Record<string, unknown>> };
    const snap = result.results.find((r) => r.op === "SnapToSurface")!;
    expect(snap).toMatchObject({ evidence: "visual_mesh", hitTravel: -0.02, finalGap: 0.005, verify: { ok: true } });
    expect((snap.warnings as string[]).join(" ")).toContain("started 0.02 m inside Ground/Tile_3");
    expect(fake.bottom()).toBeCloseTo(0.005, 9);
  });

  it("corrects a visual_aabb seat that rests on a box above the real surface", async () => {
    const fake = new FakeMeshSnapEngine(FLOATING_3_5CM, 0, 0.045, { seatOnAabbTop: 0.42 });
    const result = (await snapToSurface(fake, fernArgs())) as { results: Array<Record<string, unknown>> };
    const snap = result.results.find((r) => r.op === "SnapToSurface")!;
    expect(snap).toMatchObject({
      evidence: "visual_mesh",
      supportPath: "Ground/Tile_3",
      hitTravel: 0.42,
      engine: { evidence: "visual_aabb", supportPath: "Lane3/Bench", note: "the engine's AABB seat was corrected on triangles" },
      before: { origin: [2.5, -0.01, 4] },
    });
    expect(fake.bottom()).toBeCloseTo(0, 9);
    expect(fake.ops()).toEqual(["SnapToSurface", "SaveScene", "RunSceneScript", "SetProp", "RunSceneScript", "SaveScene"]);
  });

  it("keeps a visual_aabb seat the triangles confirm: one read, a clean save, no SetProp", async () => {
    const fake = new FakeMeshSnapEngine(FLOATING_3_5CM, 0, 0.045, { seatOnAabbTop: 0 });
    const result = (await snapToSurface(fake, fernArgs())) as { results: Array<Record<string, unknown>> };
    const snap = result.results.find((r) => r.op === "SnapToSurface")!;
    expect(snap).toMatchObject({ evidence: "visual_mesh", engine: { note: "the engine's AABB seat matches the triangles" }, verify: { final_gap: 0, ok: true } });
    expect(fake.ops()).toEqual(["SnapToSurface", "SaveScene", "RunSceneScript", "SaveScene"]);
    expect(fake.unsaved).toBe(false);
  });

  it("when the triangles show no support either, reports the engine failure with mesh_fallback and the diagnosis", async () => {
    const fake = new FakeMeshSnapEngine(FLOATING_3_5CM);
    fake.probeOverride[0] = (answer) => ({ ...answer, found: false });
    const result = (await snapToSurface(fake, fernArgs())) as { ok: boolean; error: string; results: Array<Record<string, unknown>> };
    expect(result.ok).toBe(false);
    expect(result.results[0]).toMatchObject({
      failure_reason: "overlap_recovery_exceeded",
      evidence: "visual_aabb",
      mesh_fallback: { failure_reason: "surface_not_found" },
      start_overlap: true,
    });
    expect(fake.ops()).toEqual(["SnapToSurface", "RunSceneScript", "Starcast3D"]);
    expect(fake.savedLocalY()).toBe(FLOATING_3_5CM);
  });

  it("puts the prop back when the read after the move disagrees", async () => {
    const fake = new FakeMeshSnapEngine(FLOATING_3_5CM);
    fake.probeOverride[1] = (answer) => ({ ...answer, travel: 0.05 });
    const result = (await snapToSurface(fake, fernArgs())) as { ok: boolean; results: Array<Record<string, unknown>> };
    expect(result.ok).toBe(false);
    expect(result.results[0]).toMatchObject({ mesh_fallback: { failure_reason: "verify_mismatch" } });
    expect(fake.local[1]).toBe(FLOATING_3_5CM);
    expect(fake.savedLocalY()).toBe(FLOATING_3_5CM);
  });

  it("refuses a lift deeper than the automatic limit", async () => {
    const fake = new FakeMeshSnapEngine(-0.2725 - 0.4); // lowest vertex 0.8 m below the plane
    const result = (await snapToSurface(fake, fernArgs())) as { ok: boolean; results: Array<Record<string, unknown>> };
    expect(result.ok).toBe(false);
    expect(result.results[0]).toMatchObject({ mesh_fallback: { failure_reason: "lift_too_large" } });
    expect(fake.ops()).not.toContain("SetProp");
  });

  it("MCP face: the compact result is the visual_mesh seat", async () => {
    const fake = new FakeMeshSnapEngine(FLOATING_3_5CM);
    vi.mocked(getClient).mockResolvedValue(fake as never);
    const result = (await spatialTool("summer_snap_to_surface").handler({ scenePath: SCENE, subjectPath: "./Props/Fern", direction: [0, -1, 0], maxDistance: 20, gap: 0, alignUp: false })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: true, evidence: "visual_mesh", supportPath: "Ground/Tile_3" });
  });

  it("the probe is read-only GDScript with its arguments as base64 data", () => {
    const template = snapMeshProbeTemplate();
    expect(template.split(SNAP_MESH_ARGS_TOKEN)).toHaveLength(2);
    expect(gdscriptStructureProblems(template)).toEqual([]);
    const hostile = 'Props/Fern"); OS.execute("sh", []); #';
    const source = buildSnapMeshScript({ scene_path: SCENE, subject: hostile });
    const [before, after] = template.split(SNAP_MESH_ARGS_TOKEN) as [string, string];
    expect(source.slice(before.length, source.length - after.length)).toMatch(/^"[A-Za-z0-9+/]*={0,2}"$/);
    // It never mutates: no setters, adds, frees or saves on scene nodes.
    for (const forbidden of ["set_position", "add_child", "queue_free", ".free()", "save_scene", "position =", "transform ="]) {
      expect(template, forbidden).not.toContain(forbidden);
    }
  });
});

type RegisteredTool = { name: string; handler: (args: Record<string, unknown>) => Promise<unknown> };

function spatialTool(name: string): RegisteredTool {
  const registered: RegisteredTool[] = [];
  registerSpatialTools({
    tool(toolName: string, _description: string, _schema: unknown, handler: RegisteredTool["handler"]) {
      registered.push({ name: toolName, handler });
      return { name: toolName };
    },
  } as never);
  return registered.find((candidate) => candidate.name === name)!;
}
