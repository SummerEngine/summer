import { describe, expect, it, vi } from "vitest";

vi.mock("../server.js", () => ({ getClient: vi.fn(), resetClient: vi.fn() }));
vi.mock("../../core/telemetry.js", () => ({ recordMcpSession: vi.fn() }));

import { getClient } from "../server.js";
import { registerSpatialTools } from "./spatial-tools.js";
import { snapToSurface, type SnapToSurfaceArgs } from "../../core/capabilities/surface-snap.js";
import { dispatchTool } from "../../core/capabilities/tool-dispatch.js";
import { findTscnNode, parseTscn } from "../../core/capabilities/tscn.js";
import { parseTransform3D } from "../../core/capabilities/math3d.js";

const SCENE = "res://three_houses_v2.tscn";

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
  it("the fake reproduces the field failure: a sunk prop gets gap_exceeds_hit_travel from the engine op", async () => {
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
    const fake = new FakeSnapEngine(SUNK_5CM, [{ path: "Ground/Floor", top: 0 }, { path: "Shelf/Board", top: 0.01 }]);
    fake.starcastContacts = ["Ground/Floor"]; // the board was not reported as a contact
    const result = (await snapToSurface(fake, args())) as { ok: boolean; error: string; results: Array<Record<string, unknown>> };
    expect(result.ok).toBe(false);
    expect(result.results[0]!.recovery).toMatchObject({ settled_on: "Shelf/Board", restored: true });
    expect(result.error).toContain("settled on Shelf/Board");
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
