import { describe, expect, it, vi } from "vitest";
import {
  adjacentDeltas,
  attachToSurface,
  attachToSurfaceArgsSchema,
  connectPorts,
  connectPortsArgsSchema,
  connectTransform,
  fitToBudget,
  inspectAsset,
  inspectAssetArgsSchema,
  localExtents,
  measure,
  measureArgsSchema,
  mountingRotation,
  placeAdjacent,
  placeAdjacentArgsSchema,
  raycast,
  raycastArgsSchema,
  repeatAlong,
  repeatAlongArgsSchema,
  repeatPositions,
  seatNextStep,
  seatOrigin,
  isSafeNodePath,
  isSafeResPath,
} from "./placement.js";
import { PLACEMENT_ARGS_TOKEN, buildPlacementScript, encodeScriptArgs, placementProbeTemplate } from "./placement-script.js";
import { add, basisMulVec, dot, parseGodotTransform, parseGodotVector3, type Vec3 } from "./placement-math.js";

type Op = Record<string, unknown>;
type Probe = (args: Op) => Op;

const IDENTITY12 = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

/** The argument block the probe script carries (base64 JSON). */
function probeArgs(op: Op): Op {
  const source = String(op.script_source);
  const line = source.split("\n").find((l) => l.startsWith("const ARGS_B64 = "))!;
  const literal = JSON.parse(line.slice("const ARGS_B64 = ".length)) as string;
  return JSON.parse(Buffer.from(literal, "base64").toString("utf8")) as Op;
}

/** A client whose RunSceneScript answers come from `probe` (one per call, or
 *  the same function every time) and whose mutations succeed. */
function mockClient(probes: Probe | Probe[], options: { mutationResults?: (ops: Op[]) => Op[]; lacks?: string[] } = {}) {
  const queue = Array.isArray(probes) ? [...probes] : null;
  const probeCalls: Op[] = [];
  const mutations: Op[][] = [];
  const executeIdentityBoundOps = vi.fn(async (ops: Op[], _options?: Op) => {
    if (ops[0]!.op === "RunSceneScript") {
      probeCalls.push(ops[0]!);
      const answer = (queue ? queue.shift()! : (probes as Probe))(probeArgs(ops[0]!));
      return { status: "ok", terminalState: "applied", results: [{ ok: true, op: "RunSceneScript", ran: true, result: answer }] };
    }
    mutations.push(ops);
    const results = options.mutationResults?.(ops) ?? ops.map((op) => ({ ok: true, op: op.op }));
    const failed = results.find((r) => r.ok === false);
    return failed ? { status: "error", error: String(failed.error), results } : { status: "ok", terminalState: "applied", results };
  });
  const client = {
    executeIdentityBoundOps,
    getEngineCapabilities: () =>
      options.lacks ? { opKinds: ["SetProp", "SaveScene", "InstantiateScene", "RunSceneScript", "SnapToSurface"].filter((k) => !options.lacks!.includes(k)) } : undefined,
  };
  return { client, probeCalls, mutations };
}

function bounds(path: string, intervals: Array<[number, number]> | null, extra: Op = {}): Op {
  return {
    path,
    resolved: path.replace(/^\.\//, ""),
    geometry_count: intervals ? 1 : 0,
    xform: IDENTITY12,
    parent_xform: IDENTITY12,
    position: [0, 0, 0],
    ...(intervals ? { intervals, reach: 1 } : {}),
    ...extra,
  };
}

const WORLD_DIRS = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

describe("the placement probe", () => {
  it("embeds its arguments as base64 data and runs read-only", async () => {
    const tricky = { cmd: "bounds", note: 'quote " backslash \\ newline \n tab \t' };
    expect(JSON.parse(Buffer.from(encodeScriptArgs(tricky), "base64").toString("utf8"))).toEqual(tricky);
    const source = buildPlacementScript(tricky);
    expect(source.startsWith("@tool\nextends RefCounted\n")).toBe(true);
    expect(source).toContain("func run(_ctx):");
    expect(source).not.toContain("__SUMMER_PLACEMENT_ARGS__");

    const { client, probeCalls, mutations } = mockClient(() => ({ ok: true, frame: "asset_root", aabb: null }));
    await inspectAsset(client, inspectAssetArgsSchema.parse({ path: "res://kit/wall.tscn" }));
    expect(probeCalls[0]).toMatchObject({ op: "RunSceneScript", checkpoint: false, undo: "none" });
    expect(probeArgs(probeCalls[0]!)).toEqual({ cmd: "inspect_asset", path: "res://kit/wall.tscn", max_triangles: 60000 });
    expect(mutations).toEqual([]);
  });

  it("answers engine_lacks_op without sending when RunSceneScript is missing", async () => {
    const { client, probeCalls } = mockClient(() => ({ ok: true }), { lacks: ["RunSceneScript"] });
    const result = await inspectAsset(client, inspectAssetArgsSchema.parse({ path: "res://kit/wall.tscn" }));
    expect(result).toMatchObject({ ok: false, failure_reason: "engine_lacks_op", op: "RunSceneScript" });
    expect(probeCalls).toEqual([]);
  });

  it("passes the probe's own structured failure through", async () => {
    const { client } = mockClient(() => ({ ok: false, failure_reason: "scene_not_open", error: "Scene res://a.tscn is not open" }));
    const result = await measure(client, measureArgsSchema.parse({ scenePath: "res://a.tscn", a: "A", b: "B" }));
    expect(result).toMatchObject({ ok: false, tool: "summer_measure", failure_reason: "scene_not_open" });
  });

  it("reports a script error as measurement_script_failed with the first error line", async () => {
    const client = {
      executeIdentityBoundOps: vi.fn(async () => ({
        status: "error",
        error: "script error",
        results: [{ ok: false, op: "RunSceneScript", failure_reason: "script_runtime_error", error: "raised 1 script error(s)", errors: [{ line: 12, message: "Invalid get index" }] }],
      })),
    };
    const result = await raycast(client, raycastArgsSchema.parse({ scenePath: "res://a.tscn", origin: [0, 1, 0], direction: [0, -1, 0] }));
    expect(result).toMatchObject({
      ok: false,
      failure_reason: "measurement_script_failed",
      engine_failure_reason: "script_runtime_error",
      script_error: "line 12: Invalid get index",
    });
  });
});

describe("hostile inputs never become GDScript", () => {
  const PAYLOADS = [
    "$&",
    "$`",
    "$'",
    "$1",
    'Wall"); OS.execute("rm", ["-rf", "/"]); #',
    "Wall\n\tOS.execute('sh')",
    "Wall\\\"",
    "../../etc",
    "Wall:prop",
    "Wall%unique",
    "Wall\u0000",
  ];

  it("keeps the generated script identical apart from one inert base64 literal", () => {
    const template = placementProbeTemplate();
    expect(template.split(PLACEMENT_ARGS_TOKEN)).toHaveLength(2);
    for (const payload of PAYLOADS) {
      const args = { cmd: "bounds", scene_path: "res://a.tscn", nodes: [{ path: payload }], subject_port: payload };
      const source = buildPlacementScript(args);
      const [before, after] = template.split(PLACEMENT_ARGS_TOKEN) as [string, string];
      expect(source.startsWith(before)).toBe(true);
      expect(source.endsWith(after)).toBe(true);
      const literal = source.slice(before.length, source.length - after.length);
      expect(literal).toMatch(/^"[A-Za-z0-9+/]*={0,2}"$/);
      expect(JSON.parse(Buffer.from(literal.slice(1, -1), "base64").toString("utf8"))).toEqual(args);
    }
  });

  it("rejects hostile node paths, port names and res:// paths at the schema", () => {
    for (const payload of PAYLOADS) {
      expect(measureArgsSchema.safeParse({ scenePath: "res://a.tscn", a: payload, b: "B" }).success, payload).toBe(false);
      expect(
        connectPortsArgsSchema.safeParse({ scenePath: "res://a.tscn", subject: "A", subjectPort: payload, target: "B", targetPort: 0 }).success,
        payload
      ).toBe(false);
      expect(raycastArgsSchema.safeParse({ scenePath: "res://a.tscn", origin: [0, 0, 0], direction: [0, -1, 0], exclude: [payload] }).success, payload).toBe(false);
      expect(inspectAssetArgsSchema.safeParse({ path: `res://kit/${payload}.glb` }).success, payload).toBe(false);
      expect(
        repeatAlongArgsSchema.safeParse({ scenePath: `res://${payload}.tscn`, template: "res://kit/a.tscn", parent: ".", start: [0, 0, 0], count: 1 }).success,
        payload
      ).toBe(false);
    }
  });

  it("still accepts ordinary kit paths and names", () => {
    expect(isSafeNodePath("./Facade/Wall_01")).toBe(true);
    expect(isSafeNodePath("Building A/Storey 2/Window-03")).toBe(true);
    expect(isSafeNodePath("Fassade/Fenster_Ä")).toBe(true);
    expect(isSafeResPath("res://starter/real-city-alley-kit/pipes/wall_clamp_01.tscn")).toBe(true);
    expect(connectPortsArgsSchema.safeParse({ scenePath: "res://a.tscn", subject: "A", subjectPort: "Port_A", target: "B", targetPort: "Ports/Port B" }).success).toBe(true);
  });
});

describe("summer_inspect_asset", () => {
  it("cuts long lists to fit and declares the cut", async () => {
    const meshes = Array.from({ length: 200 }, (_, i) => ({ path: `Model/mesh_${i}`, tris: 12, min: [0, 0, 0], max: [1, 1, 1] }));
    const { client } = mockClient(() => ({ ok: true, frame: "asset_root", mesh_count: 200, meshes, planes: [], open_loops: [] }));
    const result = await inspectAsset(client, inspectAssetArgsSchema.parse({ path: "res://kit/big.glb" }));
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(5 * 1024);
    expect(result.truncated).toMatchObject({ meshes: { total: 200 } });
    expect(result).toMatchObject({ ok: true, tool: "summer_inspect_asset", evidence: "mesh_triangles", mesh_count: 200 });
  });

  it("rejects non-asset paths in the schema", () => {
    expect(inspectAssetArgsSchema.safeParse({ path: "res://notes.txt" }).success).toBe(false);
    expect(inspectAssetArgsSchema.safeParse({ path: "/tmp/wall.glb" }).success).toBe(false);
  });

  it("fitToBudget leaves small results alone", () => {
    expect(fitToBudget({ ok: true, list: [1, 2, 3] }, ["list"])).toEqual({ ok: true, list: [1, 2, 3] });
  });
});

describe("summer_measure", () => {
  it("reports gap, touching and overlap per axis from b minus a", async () => {
    const { client } = mockClient(() => ({
      ok: true,
      space: "world",
      dirs: WORLD_DIRS,
      nodes: [bounds("Wall_A", [[0, 2], [0, 3], [-0.2, 0]]), bounds("Wall_B", [[2.03, 4], [0, 3], [-0.1, 0.05]])],
    }));
    const result = await measure(client, measureArgsSchema.parse({ scenePath: "res://a.tscn", a: "Wall_A", b: "Wall_B" }));
    expect(result.axes).toMatchObject({
      x: { gap: 0.03, relation: "gap" },
      y: { gap: -3, relation: "overlap", delta_min: 0 },
      z: { gap: -0.1, relation: "overlap", delta_max: 0.05 },
    });
    expect(result.boxes_overlap).toBe(false);
    expect(result.evidence).toBe("visual_aabb");
  });

  it("finds modules standing proud of a facade line in plane mode", async () => {
    const { client, probeCalls } = mockClient(() => ({
      ok: true,
      space: "world",
      dirs: WORLD_DIRS,
      nodes: [
        bounds("M1", [[0, 1], [0, 3], [-0.2, 0]]),
        bounds("M2", [[1, 2], [0, 3], [-0.2, 0.001]]),
        bounds("M3", [[2, 3], [0, 3], [-0.2, 0.04]]),
        bounds("M4", [[3, 4], [0, 3], [-0.3, -0.02]]),
      ],
    }));
    const result = await measure(
      client,
      measureArgsSchema.parse({ scenePath: "res://a.tscn", mode: "plane", nodes: ["M1", "M2", "M3", "M4"], face: "+z" })
    );
    expect(probeArgs(probeCalls[0]!).nodes).toEqual([{ path: "M1" }, { path: "M2" }, { path: "M3" }, { path: "M4" }]);
    expect(result).toMatchObject({ coplanar: false, spread: 0.06, off_plane_count: 2 });
    const rows = result.nodes as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ path: "M3", off_plane: "proud" });
    expect(rows[1]).toMatchObject({ path: "M4", off_plane: "recessed" });
  });

  it("validates mode arguments before sending", async () => {
    const { client, probeCalls } = mockClient(() => ({ ok: true }));
    await expect(measure(client, measureArgsSchema.parse({ scenePath: "res://a.tscn", mode: "plane", nodes: ["A", "B"] }))).rejects.toThrow(/face/);
    await expect(measure(client, measureArgsSchema.parse({ scenePath: "res://a.tscn", a: "A" }))).rejects.toThrow(/a and b/);
    expect(probeCalls).toEqual([]);
  });
});

describe("summer_raycast", () => {
  it("prefers the physics hit and names nearer mesh-only geometry", async () => {
    const { client } = mockClient(() => ({
      ok: true,
      physics_available: true,
      physics: { path: "Wall", point: [0, 1, -2], normal: [0, 0, 1], distance: 2 },
      visual: { path: "Poster/Mesh", point: [0, 1, -1.5], normal: [0, 0, 1], distance: 1.5 },
      visual_origin_inside: 0,
    }));
    const result = await raycast(client, raycastArgsSchema.parse({ scenePath: "res://a.tscn", origin: [0, 1, 0], direction: [0, 0, -1] }));
    expect(result).toMatchObject({ hit: true, evidence: "physics", path: "Wall", distance: 2, nearer_visual_only: { path: "Poster/Mesh" } });
    expect(result).not.toHaveProperty("fallback");
  });

  it("declares the visual AABB fallback when physics finds nothing", async () => {
    const { client } = mockClient(() => ({
      ok: true,
      physics_available: false,
      physics_unavailable_reason: "scene_not_active",
      visual: { path: "Wall/Model", point: [0, 1, -2], normal: [0, 0, 1], distance: 2 },
    }));
    const result = await raycast(client, raycastArgsSchema.parse({ scenePath: "res://a.tscn", origin: [0, 1, 0], direction: [0, 0, -1] }));
    expect(result).toMatchObject({ hit: true, evidence: "visual_aabb", fallback: true, fallback_reason: "physics_unavailable_scene_not_active" });
  });

  it("refuses physics-only evidence when physics is unavailable", async () => {
    const { client } = mockClient(() => ({ ok: true, physics_available: false, physics_unavailable_reason: "scene_not_active" }));
    const result = await raycast(client, raycastArgsSchema.parse({ scenePath: "res://a.tscn", origin: [0, 1, 0], direction: [0, 0, -1], evidence: "physics" }));
    expect(result).toMatchObject({ ok: false, failure_reason: "physics_unavailable" });
  });

  it("rejects a zero direction in the schema", () => {
    expect(raycastArgsSchema.safeParse({ scenePath: "res://a.tscn", origin: [0, 0, 0], direction: [0, 0, 0] }).success).toBe(false);
  });
});

describe("summer_place_adjacent", () => {
  it("computes face-to-face deltas with per-axis alignment", () => {
    const subject: Array<[number, number]> = [[-0.5, 0.5], [0, 3], [-0.25, 0.05]];
    const reference: Array<[number, number]> = [[-1, 1], [0, 3], [-0.2, 0]];
    const align = (axis: "x" | "y" | "z") => (axis === "y" ? "min" : axis === "z" ? "max" : "none");
    expect(adjacentDeltas(subject, reference, "x", "max", 0, align)).toEqual([1.5, 0, -0.05]);
    expect(adjacentDeltas(subject, reference, "x", "min", 0.1, align)).toEqual([-1.6, 0, -0.05]);
    expect(adjacentDeltas(subject, reference, "y", "max", 0, () => "center")).toEqual([0, 3, expect.closeTo(0, 9)]);
  });

  it("moves the subject in its parent's space with one SetProp, saves, and verifies", async () => {
    // Parent rotated +90 degrees about y and offset: a world +x move is a local +z move.
    const parent = [0, 0, -1, 0, 1, 0, 1, 0, 0, 5, 0, 0];
    const before = {
      ok: true,
      space: "world",
      dirs: WORLD_DIRS,
      nodes: [
        bounds("./Facade/Window", [[-0.5, 0.5], [0, 3], [-0.25, 0.05]], { parent_xform: parent, position: [0, 0, 1] }),
        bounds("./Facade/Wall", [[-1, 1], [0, 3], [-0.2, 0]]),
      ],
      excluded: [],
    };
    const after = {
      ...before,
      nodes: [bounds("./Facade/Window", [[1, 2], [0, 3], [-0.3, 0]], { parent_xform: parent }), bounds("./Facade/Wall", [[-1, 1], [0, 3], [-0.2, 0]])],
    };
    const { client, mutations, probeCalls } = mockClient([() => before, () => after]);
    const result = await placeAdjacent(
      client,
      placeAdjacentArgsSchema.parse({
        scenePath: "res://a.tscn",
        subject: "./Facade/Window",
        reference: "./Facade/Wall",
        axis: "x",
        side: "max",
        alignOtherAxes: { y: "min", z: "max" },
      })
    );
    expect(probeArgs(probeCalls[0]!).nodes).toEqual([
      { path: "./Facade/Window" },
      { path: "./Facade/Wall", exclude: ["./Facade/Window"] },
    ]);
    expect(mutations).toHaveLength(2);
    expect(mutations[0]![0]).toMatchObject({ op: "SetProp", path: "./Facade/Window", key: "position" });
    // World delta (1.5, 0, -0.05) -> parent-local (0.05, 0, 1.5) added to (0, 0, 1).
    expect(parseGodotVector3(String(mutations[0]![0]!.value))).toEqual([0.05, 0, 2.5]);
    expect(mutations[1]).toEqual([{ op: "SaveScene" }]);
    expect(result).toMatchObject({ ok: true, moved: true, saved: true, moved_by: [1.5, 0, -0.05], verify: { gap: 0, residuals: { y: 0, z: 0 } } });
  });

  it("refuses a reference inside the subject and a subject without bounds", async () => {
    const nested = mockClient(() => ({ ok: true, space: "world", dirs: WORLD_DIRS, nodes: [bounds("House", [[0, 1], [0, 1], [0, 1]]), bounds("House/Door", [[0, 1], [0, 1], [0, 1]])] }));
    const args = placeAdjacentArgsSchema.parse({ scenePath: "res://a.tscn", subject: "House", reference: "House/Door", axis: "x", side: "max" });
    expect(await placeAdjacent(nested.client, args)).toMatchObject({ ok: false, failure_reason: "reference_inside_subject" });
    const empty = mockClient(() => ({ ok: true, space: "world", dirs: WORLD_DIRS, nodes: [bounds("A", null), bounds("B", [[0, 1], [0, 1], [0, 1]])] }));
    expect(await placeAdjacent(empty.client, { ...args, subject: "A", reference: "B" })).toMatchObject({ ok: false, failure_reason: "subject_has_no_visual_bounds" });
    expect(nested.mutations).toEqual([]);
  });
});

describe("summer_attach_to_surface", () => {
  it("turns the back axis into the surface, keeps up, and seats with SnapToSurface", () => {
    const mount = mountingRotation("-z", "+y", [1, 0, 0], [0, 1, 0])!;
    expect(basisMulVec(mount.rotation, [0, 0, -1]).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([-1, 0, 0]);
    expect(basisMulVec(mount.rotation, [0, 1, 0]).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 1, 0]);
    // A floor: world up is parallel to the normal, so the current up is kept.
    const floor = mountingRotation("-y", "+z", [0, 1, 0], [0, 1, 0], [0, 0, 1])!;
    expect(floor.usedCurrentUp).toBe(true);
    expect(mountingRotation("-y", "+z", [0, 1, 0], [0, 1, 0], [0, 1, 0])).toBeNull();
  });

  it("seats the lamp's measured back face at the standoff, not its origin, with SnapToSurface along -normal", async () => {
    // Lamp origin at (3.6, 2, 0), back plate 0.15 behind it along local -z.
    const read = {
      ok: true,
      steps: [
        {
          ok: true,
          space: "local",
          dirs: WORLD_DIRS,
          nodes: [bounds("Lamp", [[3.5, 3.7], [2, 2.4], [-0.15, 0]], { xform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 3.6, 2, 0] })],
        },
        { ok: true, origin: [3.6, 2, 0], direction: [1, 0, 0], physics_available: true, physics: { path: "Wall", point: [4, 2, 0], normal: [-1, 0, 0], distance: 0.4 } },
      ],
    };
    const { client, mutations, probeCalls } = mockClient(() => read, {
      mutationResults: (ops) =>
        ops.map((op) =>
          op.op === "SnapToSurface"
            ? { ok: true, op: op.op, evidence: "physics", supportPath: "Wall", finalGap: 0.02, after: { origin: [3.83, 2, 0] } }
            : { ok: true, op: op.op }
        ),
    });
    const result = await attachToSurface(
      client,
      attachToSurfaceArgsSchema.parse({ scenePath: "res://a.tscn", subject: "Lamp", surface: "./Wall", standoff: 0.02 })
    );
    const steps = probeArgs(probeCalls[0]!).steps as Op[];
    expect(steps[0]).toMatchObject({ cmd: "bounds", space_node: "Lamp" });
    expect(steps[1]).toMatchObject({ cmd: "raycast", from_subject: "Lamp", surface: "./Wall", exclude: ["Lamp"] });
    const [setProp, snap] = mutations[0]!;
    expect(setProp).toMatchObject({ op: "SetProp", path: "Lamp", key: "transform" });
    const t = parseGodotTransform(String(setProp!.value))!;
    // Back (-z) now faces +x, into the wall whose normal is -x.
    expect(basisMulVec(t.basis, [0, 0, -1]).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([1, 0, 0]);
    // Planned seat: back plate at 4 - 0.02, so the origin at 3.83; the
    // turn-and-place puts it 5 cm in front of that. Height unchanged.
    expect(t.origin[0]).toBeCloseTo(3.78);
    expect(t.origin[1]).toBeCloseTo(2);
    expect(snap).toMatchObject({ op: "SnapToSurface", subject_path: "Lamp", direction: [1, 0, 0], max_distance: 0.32, gap: 0.02, align_up: false });
    expect(mutations[1]).toEqual([{ op: "SaveScene" }]);
    expect(result).toMatchObject({
      ok: true,
      saved: true,
      seated_on: "Wall",
      final_gap: 0.02,
      back_face_gap: 0.02,
      back_face_offset: 0.15,
      moved_by: [0.23, 0, 0],
      surface_hit: { evidence: "physics", path: "Wall" },
      seat: { supportPath: "Wall", finalGap: 0.02 },
    });
    // "./Wall" and the engine's "Wall" are the same node: no false warning.
    expect(result.warnings).toEqual([]);
  });

  // Field evidence (proof run, 2026-10-04): with a ray, the origin went to the
  // ray height, so a street lamp and a power box landed 0.2 m too high.
  const shutterBounds = (extra: Op = {}) =>
    bounds("Alley2/ShutterWin", [[0.5, 3.5], [1.1, 3.7], [0.4, 0.6]], {
      xform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 2, 1.1, 0.6],
      transform_str: "Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 2, 1.1, 0.6)",
      ...extra,
    });
  const shutterRead = (hit: Op = { path: "House2/Back/B0_w3", point: [2, 2.35, 0], normal: [0, 0, 1], distance: 3 }) => ({
    ok: true,
    steps: [
      { ok: true, space: "local", dirs: WORLD_DIRS, nodes: [shutterBounds()] },
      { ok: true, origin: [2, 2.35, 3], direction: [0, 0, -1], physics_available: true, physics: hit },
    ],
  });
  const seatAt = (origin: Vec3, supportPath: string) => (ops: Op[]) =>
    ops.map((op) =>
      op.op === "SnapToSurface"
        ? { ok: true, op: op.op, evidence: "physics", supportPath, finalGap: 0, gapErrorBound: 0.0001, after: { origin } }
        : { ok: true, op: op.op }
    );

  it("keeps the piece's height with a ray and seats its back face, not its origin", async () => {
    const { client, mutations } = mockClient(() => shutterRead(), { mutationResults: seatAt([2, 1.1, 0.2], "House2/Back/B0_w3") });
    const result = await attachToSurface(
      client,
      attachToSurfaceArgsSchema.parse({ scenePath: "res://a.tscn", subject: "Alley2/ShutterWin", ray: { origin: [2, 2.35, 3], direction: [0, 0, -1] } })
    );
    const t = parseGodotTransform(String(mutations[0]![0]!.value))!;
    // The ray is at y 2.35; the shutter keeps y 1.1. Its back face (0.2 behind
    // the origin) goes onto the wall at z 0: origin z 0.2, sent 5 cm in front.
    expect(t.origin).toEqual([2, 1.1, expect.closeTo(0.25, 6)]);
    expect(result).toMatchObject({ ok: true, placed_at: "current", seated_on: "House2/Back/B0_w3", back_face_gap: 0, moved_by: [0, 0, -0.4] });
  });

  it("puts the centre of the back face on the hit point with placeAt hit", () => {
    const extents = localExtents([[0.5, 3.5], [1.1, 3.7], [0.4, 0.6]], WORLD_DIRS as Vec3[], [2, 1.1, 0.6]);
    const identity: [Vec3, Vec3, Vec3] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const plan = seatOrigin({ origin: [2, 1.1, 0.6], extents, backAxis: "-z", rotation: identity, hitPoint: [2, 2.35, 0], normal: [0, 0, 1], standoff: 0.01, placeAt: "hit" });
    // Back-face centre is (0, 1.3, -0.2) from the origin: origin = hit - that + standoff.
    plan.origin.forEach((v, k) => expect(v).toBeCloseTo([2, 1.05, 0.21][k]!));
    expect(plan.backOffset).toBeCloseTo(0.2);
  });

  it("lands the back face on the plane for a turned piece (wall facing +x, back -z)", () => {
    const mount = mountingRotation("-z", "+y", [1, 0, 0], [0, 1, 0])!;
    const lo: Vec3 = [-0.4, 0, -0.3];
    const hi: Vec3 = [0.4, 0.9, 0.1];
    for (const placeAt of ["current", "hit"] as const) {
      const plan = seatOrigin({ origin: [1, 2, 3], extents: { lo, hi }, backAxis: "-z", rotation: mount.rotation, hitPoint: [5, 2.5, 3], normal: [1, 0, 0], standoff: 0.02, placeAt });
      const corners: Vec3[] = [];
      for (let i = 0; i < 8; i++) {
        const local: Vec3 = [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]];
        corners.push(add(plan.origin, basisMulVec(mount.rotation, local)));
      }
      // The face nearest the wall sits standoff in front of the plane x = 5.
      expect(Math.min(...corners.map((c) => dot(c, [1, 0, 0])))).toBeCloseTo(5.02);
      if (placeAt === "current") expect(plan.origin[1]).toBeCloseTo(2);
    }
  });

  // Field evidence (audit fix run, 2026-10-04): the shutter was seated on a
  // duct brace instead of the named wall and saved, with only a warning.
  it("refuses a seat on another node than the named surface and puts the piece back unsaved", async () => {
    const read = {
      ok: true,
      steps: [
        { ok: true, space: "local", dirs: WORLD_DIRS, nodes: [shutterBounds()] },
        { ok: true, origin: [2, 1.1, 0.6], direction: [0, 0, -1], physics_available: true, physics: { path: "House2/Back/B0_w3", point: [2, 1.1, 0], normal: [0, 0, 1], distance: 0.6 } },
      ],
    };
    const { client, mutations } = mockClient(() => read, { mutationResults: seatAt([2, 1.1, 0.33], "Alley2/Duct/Brace_3") });
    const result = await attachToSurface(
      client,
      attachToSurfaceArgsSchema.parse({ scenePath: "res://a.tscn", subject: "Alley2/ShutterWin", surface: "House2/Back/B0_w3" })
    );
    expect(result).toMatchObject({
      ok: false,
      failure_reason: "seated_on_other_node",
      seated_on: "Alley2/Duct/Brace_3",
      intended_surface: "House2/Back/B0_w3",
      in_front_of_plan: 0.13,
      restored: true,
      mutationApplied: false,
      saved: false,
    });
    expect(String(result.next_step)).toContain("Alley2/Duct/Brace_3");
    // Turn + seat, then the exact original transform; never a SaveScene.
    expect(mutations).toHaveLength(2);
    expect(mutations[1]).toEqual([{ op: "SetProp", path: "Alley2/ShutterWin", key: "transform", value: "Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 2, 1.1, 0.6)" }]);
    expect(mutations.flat().some((op) => op.op === "SaveScene")).toBe(false);
  });

  it("refuses before changing anything when the piece would move farther than maxMove", async () => {
    const read = {
      ok: true,
      steps: [
        { ok: true, space: "local", dirs: WORLD_DIRS, nodes: [bounds("Lamp", [[-0.1, 0.1], [0, 0.4], [-0.15, 0]])] },
        { ok: true, origin: [0, 2, 1], direction: [0, 0, -1], physics_available: true, physics: { path: "Wall", point: [0, 2, -8], normal: [0, 0, 1], distance: 9 } },
      ],
    };
    const { client, mutations } = mockClient(() => read);
    const result = await attachToSurface(client, attachToSurfaceArgsSchema.parse({ scenePath: "res://a.tscn", subject: "Lamp", ray: { origin: [0, 2, 1], direction: [0, 0, -1] } }));
    expect(result).toMatchObject({ ok: false, failure_reason: "move_exceeds_max_move", mutationApplied: false, saved: false });
    expect(String(result.error)).toContain("7.85");
    expect(String(result.next_step)).toContain("summer_set_prop");
    expect(mutations).toEqual([]);
    // A deliberate long move is allowed when asked for.
    const long = mockClient(() => read, { mutationResults: seatAt([0, 0, -7.85], "Wall") });
    const moved = await attachToSurface(long.client, attachToSurfaceArgsSchema.parse({ scenePath: "res://a.tscn", subject: "Lamp", ray: { origin: [0, 2, 1], direction: [0, 0, -1] }, maxMove: 10 }));
    expect(moved).toMatchObject({ ok: true, saved: true });
  });

  it("refuses a ray that hits the surface far from the piece unless placeAt hit asks to move it there", async () => {
    const farHit = { path: "House2/Back/B0_w7", point: [6, 2.35, 0], normal: [0, 0, 1], distance: 3 };
    const ray = { origin: [6, 2.35, 3] as Vec3, direction: [0, 0, -1] as Vec3 };
    const kept = mockClient(() => shutterRead(farHit));
    const refused = await attachToSurface(kept.client, attachToSurfaceArgsSchema.parse({ scenePath: "res://a.tscn", subject: "Alley2/ShutterWin", ray }));
    expect(refused).toMatchObject({ ok: false, failure_reason: "hit_far_from_piece", mutationApplied: false });
    expect(String(refused.next_step)).toContain("placeAt");
    expect(kept.mutations).toEqual([]);

    const moved = mockClient(() => shutterRead(farHit), { mutationResults: seatAt([6, 1.05, 0.2], "House2/Back/B0_w7") });
    const result = await attachToSurface(moved.client, attachToSurfaceArgsSchema.parse({ scenePath: "res://a.tscn", subject: "Alley2/ShutterWin", ray, placeAt: "hit", maxMove: 5 }));
    expect(result).toMatchObject({ ok: true, placed_at: "hit", seated_on: "House2/Back/B0_w7", back_face_gap: 0 });
    const t = parseGodotTransform(String(moved.mutations[0]![0]!.value))!;
    t.origin.forEach((v, k) => expect(v).toBeCloseTo([6, 1.05, 0.25][k]!));
  });

  it("with a ray only, accepts a coplanar neighbour module (warned) but refuses a node in front of the wall", async () => {
    const coplanar = mockClient(() => shutterRead({ path: "Facade/W1", point: [2, 2.35, 0], normal: [0, 0, 1], distance: 3 }), { mutationResults: seatAt([2, 1.1, 0.2], "Facade/W2") });
    const accepted = await attachToSurface(coplanar.client, attachToSurfaceArgsSchema.parse({ scenePath: "res://a.tscn", subject: "Alley2/ShutterWin", ray: { origin: [2, 2.35, 3], direction: [0, 0, -1] } }));
    expect(accepted).toMatchObject({ ok: true, saved: true, seated_on: "Facade/W2" });
    expect(accepted.warnings).toContain("seated_on_coplanar_Facade/W2");

    const brace = mockClient(() => shutterRead(), { mutationResults: seatAt([2, 1.1, 0.32], "Duct/Brace") });
    const refused = await attachToSurface(brace.client, attachToSurfaceArgsSchema.parse({ scenePath: "res://a.tscn", subject: "Alley2/ShutterWin", ray: { origin: [2, 2.35, 3], direction: [0, 0, -1] } }));
    expect(refused).toMatchObject({ ok: false, failure_reason: "seated_on_other_node", seated_on: "Duct/Brace", restored: true, saved: false });
    expect(brace.mutations.flat().some((op) => op.op === "SaveScene")).toBe(false);
  });

  it("warns when the collider sits behind the visible back, so the mesh pokes into the wall", async () => {
    const { client } = mockClient(() => shutterRead(), { mutationResults: seatAt([2, 1.1, 0.15], "House2/Back/B0_w3") });
    const result = await attachToSurface(client, attachToSurfaceArgsSchema.parse({ scenePath: "res://a.tscn", subject: "Alley2/ShutterWin", ray: { origin: [2, 2.35, 3], direction: [0, 0, -1] } }));
    expect(result).toMatchObject({ ok: true, back_face_gap: -0.05 });
    expect((result.warnings as string[]).some((w) => w.startsWith("visible_back_0.05_into_surface"))).toBe(true);
  });

  // Field evidence (proof run): snap failures said neither what blocked the
  // piece nor that it started out overlapping.
  it("names the blocker of a failed seat, says it started overlapping, gives a next step and puts the piece back", async () => {
    const blockers = { ok: true, evidence: "physics", overlaps: ["Ground/Al_3"], first_contact: { path: "Ground/Al_3", distance: 0 } };
    const { client, mutations, probeCalls } = mockClient([() => shutterRead(), () => blockers], {
      mutationResults: (ops) =>
        ops.map((op) =>
          op.op === "SnapToSurface"
            ? { ok: false, op: op.op, failure_reason: "overlap_recovery_exceeded", error: "Subject overlap could not be cleared opposite direction within max_distance", initiallyOverlapping: true, backoffDistance: 0.3 }
            : { ok: true, op: op.op }
        ),
    });
    const result = await attachToSurface(client, attachToSurfaceArgsSchema.parse({ scenePath: "res://a.tscn", subject: "Alley2/ShutterWin", ray: { origin: [2, 2.35, 3], direction: [0, 0, -1] } }));
    expect(probeArgs(probeCalls[1]!)).toMatchObject({ cmd: "blockers", path: "Alley2/ShutterWin", direction: [0, 0, -1], max_distance: 0.3 });
    expect(result).toMatchObject({
      ok: false,
      failure_reason: "overlap_recovery_exceeded",
      seat: { initiallyOverlapping: true },
      blockers: { evidence: "physics", overlapping: true, overlaps: ["Ground/Al_3"], first_contact: { path: "Ground/Al_3", distance: 0 } },
      restored: true,
      saved: false,
    });
    expect(String(result.next_step)).toContain("Ground/Al_3");
    expect(String(result.next_step)).toContain("lift");
    expect(mutations).toHaveLength(2);
    expect(mutations[1]![0]).toMatchObject({ op: "SetProp", key: "transform" });
  });

  it("gives a concrete next step for every seat failure the engine reports", () => {
    const blockers = { overlaps: [], first_contact: { path: "Alley1/Props/Bin2", distance: 0.01 } };
    expect(seatNextStep("gap_exceeds_hit_travel", blockers, 0.3)).toContain("Alley1/Props/Bin2");
    expect(seatNextStep("surface_not_found", undefined, 0.3)).toContain("collider");
    expect(seatNextStep("subject_not_ready", undefined, 0.3)).toContain("summer_open_scene");
    expect(seatNextStep("something_new", undefined, 0.3)).toContain("seat.error");
  });

  it("refuses to un-mirror a mirrored piece", async () => {
    const read = {
      ok: true,
      steps: [
        { ok: true, space: "local", dirs: WORLD_DIRS, nodes: [bounds("Lamp", [[0, 1], [0, 1], [0, 1]], { xform: [-1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] })] },
        { ok: true, origin: [0, 0, 1], direction: [0, 0, -1], physics_available: true, physics: { path: "Wall", point: [0, 0, 0], normal: [0, 0, 1], distance: 1 } },
      ],
    };
    const { client, mutations } = mockClient(() => read);
    const result = await attachToSurface(client, attachToSurfaceArgsSchema.parse({ scenePath: "res://a.tscn", subject: "Lamp", ray: { origin: [0, 0, 1], direction: [0, 0, -1] } }));
    expect(result).toMatchObject({ ok: false, failure_reason: "mirrored_subject" });
    expect(mutations).toEqual([]);
  });

  it("validates axes and the surface source before sending", async () => {
    const { client, probeCalls } = mockClient(() => ({ ok: true }));
    await expect(attachToSurface(client, attachToSurfaceArgsSchema.parse({ scenePath: "res://a.tscn", subject: "Lamp" }))).rejects.toThrow(/surface/);
    await expect(
      attachToSurface(client, attachToSurfaceArgsSchema.parse({ scenePath: "res://a.tscn", subject: "Lamp", surface: "Wall", backAxis: "-z", upAxis: "+z" }))
    ).rejects.toThrow(/different axes/);
    expect(probeCalls).toEqual([]);
  });

  it("refuses before sending when the engine lacks SnapToSurface", async () => {
    const { client, probeCalls } = mockClient(() => ({ ok: true }), { lacks: ["SnapToSurface"] });
    const result = await attachToSurface(client, attachToSurfaceArgsSchema.parse({ scenePath: "res://a.tscn", subject: "Lamp", surface: "Wall" }));
    expect(result).toMatchObject({ ok: false, failure_reason: "engine_lacks_op", op: "SnapToSurface" });
    expect(probeCalls).toEqual([]);
  });
});

describe("summer_repeat_along", () => {
  it("fits copies on a line by spacing with the leftover where align says", () => {
    const base = { start: [0, 0, 0] as Vec3, end: [0, 2, 0] as Vec3, spacing: 0.45 };
    expect(repeatPositions({ ...base, align: "start" }).positions.map((p) => Math.round(p[1] * 1000) / 1000)).toEqual([0, 0.45, 0.9, 1.35, 1.8]);
    expect(repeatPositions({ ...base, align: "center" }).positions[0]![1]).toBeCloseTo(0.1);
    expect(repeatPositions({ ...base, align: "end" }).positions[4]![1]).toBeCloseTo(2);
    const byCount = repeatPositions({ start: [0, 0, 0], end: [3, 0, 0], count: 4, align: "start" });
    expect(byCount.spacing).toBeCloseTo(1);
    expect(byCount.positions[3]).toEqual([3, 0, 0]);
    const byDirection = repeatPositions({ start: [1, 0, 0], direction: [0, 0, 2], count: 3, spacing: 0.8, align: "start" });
    expect(byDirection.positions[2]![2]).toBeCloseTo(1.6);
  });

  it("rejects over-determined, under-determined and oversized rows", () => {
    expect(() => repeatPositions({ start: [0, 0, 0], end: [1, 0, 0], count: 2, spacing: 0.5, align: "start" })).toThrow(/not both/);
    expect(() => repeatPositions({ start: [0, 0, 0], end: [1, 0, 0], align: "start" })).toThrow(/spacing or count/);
    expect(() => repeatPositions({ start: [0, 0, 0], direction: [1, 0, 0], count: 3, align: "start" })).toThrow(/spacing/);
    expect(() => repeatPositions({ start: [0, 0, 0], end: [100, 0, 0], spacing: 0.1, align: "start" })).toThrow(/limit is 64/);
  });

  it("instances every copy with its transform and returns a compact receipt", async () => {
    const { client, mutations } = mockClient(() => ({ ok: true }), {
      mutationResults: (ops) =>
        ops.map((op) => (op.op === "InstantiateScene" ? { ok: true, op: op.op, meta: { nodePath: `Pipe/${String(op.name)}` } } : { ok: true, op: op.op })),
    });
    const result = await repeatAlong(
      client,
      repeatAlongArgsSchema.parse({
        scenePath: "res://a.tscn",
        template: "res://kit/pipes/wall_clamp_01.tscn",
        parent: "./Pipe",
        start: [0, 0.3, 0],
        end: [0, 1.2, 0],
        spacing: 0.45,
        rotationDegrees: [0, 90, 0],
      })
    );
    expect(mutations.map((chunk) => chunk.map((op) => op.op))).toEqual([
      ["InstantiateScene"], ["SetProp", "SetProp"],
      ["InstantiateScene"], ["SetProp", "SetProp"],
      ["InstantiateScene"], ["SetProp", "SetProp"],
      ["SaveScene"],
    ]);
    expect(mutations[0]![0]).toMatchObject({ name: "wall_clamp_01_1", parent: "./Pipe", scene: "res://kit/pipes/wall_clamp_01.tscn" });
    expect(result).toMatchObject({
      ok: true,
      tool: "summer_repeat_along",
      count: 3,
      spacing: 0.45,
      created: ["Pipe/wall_clamp_01_1", "Pipe/wall_clamp_01_2", "Pipe/wall_clamp_01_3"],
      saved: true,
      first: [0, 0.3, 0],
      last: [0, 1.2, 0],
    });
  });
});

describe("summer_connect_ports", () => {
  it("turns and moves the subject so the ports meet facing each other", () => {
    const subject = { basis: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as [Vec3, Vec3, Vec3], origin: [5, 0, 0] as Vec3 };
    // Subject port points +y at its origin + (0, 1, 0); target port at (0, 3, 0) points +y.
    const sp = { kind: "open_loop", position: [5, 1, 0] as Vec3, direction: [0, 1, 0] as Vec3 };
    const tp = { kind: "open_loop", position: [0, 3, 0] as Vec3, direction: [0, 1, 0] as Vec3 };
    const { xform } = connectTransform(subject, sp, tp, 0, 0);
    // The subject flips upside down and its port lands on the target port.
    const portAfter = [xform.basis[0], xform.basis[1], xform.basis[2]].reduce(
      (acc, column, i) => acc.map((v, k) => v + column[k]! * [0, 1, 0][i]!) as Vec3,
      [...xform.origin] as Vec3
    );
    portAfter.forEach((v, k) => expect(v).toBeCloseTo([0, 3, 0][k]!));
    expect(basisMulVec(xform.basis, [0, 1, 0])[1]).toBeCloseTo(-1);
  });

  it("applies one SetProp transform, saves, and verifies the joint", async () => {
    const before = {
      ok: true,
      subject_port: { kind: "marker", name: "Port_A", position: [0, 0, 0], direction: [0, 0, -1] },
      target_port: { kind: "marker", name: "Port_B", position: [0, 2, 0], direction: [0, 1, 0] },
      xform: IDENTITY12,
      parent_xform: IDENTITY12,
    };
    const after = {
      ...before,
      subject_port: { kind: "marker", name: "Port_A", position: [0, 2, 0], direction: [0, -1, 0] },
    };
    const { client, mutations } = mockClient([() => before, () => after]);
    const result = await connectPorts(
      client,
      connectPortsArgsSchema.parse({ scenePath: "res://a.tscn", subject: "Pipe2", subjectPort: "Port_A", target: "Pipe1", targetPort: "Port_B" })
    );
    expect(mutations[0]![0]).toMatchObject({ op: "SetProp", path: "Pipe2", key: "transform" });
    expect(result).toMatchObject({ ok: true, evidence: "markers", rotated_degrees: 90, verify: { distance: 0, angle_degrees: 0 } });
  });

  it("accepts marker names or loop indices only", () => {
    const base = { scenePath: "res://a.tscn", subject: "A", target: "B", targetPort: 0 };
    expect(connectPortsArgsSchema.safeParse({ ...base, subjectPort: 2 }).success).toBe(true);
    expect(connectPortsArgsSchema.safeParse({ ...base, subjectPort: "Port_A" }).success).toBe(true);
    expect(connectPortsArgsSchema.safeParse({ ...base, subjectPort: -1 }).success).toBe(false);
    expect(connectPortsArgsSchema.safeParse({ ...base, subjectPort: 1.5 }).success).toBe(false);
    expect(connectPortsArgsSchema.safeParse({ ...base, subjectPort: 0, maxTriangles: 100 }).success).toBe(true);
  });

  it("documents roll precisely: axis, sign and zero reference", () => {
    const text = String(connectPortsArgsSchema.shape.rollDegrees.description);
    expect(text).toContain("target port's direction reversed");
    expect(text).toContain("right-hand rule");
    expect(text).toContain("CURRENT orientation");
  });

  // A bend whose port A already faces the target: the shortest turn is none,
  // so rollDegrees alone turns it about roll_axis = -(target direction).
  const bendBefore = {
    ok: true,
    subject_port: {
      kind: "marker",
      name: "End_A",
      position: [0, 0, 0],
      direction: [0, 0, -1],
      others: [{ kind: "marker", name: "End_B", position: [1, 0, -1], direction: [1, 0, 0] }],
      others_total: 1,
    },
    target_port: { kind: "marker", name: "End", position: [5, 0, 0], direction: [0, 0, 1] },
    xform: IDENTITY12,
    parent_xform: IDENTITY12,
  };

  it("turns by the right-hand rule about roll_axis", () => {
    const subject = { basis: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as [Vec3, Vec3, Vec3], origin: [0, 0, 0] as Vec3 };
    const sp = bendBefore.subject_port as unknown as Parameters<typeof connectTransform>[1];
    const tp = bendBefore.target_port as unknown as Parameters<typeof connectTransform>[2];
    const { rotation, rollAxis, joint } = connectTransform(subject, sp, tp, 0, 90);
    rollAxis.forEach((v, k) => expect(v).toBeCloseTo([0, 0, -1][k]!));
    expect(joint).toEqual([5, 0, 0]);
    // +90 about -z: the free end turns from +x to -y.
    basisMulVec(rotation, [1, 0, 0]).forEach((v, k) => expect(v).toBeCloseTo([0, -1, 0][k]!));
  });

  // Field evidence (proof run): each duct bend needed a measure call and a
  // second connect because the receipt did not say where the other end went.
  it("reports where every other port of the subject ends up, measured by the verify read", async () => {
    const after = {
      ...bendBefore,
      subject_port: {
        ...bendBefore.subject_port,
        position: [5, 0, 0],
        others: [{ kind: "marker", name: "End_B", position: [5, -1, -1], direction: [0, -1, 0] }],
      },
    };
    const { client, probeCalls } = mockClient([() => bendBefore, () => after]);
    const result = await connectPorts(
      client,
      connectPortsArgsSchema.parse({ scenePath: "res://a.tscn", subject: "Duct/Bend_1", subjectPort: "End_A", target: "Duct/Run_2", targetPort: "End", rollDegrees: 90 })
    );
    expect(probeArgs(probeCalls[0]!)).toMatchObject({ cmd: "ports", other_ports: true });
    expect(result).toMatchObject({
      ok: true,
      roll_axis: [0, 0, -1],
      roll_degrees: 90,
      other_ports: [{ kind: "marker", name: "End_B", position: [5, -1, -1], direction: [0, -1, 0] }],
      verify: { distance: 0, angle_degrees: 0 },
    });
    expect(result).not.toHaveProperty("other_ports_predicted");
  });

  it("predicts the other ports from the move when the verify read fails", async () => {
    const { client } = mockClient([() => bendBefore, () => ({ ok: false, failure_reason: "scene_not_open", error: "closed" })]);
    const result = await connectPorts(
      client,
      connectPortsArgsSchema.parse({ scenePath: "res://a.tscn", subject: "Duct/Bend_1", subjectPort: "End_A", target: "Duct/Run_2", targetPort: "End", rollDegrees: 90 })
    );
    expect(result).toMatchObject({
      ok: true,
      other_ports_predicted: true,
      other_ports: [{ name: "End_B", position: [5, -1, -1], direction: [0, -1, 0] }],
      verify: { ok: false },
    });
  });
});
