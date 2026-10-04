import { describe, expect, it } from "vitest";
import {
  clearanceDirections,
  groupRepeats,
  judgeDuplicates,
  judgeFloorGaps,
  judgeInserts,
  judgeLights,
  judgeLongProps,
  judgeMounts,
  judgeOverlaps,
  judgeSupport,
  judgeThroughHoles,
  judgeTransforms,
  judgeUv,
  judgeZFight,
  parsePackGrounds,
  type InstRow,
} from "./judge.js";

const ID9 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const YAW_180 = [-1, 0, 0, 0, 1, 0, 0, 0, -1];

function row(p: string, over: Partial<InstRow> = {}): InstRow {
  return {
    p,
    k: p.split("/").pop()!.toLowerCase(),
    s: `res://kit/${p.split("/").pop()!.toLowerCase()}.tscn`,
    r: "prop",
    in: true,
    o: [0, 0, 0],
    b: ID9,
    sc: [1, 1, 1],
    det: 1,
    c: [0, 0.5, 0],
    e: [1, 1, 1],
    le: [1, 1, 1],
    lc: [0, 0.5, 0],
    m: 1,
    f: [0, 0, 0],
    ...over,
  };
}

describe("through_hole", () => {
  // A back facade facing -Z at z = -8 (d = 8 along n = -Z), tangent t = -X.
  const inst = [
    row("House3/Back/B0_f1", { k: "high_rise_facade_frame_tripple", r: "wall" }),
    row("House3/Back/B0_f1_door", { k: "door_tripple_standard_03", r: "insert" }),
    row("House3/Back/B0_d2", { k: "high_rise_facade_wall_double", r: "wall" }),
  ];
  const s = 0.286;
  const column = (t: number) => [0.143, 0.429, 0.715, 1.001, 1.287, 1.573, 1.859, 2.145].map((y) => [t, y, 0, 6.9, t - 0.17, t + 0.19, y - 0.143, y + 0.143]);
  const line = {
    n: [0, 0, -1],
    t: [-1, 0, 0],
    d: 8.03,
    spacing: s,
    through: [...column(-32.45), ...column(-30.45)],
    pieces: [
      [0, -33.0, -30.0, 0, 3],
      [2, -35.0, -33.0, 0, 3],
    ],
    inserts: [[1, -32.66, -30.34, 0, 2.74]],
    zfight: [],
  };

  it("clusters each column, merges both sides of one door into one error on the frame", () => {
    const issues = judgeThroughHoles([line], inst);
    expect(issues).toHaveLength(1);
    const i = issues[0]!;
    expect(i).toMatchObject({ check: "through_hole", severity: "error", path: "House3/Back/B0_f1" });
    expect(i.ev.rays).toBe(16);
    expect(i.ev.beside).toContain("House3/Back/B0_f1_door");
    expect((i.ev.gaps as unknown[]).length).toBe(2);
    expect(i.why).toMatch(/see-through gaps/);
    // The world position is on the facade plane at the cluster centre.
    expect(i.pos[2]).toBeCloseTo(-8.03, 2);
    expect(Math.abs(i.pos[0])).toBeGreaterThan(30);
    // The reproduction ray starts in front of the wall and points into it.
    expect((i.ev.ray as number[][])[1]).toEqual([0, 0, 1]);
    expect(i.frame!.dirs[0]!.dir).toEqual([0, 0, -1]);
  });

  it("a single stray ray is a warning, not an error", () => {
    const issues = judgeThroughHoles([{ ...line, through: [[-34, 1, 1, 6.9, -34.01, -33.99, 0.99, 1.01]] }], inst);
    expect(issues[0]!.severity).toBe("warn");
    expect(issues[0]!.path).toBe("House3/Back/B0_d2");
  });
});

describe("floor_gap", () => {
  const tiles = Array.from({ length: 4 }, (_, i) => row(`Ground/T${i}`, { k: "alley_floor_b", r: "floor", c: [i * 8, 0, 0], e: [8, 0.1, 7.5] }));
  const inst = [...tiles, row("Ground/Underlay", { k: "Underlay", r: "underlay" }), row("Ground/Odd", { k: "odd_tile", r: "floor" })];

  it("a piece whose own mesh has holes in every tile is ONE issue for the piece", () => {
    const issues = judgeFloorGaps({ cell: 0.3, per_owner: tiles.map((_, i) => [i, 500, 250, 0]), gaps: [[0, 0, 0.02, 0, 4, -0.005]] }, inst);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "warn", check: "floor_gap" });
    expect(issues[0]!.why).toMatch(/alley_floor_b has holes in its own mesh: 50%/);
  });

  it("other gaps cluster by location; the void is an error, the underlay a warning", () => {
    const gaps = [
      [10, 10, 0.02, 5, -1, null],
      [10.3, 10, 0.02, 5, -1, null],
      [10.6, 10, 0.02, 5, -1, null],
      [30, 5, 0.02, 5, 4, -0.005],
      [30.3, 5, 0.02, 5, 4, -0.005],
      [30.3, 5.3, 0.02, 5, 4, -0.005],
    ];
    const issues = judgeFloorGaps({ cell: 0.3, per_owner: [[5, 500, 6, 3]], gaps }, inst);
    expect(issues.map((i) => i.severity).sort()).toEqual(["error", "warn"]);
    expect(issues.find((i) => i.severity === "error")!.why).toMatch(/fall to the void/);
    expect(issues.find((i) => i.severity === "warn")!.why).toMatch(/Ground\/Underlay/);
  });
});

describe("floor_gap: what the first hit says (audit fix run, three_houses_v2)", () => {
  // Kernel rows: [x, z, top, owner, first hit, first hit y, clearance, kind,
  // sx, sz, area, floor y under the underlay, that floor, strip wall].
  const tiles = Array.from({ length: 4 }, (_, i) => row(`Ground/B${i}`, { k: "alley_floor_b", s: "res://starter/real-city-alley-kit/ground/alley_floor_b.tscn", r: "floor", c: [i * 8.4, 0, 0], e: [8.4, 0.1, 7.5] }));
  const inst = [
    ...tiles,
    row("Ground/Underlay", { k: "Underlay", s: "", r: "underlay" }),
    row("Ground/Al_3", { k: "alley_floor_c", s: "res://starter/real-city-alley-kit/ground/alley_floor_c.tscn", r: "floor", c: [21, 0, -11], e: [8.4, 0.08, 7.46] }),
    row("Ground/Mid_3", { k: "alley_floor_b", s: "res://starter/real-city-alley-kit/ground/alley_floor_b.tscn", r: "floor", c: [21, 0, -3.8], e: [8.4, 0.1, 7.54] }),
    row("Alley1/Backdrop", { k: "wall_backdrop", r: "wall" }),
  ];
  const UNDERLAY = 4;
  const AL3 = 5;
  const MID3 = 6;
  const WALL = 7;
  const PACKS = [["res://starter/real-city-alley-kit", "PACK.json", "res://starter/real-city-alley-kit/materials/alley_ground.tres", "for any other ground use material res://starter/real-city-alley-kit/materials/alley_ground.tres on a PlaneMesh"]];

  it("an underlay ABOVE the floor's own low surface (a drain channel) covers the floor: warn, not a hole", () => {
    // Al_3's drainage channel: bottom at y -0.049; the underlay sat at -0.005.
    const channel = Array.from({ length: 9 }, (_, k) => [20 + (k % 3) * 0.3, -9 - Math.floor(k / 3) * 0.3, 0.02, AL3, UNDERLAY, -0.005, null, 0, 0.3, 0.3, 0.09, -0.049, AL3, -1]);
    const issues = judgeFloorGaps({ cell: 0.3, per_owner: [[AL3, 400, 0, 0, 9]], gaps: channel }, inst);
    expect(issues).toHaveLength(1);
    const [i] = issues;
    expect(i).toMatchObject({ check: "floor_gap", severity: "warn", path: "Ground/Al_3", ev: { underlay: "Ground/Underlay", floor_low_y: -0.049, above_m: 0.044 } });
    expect(i!.why).toMatch(/Ground\/Underlay covers the floor over 0.81 m2/);
    expect(i!.why).toMatch(/not a hole/);
    expect(i!.why).not.toMatch(/miss the floor/);
    expect(i!.next).toMatch(/lower Ground\/Underlay under y -0.054/);
  });

  it("a tile whose low surfaces the underlay covers in every tile is one 'covers' issue; its real voids stay holes", () => {
    // floor_b: 19% real voids, a further 14% of low surfaces under the old underlay.
    const per_owner = tiles.map((_, i) => [i, 500, 95, 0, 70]);
    const gaps = [[1, 1, 0.026, 0, UNDERLAY, -0.005, null, 0, 0.3, 0.3, 0.09, -0.02, 0, -1]];
    const issues = judgeFloorGaps({ cell: 0.3, per_owner, gaps }, inst, parsePackGrounds(PACKS));
    expect(issues).toHaveLength(2);
    const holes = issues.find((i) => i.why.includes("holes in its own mesh"))!;
    expect(holes.why).toMatch(/19% of each tile shows the underlay \(4\/4 tiles\)/);
    const covers = issues.find((i) => i.why.includes("covers alley_floor_b's own low surfaces"))!;
    expect(covers).toMatchObject({ severity: "warn", ev: { fraction: 0.14, underlay: "Ground/Underlay", floor_low_y: -0.02 } });
    // The pack's documented ground option is in the next step.
    expect(holes.next).toContain("the pack documents a ground alternative (PACK.json): res://starter/real-city-alley-kit/materials/alley_ground.tres on a PlaneMesh");
    expect(holes.ev.pack_ground).toBe("res://starter/real-city-alley-kit/materials/alley_ground.tres");
  });

  it("a 4 cm x 8.4 m seam is 0.34 m2 with its dimensions, not 84 grid cells (8.66 m2)", () => {
    // Seam rays every 10 cm along x between Al_3 (z -7.578) and Mid_3 (z -7.538).
    const seam = Array.from({ length: 84 }, (_, k) => [16.85 + k * 0.1, -7.558, 0.02, AL3, UNDERLAY, -0.055, null, 1, 0.1, 0.04, 0.004, null, -1, -1]);
    const [i] = judgeFloorGaps({ cell: 0.321, per_owner: [], gaps: seam }, inst);
    expect(i!.ev).toMatchObject({ rays: 84, area_m2: 0.336, w: 8.4, d: 0.04 });
    expect(i!.why).toMatch(/^floor gap 0.34 m2 \(8.4 x 0.04 m\): 84 down rays/);
    expect(i!.score).toBeCloseTo(0.336, 3);
  });

  it("a bare strip between the last tile and the alley's back wall is reported with the wall, its size and the pack's ground", () => {
    // The tile row ends at z -15.08; the backdrop is at -15.305: 34 edge steps x 2 rays.
    const strip = Array.from({ length: 68 }, (_, k) => [-4.075 + Math.floor(k / 2) * 0.25, -15.13 - (k % 2) * 0.1025, 0.02, 0, UNDERLAY, -0.055, null, 2, 0.25, 0.1025, 0.025625, null, -1, WALL]);
    const issues = judgeFloorGaps({ cell: 0.32, per_owner: [], gaps: strip }, inst, parsePackGrounds(PACKS));
    expect(issues).toHaveLength(1);
    const [i] = issues;
    expect(i).toMatchObject({ check: "floor_gap", severity: "warn", path: "Ground/B0", ev: { wall: "Alley1/Backdrop", rays: 68 } });
    expect(i!.why).toMatch(/^bare strip 8.5 x 0.2 m \(1.74 m2\) between Ground\/B0's edge and Alley1\/Backdrop: the floor stops short of the wall and Ground\/Underlay shows/);
    expect(i!.next).toMatch(/^summer_measure Ground\/B0 vs Alley1\/Backdrop; extend the floor to the wall; the pack documents a ground alternative/);
  });

  it("strips are never folded into a holed piece's per-piece issue; old kernel rows still count one grid cell each", () => {
    const per_owner = tiles.map((_, i) => [i, 500, 250, 0]);
    const strip = [[0, -15.13, 0.02, 0, UNDERLAY, -0.055, null, 2, 0.25, 0.1, 0.025, null, -1, WALL], [0.25, -15.13, 0.02, 0, UNDERLAY, -0.055, null, 2, 0.25, 0.1, 0.025, null, -1, WALL]];
    const issues = judgeFloorGaps({ cell: 0.3, per_owner, gaps: [[2, 2, 0.02, 0, UNDERLAY, -0.005], ...strip] }, inst);
    expect(issues.map((i) => i.why.split(":")[0])).toEqual(["alley_floor_b has holes in its own mesh", "bare strip 0.5 x 0.1 m (0.05 m2) between Ground/B0's edge and Alley1/Backdrop"]);
    const old = judgeFloorGaps({ cell: 0.3, per_owner: [], gaps: [[30, 5, 0.02, MID3, UNDERLAY, -0.005], [30.3, 5, 0.02, MID3, UNDERLAY, -0.005], [30.6, 5, 0.02, MID3, UNDERLAY, -0.005]] }, inst);
    expect(old[0]!.ev).toMatchObject({ rays: 3, area_m2: 0.27, w: 0.9, d: 0.3 });
  });
});

describe("floating / sunken", () => {
  const inst = [row("Props/Crate", { c: [0, 0.3, 0], e: [0.6, 0.6, 0.6] }), row("Ground/Tile", { r: "floor" }), row("Props/Lamp", { mh: [0, 0, -1], ms: "pack_text" }), row("Props/Bottle", { e: [0.2, 0.2, 0.3] })];
  const hits = (y: number) => Array.from({ length: 5 }, () => [y, 1]);

  it("reports a gap above 2 cm and an embed deeper than 3 cm, nothing in between", () => {
    expect(judgeSupport([[0, 0.05, 0.35, hits(0.0)]], inst, new Set())).toMatchObject([{ check: "floating", severity: "warn" }]);
    expect(judgeSupport([[0, 0.019, 0.35, hits(0.0)]], inst, new Set())).toEqual([]);
    expect(judgeSupport([[0, -0.025, 0.3, hits(0.0)]], inst, new Set())).toEqual([]);
    expect(judgeSupport([[0, -0.05, 0.3, hits(0.0)]], inst, new Set())).toMatchObject([{ check: "sunken", severity: "look" }]);
    expect(judgeSupport([[0, 0.3, 0.6, hits(0.0)]], inst, new Set())[0]!.severity).toBe("error");
  });

  it("nothing under it within 1 m is an error; a wall-held piece is not floating", () => {
    expect(judgeSupport([[0, 1, 1.3, [null, null, null, null, null]]], inst, new Set())[0]).toMatchObject({ severity: "error", check: "floating" });
    expect(judgeSupport([[2, 2.2, 2.5, [null, null, null, null, null], 0.01]], inst, new Set())).toEqual([]);
    // A wall lamp (mount hint) whose bracket box ends 10 cm from the wall is held; a crate is not.
    expect(judgeSupport([[2, 2.2, 2.5, [null, null, null, null, null], 0.1]], inst, new Set())).toEqual([]);
    expect(judgeSupport([[0, 2.2, 2.5, [null, null, null, null, null], 0.1]], inst, new Set())).toHaveLength(1);
    expect(judgeSupport([[0, 1, 1.3, [null, null, null, null, null]]], inst, new Set([0]))).toEqual([]);
  });

  it("a prop at floor level over a hole in the tile (only the underlay below) is a look item", () => {
    const withUnderlay = [...inst, row("Ground/Underlay", { r: "underlay" })];
    const under = Array.from({ length: 5 }, () => [-0.1, 4]);
    const [i] = judgeSupport([[0, 0.0, 0.3, under, null, 0.011]], withUnderlay, new Set());
    expect(i).toMatchObject({ check: "floating", severity: "look" });
    expect(i!.why).toMatch(/over a hole in the floor/);
    expect(judgeSupport([[0, 0.3, 0.6, under, null, 0.011]], withUnderlay, new Set())[0]!.severity).toBe("error");
  });

  it("a prop buried to half its height is an error", () => {
    expect(judgeSupport([[3, -0.145, 0.0, hits(-0.005)]], inst, new Set())[0]).toMatchObject({ check: "sunken", severity: "error" });
  });
});

describe("sunken: the surface it is buried in, seen from above (Alley1/Props/Bottle)", () => {
  // Stood upright with its origin on the floor: half of its 0.29 m below
  // floor_b's top (y 0.021); the support ray from y 0 only sees the underlay.
  const inst = [
    row("Alley1/Props/Bottle", { c: [3, 0, 2], e: [0.08, 0.29, 0.08] }),
    row("Ground/B5", { k: "alley_floor_b", r: "floor" }),
    row("Ground/Underlay", { k: "Underlay", r: "underlay" }),
    row("Alley1/Props/Grass4", { r: "dressing", c: [5, 0, 2], e: [0.4, 0.2, 0.4] }),
    row("Alley1/Props/Crate", { c: [7, 0.3, 2], e: [0.6, 0.6, 0.6] }),
  ];
  const n5 = (y: number, at: number) => Array.from({ length: 5 }, () => [y, at]);

  it("names the floor tile from above and the embed relative to its top, not the underlay under it", () => {
    const [i] = judgeSupport([[0, -0.145, 0.0, n5(-0.005, 2), null, 0.021, n5(0.021, 1)]], inst, new Set());
    expect(i).toMatchObject({ check: "sunken", severity: "error", path: "Alley1/Props/Bottle", ev: { embed_m: 0.166, support: "Ground/B5", support_y: 0.021, under_it: "Ground/Underlay" } });
    expect(i!.why).toBe("sunk 16.6 cm into Ground/B5 (the first surface from above, at y 0.021): 57% of its height");
  });

  it("the majority surface wins; surfaces above the prop's top (an awning) are not support", () => {
    const mixed = [[0.021, 1], [0.021, 1], [0.021, 1], [-0.005, 2], [-0.005, 2]];
    expect(judgeSupport([[0, -0.145, 0.0, n5(-0.005, 2), null, 0.021, mixed]], inst, new Set())[0]!.ev.support).toBe("Ground/B5");
    // Only an awning above it: the support rays below decide (the old path).
    const awning = judgeSupport([[0, -0.145, 0.0, n5(-0.005, 2), null, 0.021, n5(0.5, 4)]], inst, new Set());
    expect(awning[0]).toMatchObject({ check: "sunken", ev: { support: "Ground/Underlay" } });
  });

  it("a crate standing on the floor is not sunken, and buried dressing (grass) is never reported", () => {
    expect(judgeSupport([[4, 0.0, 0.3, n5(0.0, 1), null, 0.021, n5(0.0, 1)]], inst, new Set())).toEqual([]);
    expect(judgeSupport([[3, -0.1, 0.0, n5(-0.005, 2), null, 0.021, n5(0.021, 1)]], inst, new Set())).toEqual([]);
    // Floating is unchanged: 5 cm above the floor seen from above and below.
    expect(judgeSupport([[4, 0.05, 0.35, n5(0.0, 1), null, 0.021, n5(0.0, 1)]], inst, new Set())).toMatchObject([{ check: "floating", severity: "warn" }]);
  });
});

describe("interpenetration", () => {
  it("reports overlaps over 3 cm with the other node and its role", () => {
    const inst = [row("Alley3/Props/Bench"), row("Alley3/WallR_0", { r: "wall" })];
    expect(judgeOverlaps([[0, 1, 0.029, [0, 0, 0]]], inst)).toEqual([]);
    const [i] = judgeOverlaps([[0, 1, 0.157, [42, 0.44, -12.45]]], inst);
    expect(i).toMatchObject({ severity: "warn", path: "Alley3/Props/Bench", ev: { other: "Alley3/WallR_0", other_role: "wall" } });
  });

  it("a bench through a wall into the wall behind it is ONE issue (deepest first, the rest listed)", () => {
    const inst = [row("Alley3/Props/Bench2"), row("Alley3/Sep_W", { r: "wall" }), row("Alley2/Sep_E", { r: "wall" })];
    const issues = judgeOverlaps([[0, 2, 0.103, [29.9, 0, -9.8]], [0, 1, 0.123, [30, 0, -9.9]]], inst);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.ev).toMatchObject({ other: "Alley3/Sep_W", partners: [["Alley3/Sep_W", 0.123], ["Alley2/Sep_E", 0.103]] });
    expect(issues[0]!.why).toContain("also Alley2/Sep_E (the structure) 10.3 cm");
  });

  it("every partner a prop cuts is named, up to 3, shallow ones included (Lamp1: the duct AND the door band)", () => {
    const inst = [
      row("Alley2/Props/Lamp1", { k: "street_lamp_02" }),
      row("Alley2/Duct/Run_2", { r: "mount" }),
      row("House2/Back/B0_band2", { r: "struct" }),
      row("Alley2/Props/AC2", { k: "aircon_unit_rusted" }),
      row("House2/Back/B0_w2", { r: "wall" }),
    ];
    const [i, ...rest] = judgeOverlaps([[0, 2, 0.024, [18.0, 3.2, -7.9]], [0, 1, 0.187, [17.9, 3.4, -7.8]], [0, 3, 0.012, [17.77, 2.6, -7.8]], [0, 4, 0.011, [17.9, 2.5, -8]]], inst);
    expect(rest).toEqual([]);
    expect(i!.why).toBe("overlaps Alley2/Duct/Run_2 (a mounted piece) by 18.7 cm; also House2/Back/B0_band2 (the structure) 2.4 cm, Alley2/Props/AC2 (another prop) 1.2 cm");
    expect(i!.ev).toMatchObject({ depth_m: 0.187, partners: [["Alley2/Duct/Run_2", 0.187], ["House2/Back/B0_band2", 0.024], ["Alley2/Props/AC2", 0.012]], more: 1 });
    expect(i!.next).toContain("summer_test_placement Alley2/Props/Lamp1");
    // Only shallow contacts (under 3 cm): no issue at all.
    expect(judgeOverlaps([[0, 2, 0.024, [0, 0, 0]], [0, 3, 0.012, [0, 0, 0]]], inst)).toEqual([]);
  });
});

describe("insert_host", () => {
  const inst = [
    row("House3/Back/B0_f1_door", { k: "door_tripple_standard_03", r: "insert", o: [31.5, 0, -7.9], b: YAW_180 }),
    row("House3/Back/B0_f1", { k: "high_rise_facade_frame_tripple", r: "wall", o: [31.5, 0, -7.9], b: YAW_180 }),
    row("House2/Back/B0_door", { k: "wall_tripple_standard_door_01", r: "wall", o: [21, 0, -8], b: YAW_180 }),
    row("House2/Back/B0_door_ins", { k: "door_tripple_standard_01", r: "insert", o: [21, 0, -7.98], b: YAW_180 }),
  ];

  it("a door in the wrong host is an error that names the host it actually sits in", () => {
    const [i] = judgeInserts([[0, "wall_tripple_standard_door_02", [0, 0, -0.105], [31.5, 0, -7.9], YAW_180, [[1, "high_rise_facade_frame_tripple", [31.5, 0, -7.9], YAW_180]], [1]]], inst);
    expect(i).toMatchObject({ check: "insert_host", severity: "error", path: "House3/Back/B0_f1_door" });
    expect(i!.why).toContain("high_rise_facade_frame_tripple House3/Back/B0_f1");
    expect(i!.ev).toMatchObject({ found: "high_rise_facade_frame_tripple", off_m: 0.105 });
    expect((i!.ev.host_at as number[])[2]).toBeCloseTo(-8.01, 2);
  });

  it("a correctly hosted insert is not reported", () => {
    expect(judgeInserts([[3, "wall_tripple_standard_door_01", [0, 0, -0.02], [21, 0, -7.98], YAW_180, [[2, "wall_tripple_standard_door_01", [21, 0, -8], YAW_180]], [2]]], inst)).toEqual([]);
  });
});

describe("mount_gap and mount orientation", () => {
  // Far apart: bounds that touch another mounted piece count as held by it.
  const inst = [
    row("Alley1/GutterL/Sec_1", { r: "mount", k: "modular_metal_gutter_section", c: [0, 3, 0] }),
    row("House1/Back/B0_f1", { r: "wall", c: [0, 3, -1] }),
    row("Street/LampH1", { mh: [0, 0, -1], ms: "pack_text", c: [20, 3, 0] }),
  ];
  const all = new Set(["mount_gap", "orientation"] as const);

  it("no surface within 5 cm behind the mount side", () => {
    const close = judgeMounts([[0, [0, 0, 1], [0.03, 0.04, null], 1, [[[0, 0, 1], 0.03, 1]], "pipes", "pieces", [0, 0, -1]]], inst, all);
    expect(close.issues).toEqual([]);
    expect(close.wallMounted.has(0)).toBe(true);
    const gap = judgeMounts([[0, [0, 0, 1], [0.059, 0.06], 1, [[[0, 0, 1], 0.059, 1]], "pipes", "pieces", [0, 0, -1]]], inst, all);
    expect(gap.issues).toMatchObject([{ check: "mount_gap", severity: "look", ev: { gap_m: 0.059, mount_side: "-Z", wall: "House1/Back/B0_f1" } }]);
    const far = judgeMounts([[0, [0, 0, 1], [0.4], 1, [], "pipes", "pieces", [0, 0, -1]]], inst, all);
    expect(far.issues[0]!.severity).toBe("warn");
  });

  it("a prose-only hint yields to the geometry: touching a wall on any side means mounted", () => {
    const r = judgeMounts([[2, [1, 0, 0], [0.44], 1, [[[0, 0, -1], 0.0, 1]], "", "pack_text", [0, 0, -1]]], inst, all);
    expect(r.issues).toEqual([]);
    expect(r.wallMounted.has(2)).toBe(true);
    // The same geometry with pieces.json metadata is held against the piece.
    const strict = judgeMounts([[0, [1, 0, 0], [0.44], 1, [[[0, 0, -1], 0.0, 1]], "pipes", "pieces", [0, 0, -1]]], inst, all);
    expect(strict.issues.map((i) => i.check).sort()).toEqual(["mount_gap", "orientation"]);
  });

  it("a piece standing on the ground, or hanging from another mounted piece, is not 'off its wall'", () => {
    // A fence post: nothing behind, standing on the ground.
    expect(judgeMounts([[0, [0, 0, 1], [null], -1, [], "fences_gates", "pieces", [0, 0, -1], null, 0.0]], inst, all).issues).toEqual([]);
    // A fire-escape ladder 95 cm off the wall, hanging from its platform.
    expect(judgeMounts([[0, [0, 0, 1], [0.95], 1, [], "fire_escape", "pieces", [0, 0, -1], 0.0, 1.6]], inst, all).issues).toEqual([]);
    // An open duct elbow whose bounds touch its run (no face for a ray to hit).
    const duct = [row("Duct/Bend", { r: "mount", c: [0, 3, 0], e: [0.5, 0.5, 0.5] }), row("Duct/Run", { r: "mount", c: [0.75, 3, 0], e: [1, 0.5, 0.5] })];
    expect(judgeMounts([[0, [0, 0, 1], [0.96], -1, [], "ducts", "pieces", [0, 0, -1], null, 3]], duct, all).issues).toEqual([]);
    // A gutter 6 cm off the wall is reported even though it touches the next section.
    expect(judgeMounts([[0, [0, 0, 1], [0.06], 1, [[[0, 0, 1], 0.06, 1]], "pipes", "pieces", [0, 0, -1], 0.0, 2]], inst, all).issues).toHaveLength(1);
  });

  it("free-standing pieces.json mounts are flagged; prose-only hints are not", () => {
    expect(judgeMounts([[0, [0, 0, 1], [null], -1, [], "pipes", "pieces", [0, 0, -1]]], inst, all).issues[0]!.why).toMatch(/no wall within 1 m/);
    expect(judgeMounts([[2, [0, 0, 1], [null], -1, [], "", "pack_text", [0, 0, -1]]], inst, all).issues).toEqual([]);
  });

  it("a mount side pointing away from the nearest wall is a look item, never a guess", () => {
    const r = judgeMounts([[0, [0, 0, -1], [null], -1, [[[0, 0, 1], 0.1, 1]], "ducts", "pieces", [0, 0, -1]]], inst, all);
    const o = r.issues.find((i) => i.check === "orientation")!;
    expect(o).toMatchObject({ severity: "look", ev: { angle: 180, mount_side: "-Z" } });
    expect(r.issues.some((i) => i.check === "mount_gap")).toBe(false);
  });
});

describe("mount_gap and orientation: kit-held pieces, documented standoffs, side gaps, symmetric pieces (fix run)", () => {
  // Kernel mount row: [i, wall axis, 9 gaps, first hit, around, category, src,
  // local axis, chain, ground, standoff, standoff source, planes, symmetric, hit per sample].
  const all = new Set(["mount_gap", "orientation"] as const);
  const WALL = 0;
  const gutterInst = [
    row("Alley2/WallR_0", { r: "wall", c: [0, 3, -0.1], e: [20, 6, 0.2] }),
    row("Alley2/Gutter/Brace_1", { k: "modular_metal_gutter_bracing", r: "mount", c: [0, 1.2, 0.1445], e: [0.2, 0.1, 0.289] }),
    row("Alley2/Gutter/Sec_1", { k: "modular_metal_gutter_section", r: "mount", c: [0, 1, 0.14], e: [0.17, 1, 0.16] }),
    row("Alley2/Gutter/Sec_2", { k: "modular_metal_gutter_section", r: "mount", c: [0, 2, 0.1375], e: [0.17, 1, 0.16] }),
    row("Alley2/Gutter/Outlet", { k: "modular_metal_gutter_outlet", r: "mount", c: [0, 0.3, 0.206], e: [0.15, 0.4, 0.26] }),
    row("Alley2/Gutter/Sec_3", { k: "modular_metal_gutter_section", r: "mount", c: [0, 3, 0.23], e: [0.17, 1, 0.16] }),
  ];
  const mount = (i: number, gap: number | null, extra: unknown[] = []) => [i, [0, 0, -1], Array(9).fill(gap), WALL, gap === null ? [] : [[[0, 0, -1], gap, WALL]], "pipes", "pieces", [0, 0, -1], 0.0, null, ...extra];

  it("gutters held off the wall by their own bracing are fine; the run's outlet too; a kinked section is not", () => {
    const rows = [mount(1, -0.001), mount(2, 0.06), mount(3, 0.055), mount(4, 0.076), mount(5, 0.15)];
    const r = judgeMounts(rows, gutterInst, all);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ check: "mount_gap", severity: "warn", path: "Alley2/Gutter/Sec_3", ev: { gap_m: 0.15, wall: "Alley2/WallR_0" } });
    // Without the bracing, the sections are off their wall (and group as one).
    const unbraced = judgeMounts(rows.slice(1), gutterInst, all).issues;
    expect(unbraced.map((i) => i.path).sort()).toEqual(["Alley2/Gutter/Outlet", "Alley2/Gutter/Sec_1", "Alley2/Gutter/Sec_2", "Alley2/Gutter/Sec_3"]);
    const many = Array.from({ length: 27 }, (_, k) => row(`Alley2/Gutter/S${k}`, { k: "modular_metal_gutter_section", r: "mount", c: [k * 5, 1, 0.14], e: [0.17, 1, 0.16] }));
    const grouped = groupRepeats(judgeMounts(many.map((_, k) => mount(k, 0.054 + (k % 6) * 0.001)), many, all).issues, many);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.why).toMatch(/^27 x modular_metal_gutter_section \(0.054..0.059\)/);
  });

  it("a standoff the pack documents (ducts about 0.1 m off the wall) is not a gap; beyond it, it is", () => {
    const duct = [row("Alley2/Duct/Run_2", { k: "modular_airduct_rectangular_01_straight_01", r: "mount", c: [5, 3.6, 0.41], e: [2, 0.6, 0.6] }), row("Alley2/WallR_0", { r: "wall" })];
    const at = (gap: number) => [0, [0, 0, -1], Array(9).fill(gap), 1, [[[0, 0, -1], gap, 1]], "ducts", "pieces", [0, 0, -1], null, 3.6, 0.1, "ASSEMBLY.md", null, null, Array(9).fill(1)];
    expect(judgeMounts([at(0.112)], duct, all).issues).toEqual([]);
    const [i] = judgeMounts([at(0.18)], duct, all).issues;
    expect(i).toMatchObject({ severity: "look", ev: { gap_m: 0.18, standoff_m: 0.1 } });
    expect(i!.why).toContain("the pack allows 10 cm (ASSEMBLY.md)");
  });

  it("the gap is measured at the sides as well as the centre (ShutterWin: 10.2 cm on the sill, 15.2 cm at its sides)", () => {
    const inst = [row("Alley2/ShutterWin", { k: "rollershutter_window_graffiti", r: "mount", c: [20, 1.5, -7.85] }), row("House2/Back/B0_w3_win", { r: "insert" }), row("House2/Back/B0_w3", { r: "wall" })];
    const gaps = [0.102, 0.152, 0.152, 0.152, 0.152, 0.102, 0.152, 0.152, 0.152];
    const hitAt = [1, 2, 2, 2, 2, 1, 2, 2, 2];
    const [i] = judgeMounts([[0, [0, 0, -1], gaps, 1, [[[0, 0, -1], 0.102, 1]], "shutters", "pieces", [0, 0, -1], null, null, null, "", null, null, hitAt]], inst, all).issues;
    expect(i).toMatchObject({ check: "mount_gap", severity: "warn", ev: { gap_m: 0.152, wall: "House2/Back/B0_w3", at: "+Y side", min_m: 0.102 } });
    expect(i!.why).toBe("stands 15.2 cm off House2/Back/B0_w3 on its mount side (-Z) at its +Y side (closest 10.2 cm)");
    // A side ray that passes the wall's edge into a recess 80 cm back is not the gap.
    const edge = [0, 0, 0, 0, 0, 0, 0, 0.8, 0];
    expect(judgeMounts([[0, [0, 0, -1], edge, 2, [[[0, 0, -1], 0, 2]], "shutters", "pieces", [0, 0, -1], null, null, null, "", null, null, hitAt]], inst, all).issues).toEqual([]);
  });

  it("a front-back symmetric piece turned 180 deg is not an orientation item; its gap is measured on the side facing the wall", () => {
    const inst = [row("Alley2/Duct/Run_3", { k: "duct_run", r: "mount", c: [8, 3.6, 0.41], e: [2, 0.6, 0.6] }), row("Alley2/WallR_0", { r: "wall" })];
    const sym = [0.3, 0.5, -0.3, 0.5, -0.3, 0.3];
    const flipped = (planes: unknown, meta: unknown, standoff: number | null, gapToWall = 0.11) => [0, [0, 0, 1], Array(9).fill(null), -1, [[[0, 0, -1], gapToWall, 1]], "ducts", "pieces", [0, 0, -1], null, 3.6, standoff, standoff === null ? "" : "ASSEMBLY.md", planes, meta, Array(9).fill(-1)];
    expect(judgeMounts([flipped(sym, null, 0.1)], inst, all).issues).toEqual([]);
    const off = judgeMounts([flipped(sym, null, null)], inst, all).issues;
    expect(off).toMatchObject([{ check: "mount_gap", severity: "warn", ev: { gap_m: 0.11 } }]);
    expect(off[0]!.why).toContain("measured on the side facing the wall (front-back symmetric)");
    // A wall lantern is not symmetric: its back plate is the larger plane.
    const lantern = judgeMounts([flipped([0.15, 0.01, -0.2, 0.03, -0.2, 0.15], null, null)], inst, all).issues;
    expect(lantern.map((i) => i.check)).toEqual(["orientation"]);
    // pieces.json "symmetric" wins over the planes either way.
    expect(judgeMounts([flipped(sym, false, null)], inst, all).issues.map((i) => i.check)).toEqual(["orientation"]);
    expect(judgeMounts([flipped(null, true, 0.1)], inst, all).issues).toEqual([]);
  });
});

describe("orientation of long props", () => {
  const inst = [row("Alley3/Props/Bench", { k: "park_bench" }), row("Alley3/WallR_0", { r: "wall" })];

  it("a long prop within 1.2 m of a wall and more than 15 deg off parallel is a look item", () => {
    const [i] = judgeLongProps([[0, [-1, 0, 0], 1.83, 0.7, [-0.163, 1, [-1, 0, 0], [1, 0, 0]]]], inst);
    expect(i).toMatchObject({ check: "orientation", severity: "look", path: "Alley3/Props/Bench", ev: { angle: 90, wall: "Alley3/WallR_0" } });
  });

  it("parallel within 15 deg, or farther than 1.2 m, is not reported", () => {
    const r = (12 * Math.PI) / 180;
    expect(judgeLongProps([[0, [Math.sin(r), 0, Math.cos(r)], 1.83, 0.7, [0.3, 1, [-1, 0, 0], [1, 0, 0]]]], inst)).toEqual([]);
    expect(judgeLongProps([[0, [1, 0, 0], 1.83, 0.7, [1.3, 1, [-1, 0, 0], [1, 0, 0]]]], inst)).toEqual([]);
  });
});

describe("uv_stretch", () => {
  const frames = [0, 1, 2, 3].map((i) => row(`House3/F${i}`, { k: "high_rise_facade_frame_tripple", r: "wall" }));
  // Tri 0: a reveal mapped onto one texel column (stretched). Tri 1: a fine
  // square mapping. Tri 2: all three UVs on one texel (a flat colour).
  const tris = [
    [[1.13, 0, 0.1], [1.13, 3, 0.1], [1.13, 0, -0.1], [0.84, 0.04], [0.84, 1], [0.84, 0.04]],
    [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0], [1, 0], [0, 1]],
    [[0, 0, 0], [2, 0, 0], [0, 2, 0], [0.5, 0.5], [0.5, 0.5], [0.5, 0.5]],
  ];

  it("a stretched face that inserts cover elsewhere is a warning where it shows", () => {
    const issues = judgeUv([{ mesh: "frame.glb::ArrayMesh_x", tris, users: 4, shown: [[0, 0b111, [0, 2, -2], [1.13, 1, 0]], [1, 0b111, [0, 2, -2], [1.13, 1, 0]], [2, 0b010, null, null, 0b001], [3, 0b010, null, null, 0b001]] }], frames);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "warn", path: "House3/F0", ev: { mesh: "frame.glb", ratio: "line", shown_in: 2 } });
  });

  it("never covered = the asset's own mapping: one look item; a point-collapsed UV is never stretch", () => {
    const issues = judgeUv([{ mesh: "frame.glb", tris, users: 4, shown: [0, 1, 2, 3].map((i) => [i, 0b101, [0, 2, -2], [1.13, 1, 0], 0]) }], frames);
    expect(issues).toMatchObject([{ severity: "look" }]);
    expect(issues[0]!.ev.area_m2).toBeCloseTo(0.3, 2);
    const flat = judgeUv([{ mesh: "flat.glb", tris: [tris[2]], users: 1, shown: [[0, 0b1, null, null, 0]] }], frames);
    expect(flat).toEqual([]);
  });
});

describe("duplicate / z_fight", () => {
  it("same scene at the same transform is a duplicate; its coplanar pair is not also a z-fight", () => {
    const inst = [row("Props/A", { s: "res://kit/crate.tscn", o: [1, 0, 1] }), row("Props/B", { s: "res://kit/crate.tscn", o: [1.004, 0, 1] }), row("Walls/W1", { r: "wall" }), row("Walls/W2", { r: "wall" })];
    const dup = judgeDuplicates(inst);
    expect(dup.issues).toMatchObject([{ check: "duplicate", severity: "error", path: "Props/B", ev: { other: "Props/A" } }]);
    const z = judgeZFight([{ zfight: [[0, 1, 9, [1, 0.5, 1], [0, 0, 1], [1, 0, 1], [1, 1, 1]], [2, 3, 12, [5, 1, 0], [-1, 0, 0], [5, 0, -1], [5, 2, 0], 3]] }], undefined, inst, dup.pairs);
    expect(z).toHaveLength(1);
    expect(z[0]).toMatchObject({ check: "z_fight", severity: "warn", path: "Walls/W1", ev: { other: "Walls/W2", rays: 12 } });
  });
});

describe("lights, transform", () => {
  it("lights over the per-object limit (Compatibility), hard spot rims", () => {
    const inst = [row("Ground/Tile", { r: "floor" })];
    const issues = judgeLights({ renderer: "gl_compatibility", limit: 8, over: [[0, "Ground/Tile/Mesh", 2, 9, ["A1", "A2"]]], hard_rim: [["Lights/Spot1", 1, [0, 3, 0]]] }, inst);
    expect(issues.map((i) => [i.severity, i.check])).toEqual([["warn", "lights"], ["look", "lights"]]);
    expect(judgeLights({ renderer: "forward_plus", limit: 8, over: [[0, "m", 0, 12, []]], hard_rim: [] }, inst)).toEqual([]);
  });

  it("NaN, mirrored, non-uniform, left at the origin, far out of bounds", () => {
    const spread = Array.from({ length: 20 }, (_, i) => row(`City/P${i}`, { o: [20 + i, 0, 10], c: [20 + i, 0.5, 10] }));
    const inst = [
      ...spread,
      row("City/Nan", { nan: true }),
      row("City/Mirror", { det: -1, sc: [1, 1, 1], o: [25, 0, 10], c: [25, 0.5, 10] }),
      row("City/Stretched", { sc: [1, 2, 1], o: [26, 0, 10], c: [26, 0.5, 10] }),
      row("City/Origin", { o: [0, 0, 0], c: [0, 0.5, 0] }),
      row("City/Far", { o: [3000, 0, 0], c: [3000, 0.5, 0] }),
    ];
    const issues = judgeTransforms(inst);
    const by = (p: string) => issues.filter((i) => i.path === p).map((i) => i.severity);
    expect(by("City/Nan")).toEqual(["error"]);
    expect(by("City/Mirror")).toEqual(["warn"]);
    expect(by("City/Stretched")).toEqual(["look"]);
    expect(by("City/Origin")).toEqual(["warn"]);
    expect(by("City/Far")).toEqual(["warn"]);
    expect(by("City/P3")).toEqual([]);
  });
});

describe("grouping repeats", () => {
  it("three or more of the same finding on the same piece become one issue with a count", () => {
    const inst = [0, 1, 2, 3].map((i) => row(`Alley/Gutter/Sec_${i}`, { k: "gutter_section", r: "mount" }));
    const issues = inst.map((r, i) => ({ check: "mount_gap" as const, severity: "look" as const, path: r.p, pos: [0, 0, 0] as const, why: "stands 5.9 cm off the wall", ev: { gap_m: 0.054 + i * 0.001 }, next: "x", score: 0.05 }));
    const grouped = groupRepeats(issues, inst);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.ev.count).toBe(4);
    expect(grouped[0]!.why).toMatch(/^4 x gutter_section \(0.054..0.057\)/);
    expect(groupRepeats(issues.slice(0, 2), inst)).toHaveLength(2);
  });

  it("the 16 clearance directions: 8 at 20 deg up, 8 at 45 deg up, unit length", () => {
    const dirs = clearanceDirections();
    expect(dirs).toHaveLength(16);
    for (const d of dirs) expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 9);
    expect(dirs[0]![1]).toBeCloseTo(Math.sin((20 * Math.PI) / 180), 9);
    expect(dirs[8]![1]).toBeCloseTo(Math.sin((45 * Math.PI) / 180), 9);
  });
});
