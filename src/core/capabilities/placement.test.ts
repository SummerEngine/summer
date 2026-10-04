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
  isSafeNodePath,
  isSafeResPath,
} from "./placement.js";
import { PLACEMENT_ARGS_TOKEN, buildPlacementScript, encodeScriptArgs, placementProbeTemplate } from "./placement-script.js";
import { basisMulVec, parseGodotTransform, parseGodotVector3, type Vec3 } from "./placement-math.js";

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

  it("sends SetProp transform then SnapToSurface along -normal at the standoff", async () => {
    const read = {
      ok: true,
      steps: [
        { ok: true, space: "world", dirs: WORLD_DIRS, nodes: [bounds("Lamp", [[-0.1, 0.1], [0, 0.4], [-0.15, 0]], { reach: 0.5 })] },
        { ok: true, origin: [3, 2, 0], direction: [1, 0, 0], physics_available: true, physics: { path: "Wall", point: [4, 2, 0], normal: [-1, 0, 0], distance: 1 } },
      ],
    };
    const { client, mutations, probeCalls } = mockClient(() => read, {
      mutationResults: (ops) =>
        ops.map((op) =>
          op.op === "SnapToSurface"
            ? { ok: true, op: op.op, evidence: "physics", supportPath: "Wall", finalGap: 0.02, after: { origin: [3.98, 2, 0] } }
            : { ok: true, op: op.op }
        ),
    });
    const result = await attachToSurface(
      client,
      attachToSurfaceArgsSchema.parse({ scenePath: "res://a.tscn", subject: "Lamp", surface: "Wall", standoff: 0.02 })
    );
    const steps = probeArgs(probeCalls[0]!).steps as Op[];
    expect(steps[1]).toMatchObject({ cmd: "raycast", from_subject: "Lamp", surface: "Wall", exclude: ["Lamp"] });
    const [setProp, snap] = mutations[0]!;
    expect(setProp).toMatchObject({ op: "SetProp", path: "Lamp", key: "transform" });
    const t = parseGodotTransform(String(setProp!.value))!;
    // Back (-z) now faces +x, into the wall whose normal is -x; origin in front of the wall.
    expect(basisMulVec(t.basis, [0, 0, -1]).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([1, 0, 0]);
    expect(t.origin[0]).toBeCloseTo(4 - (0.5 + 0.02 + 0.05));
    expect(snap).toMatchObject({ op: "SnapToSurface", subject_path: "Lamp", direction: [1, 0, 0], gap: 0.02, align_up: false });
    expect(mutations[1]).toEqual([{ op: "SaveScene" }]);
    expect(result).toMatchObject({ ok: true, saved: true, surface_hit: { evidence: "physics", path: "Wall" }, seat: { supportPath: "Wall", finalGap: 0.02 } });
  });

  it("reports an unseated, unsaved piece honestly when SnapToSurface fails", async () => {
    const read = {
      ok: true,
      steps: [
        { ok: true, nodes: [bounds("Lamp", [[0, 1], [0, 1], [0, 1]])], dirs: WORLD_DIRS },
        { ok: true, physics_available: true, physics: { path: "Wall", point: [0, 0, 0], normal: [0, 0, 1], distance: 1 } },
      ],
    };
    const { client, mutations } = mockClient(() => read, {
      mutationResults: (ops) =>
        ops.map((op) => (op.op === "SnapToSurface" ? { ok: false, op: op.op, failure_reason: "no_support", error: "no support surface" } : { ok: true, op: op.op })),
    });
    const result = await attachToSurface(client, attachToSurfaceArgsSchema.parse({ scenePath: "res://a.tscn", subject: "Lamp", ray: { origin: [0, 0, 1], direction: [0, 0, -1] } }));
    expect(mutations).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, mutationApplied: true, saved: false, seat: { failure_reason: "no_support" } });
    expect(String(result.note)).toContain("NOT seated");
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
  });
});
