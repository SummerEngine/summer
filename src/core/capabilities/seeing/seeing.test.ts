import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolInputError } from "../../tool-errors.js";
import { fakeEngine, OK_JPEG } from "../../../test-helpers/seeing-engine.js";
import {
  debugViews,
  frameNodes,
  frameShot,
  judgeViewOptions,
  layoutGrid,
  shotSheet,
  validateLabel,
  validateNodePath,
  validateScenePath,
  viewOptions,
  zoom,
  type SeeingSuccess,
} from "./seeing.js";
import { buildWrapperScene, escapeTscnString, loadKernelSource } from "./probe.js";

let project: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "seeing-project-"));
  writeFileSync(join(project, "project.godot"), "config_version=5\n");
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

const ROW_BOUNDS = { position: [-22, 0, -8], size: [44, 18, 9] };

function analyzeBounds(config: Record<string, unknown>) {
  return {
    ok: true,
    stage: "done",
    subjects: ((config.subjects ?? []) as string[]).map((p) => ({ path: p, resolved: p, has_geometry: true, visuals: 12, aabb: ROW_BOUNDS })),
  };
}

const HOSTILE = ["$&", "$`", "$'", '"); OS.execute("rm", ["-rf", "/"]); ("', "line\nbreak", "quote\"d", "back\\slash", "../../etc/passwd"];

describe("input validation: caller text never reaches a scene file or GDScript unchecked", () => {
  it.each(HOSTILE)("refuses node path %j", (value) => {
    expect(() => validateNodePath(value, "nodes[0]")).toThrow(ToolInputError);
  });
  it.each([...HOSTILE, "res://a.gd", "user://x.tscn", "res://../x.tscn", 'res://a".tscn'])("refuses scene path %j", (value) => {
    expect(() => validateScenePath(value)).toThrow(ToolInputError);
  });
  it.each(["$&", 'a"b', "a'b", "a`b", "a\\b", "a\nb", "x".repeat(65)])("refuses label %j", (value) => {
    expect(() => validateLabel(value)).toThrow(ToolInputError);
  });
  it("accepts ordinary names", () => {
    expect(validateNodePath("House1/Front Door", "n")).toBe("House1/Front Door");
    expect(validateScenePath("res://levels/Town (v2).tscn")).toBe("res://levels/Town (v2).tscn");
    expect(validateLabel("1 hero wide · dusk #2")).toBe("1 hero wide · dusk #2");
  });

  it("sends nothing when any argument is hostile", async () => {
    const engine = fakeEngine({ projectRoot: project });
    await expect(frameNodes(engine, { nodes: ['"); OS.execute("x'] })).rejects.toThrow(/Nothing was sent/);
    await expect(frameNodes(engine, { scenePath: "res://$&.tscn\n", nodes: ["A"] })).rejects.toThrow(/Nothing was sent/);
    await expect(shotSheet(engine, { shots: [{ bookmark_name: "$&" }] })).rejects.toThrow(/Nothing was sent/);
    await expect(shotSheet(engine, { shots: [{ camera_position: "Vector3(0,1,2)", camera_look_at: "Vector3(0,0,0)", label: '"); OS.execute(' }] })).rejects.toThrow(/Nothing was sent/);
    await expect(debugViews(engine, { camera_position: "Vector3($&,1,2)", camera_look_at: "Vector3(0,0,0)" })).rejects.toThrow(/Nothing was sent/);
    await expect(frameShot(engine, { shot: "establishing", subject: ["a\nb"] })).rejects.toThrow(/Nothing was sent/);
    await expect(frameShot(engine, { shot: "establishing", subject: ["A"], bookmark_name: "x;y" })).rejects.toThrow(/Nothing was sent/);
    await expect(zoom(engine, { bookmark_name: "hero", region: [0, 0, 2, 2] })).rejects.toThrow(/Nothing was sent/);
    await expect(shotSheet(engine, { shots: [{ bookmark_name: "hero" }], save_to: "../x" })).rejects.toThrow(/Nothing was sent/);
    expect(engine.calls).toEqual([]);
  });
});

describe("wrapper scene: arguments travel as data", () => {
  it("embeds only the validated scene path; everything else goes to config.json", async () => {
    const engine = fakeEngine({ projectRoot: project, analyze: analyzeBounds });
    const label = "dusk (#2) · 50% fog";
    await shotSheet(engine, { scenePath: "res://levels/town.tscn", shots: [{ camera_position: "Vector3(0, 5, 20)", camera_look_at: "Vector3(0, 2, 0)", label }] });
    const wrapper = engine.wrappers[0]!;
    expect(wrapper).toContain('[ext_resource type="PackedScene" path="res://levels/town.tscn" id="1_subject"]');
    expect(wrapper).not.toContain(label);
    expect(wrapper).not.toContain("Vector3(0, 5, 20)");
    expect(JSON.stringify(engine.configs[0])).toContain(label);
    // The kernel source is embedded verbatim (escaped), not templated.
    expect(wrapper).toContain(escapeTscnString(loadKernelSource()));
  });

  it("escapes the script body for the text scene format", () => {
    const scene = buildWrapperScene("res://a.tscn", 'print("a\\\\b")');
    expect(scene).toContain('script/source = "print(\\"a\\\\\\\\b\\")"');
  });

  it("the kernel reads its config from its own wrapper path and never shells out", () => {
    const kernel = loadKernelSource();
    expect(kernel).toContain('get_slice("::", 0)');
    expect(kernel).toContain('path_join("config.json")');
    for (const forbidden of ["OS.execute", "OS.shell", "OS.create_process", "DirAccess.remove", "ResourceSaver.save", "EditorInterface.save", "set_owner"]) {
      expect(kernel, forbidden).not.toContain(forbidden);
    }
  });
});

describe("layoutGrid", () => {
  it("lays out same-size tiles within the longest edge", () => {
    const g = layoutGrid(6, 16 / 9, 1536);
    expect([g.cols, g.rows]).toEqual([3, 2]);
    expect(Math.max(...g.canvas)).toBeLessThanOrEqual(1536);
    expect(new Set(g.rects.map((r) => `${r[2]}x${r[3]}`)).size).toBe(1);
    const compare = layoutGrid(6, 16 / 9, 1536, 3);
    expect(compare.cols).toBe(3);
  });
});

describe("summer_frame_nodes", () => {
  it("fits the pose to the merged bounds and renders with the real environment (framing free)", async () => {
    const engine = fakeEngine({ projectRoot: project, analyze: analyzeBounds });
    const r = (await frameNodes(engine, { scenePath: "res://three.tscn", nodes: ["House1", "House2"], direction: "front" })) as SeeingSuccess;
    expect(r.ok).toBe(true);
    expect(engine.configs[0]).toMatchObject({ mode: "analyze", subjects: ["House1", "House2"], tasks: [] });
    const native = engine.calls.find((c) => c.op === "ScenePreview" && c.scene_path === "res://three.tscn")!;
    expect(native.framing).toBe("free");
    expect(String(native.camera_position)).toMatch(/^Vector3\(0, 9, \d+/);
    expect(r.image?.base64).toBe(OK_JPEG.toString("base64"));
    expect(r.caption).toContain("REAL environment");
    expect(Buffer.byteLength(r.caption)).toBeLessThan(5000);
    expect(existsSync(join(project, ".summer"))).toBe(false);
  });

  it("saves the pose as a bookmark, renders that bookmark, and keeps its one previous-image slot", async () => {
    const engine = fakeEngine({ projectRoot: project, analyze: analyzeBounds });
    const r = (await frameNodes(engine, { scenePath: "res://three.tscn", nodes: ["House1"], bookmark_name: "hero" })) as SeeingSuccess;
    expect(r.ok).toBe(true);
    expect(engine.calls.map((c) => c.op)).toEqual(["ScenePreview", "SaveCameraBookmark", "ScenePreview"]);
    expect(engine.calls[2]!.framing).toBe("bookmark:hero");
    expect(readFileSync(join(project, ".summer", "shots", "hero.jpg"))).toEqual(OK_JPEG);
    expect(r.caption).toContain("res://.summer/shots/hero.jpg");
  });

  it("passes a node_not_found failure through as structured data", async () => {
    const engine = fakeEngine({ projectRoot: project, analyze: () => ({ ok: false, stage: "analyze", failure_reason: "node_not_found", missing: ["Nope"], errors: ["Node(s) not found in the scene: Nope"] }) });
    const r = await frameNodes(engine, { scenePath: "res://three.tscn", nodes: ["Nope"] });
    expect(r).toMatchObject({ ok: false, failure_reason: "node_not_found", detail: { missing: ["Nope"] } });
  });

  it("says so when the kernel never ran (no silent fallback)", async () => {
    const engine = fakeEngine({ projectRoot: project, silentKernel: true });
    const r = await frameNodes(engine, { scenePath: "res://three.tscn", nodes: ["A"] });
    expect(r).toMatchObject({ ok: false, failure_reason: "probe_did_not_run" });
  });

  it("refuses up front on an engine that provably lacks ScenePreview", async () => {
    const engine = fakeEngine({ projectRoot: project, capabilities: { opKinds: ["AddNode"] } });
    const r = await frameNodes(engine, { scenePath: "res://three.tscn", nodes: ["A"] });
    expect(r).toMatchObject({ ok: false, failure_reason: "engine_lacks_op" });
    expect(engine.calls).toEqual([]);
  });
});

describe("summer_shot_sheet", () => {
  const bookmarks = {
    hero: { position: "Vector3(0, 5, 20)", look_at: "Vector3(0, 2, 0)", fov: 55, created: "2026-01-01T00:00:00Z" },
    alley: { position: "Vector3(-24, 1.6, 1.3)", look_at: "Vector3(-24, 1.6, -15)", fov: 60 },
  };

  it("renders bookmarks and poses into one grid and keeps one slot per rendered bookmark", async () => {
    const engine = fakeEngine({ projectRoot: project, bookmarks });
    const r = (await shotSheet(engine, {
      scenePath: "res://three.tscn",
      shots: [{ bookmark_name: "hero" }, { bookmark_name: "alley" }, { camera_position: "Vector3(1, 2, 3)", camera_look_at: "Vector3(0, 0, 0)" }],
    })) as SeeingSuccess;
    expect(r.ok).toBe(true);
    const config = engine.configs[0]!;
    const tiles = config.tiles as Array<Record<string, unknown>>;
    expect(tiles.map((t) => t.kind)).toEqual(["shot", "shot", "shot"]);
    expect(tiles[0]!.pose).toMatchObject({ position: [0, 5, 20], look_at: [0, 2, 0], fov: 55 });
    expect(String(tiles[0]!.capture_path)).toContain("/summer-seeing-");
    expect(tiles[2]!.capture_path).toBeUndefined();
    expect(existsSync(join(project, ".summer", "shots", "hero.jpg"))).toBe(true);
    expect(existsSync(join(project, ".summer", "shots", "alley.jpg"))).toBe(true);
    expect(r.caption).toContain("1 hero");
    // The per-call temp directory is gone afterwards.
    expect(existsSync(String(tiles[0]!.capture_path))).toBe(false);
  });

  it("compare_previous: previous | now | difference rows, stats in the caption, slot replaced", async () => {
    const shots = join(project, ".summer", "shots");
    mkdirSync(shots, { recursive: true });
    writeFileSync(join(shots, "hero.jpg"), OK_JPEG);
    // hero was re-saved AFTER its previous render: the compare must say so.
    const engine = fakeEngine({ projectRoot: project, bookmarks: { ...bookmarks, hero: { ...bookmarks.hero, created: "2099-01-01T00:00:00Z" } } });
    const r = (await shotSheet(engine, { scenePath: "res://three.tscn", shots: [{ bookmark_name: "hero" }, { bookmark_name: "alley" }], compare_previous: true })) as SeeingSuccess;
    expect(r.ok).toBe(true);
    const tiles = engine.configs[0]!.tiles as Array<Record<string, unknown>>;
    expect(tiles.map((t) => t.kind)).toEqual(["prev", "shot", "diff", "note", "shot", "note"]);
    expect(tiles[0]!.image_path).toBe(join(shots, "hero.jpg").replace(/\\/g, "/"));
    expect(tiles[2]!.now_tile).toBe(1);
    expect(r.caption).toMatch(/difference 1: 4\.2% of pixels changed visibly/);
    expect(r.caption).toContain("previous image may predate the bookmark's current pose");
    expect(existsSync(join(shots, "alley.jpg"))).toBe(true);
  });

  it("refuses compare_previous without a bookmark and save_to with an oversized image", async () => {
    const engine = fakeEngine({ projectRoot: project, bookmarks });
    await expect(shotSheet(engine, { shots: [{ camera_position: "Vector3(1,2,3)", camera_look_at: "Vector3(0,0,0)" }], compare_previous: true })).rejects.toThrow(/needs bookmark_name/);
    await expect(shotSheet(engine, { shots: [{ bookmark_name: "hero" }], save_to: "copy", max_size: 1536 })).rejects.toThrow(/max_size <= 1024/);
    expect(engine.calls).toEqual([]);
  });

  it("writes a save_to copy only when asked", async () => {
    const engine = fakeEngine({ projectRoot: project, bookmarks });
    await shotSheet(engine, { scenePath: "res://three.tscn", shots: [{ camera_position: "Vector3(1,2,3)", camera_look_at: "Vector3(0,0,0)" }], max_size: 1024 });
    expect(existsSync(join(project, ".summer"))).toBe(false);
    const r = (await shotSheet(engine, { scenePath: "res://three.tscn", shots: [{ camera_position: "Vector3(1,2,3)", camera_look_at: "Vector3(0,0,0)" }], max_size: 1024, save_to: "review_1" })) as SeeingSuccess;
    expect(existsSync(join(project, ".summer", "shots", "saved", "review_1.jpg"))).toBe(true);
    expect(r.caption).toContain("res://.summer/shots/saved/review_1.jpg");
  });

  it("names the saved bookmarks when one is unknown", async () => {
    const engine = fakeEngine({ projectRoot: project, bookmarks });
    const r = await shotSheet(engine, { scenePath: "res://three.tscn", shots: [{ bookmark_name: "nope" }] });
    expect(r).toMatchObject({ ok: false, failure_reason: "unknown_bookmark" });
    expect((r as { hint: string }).hint).toContain("alley, hero");
  });
});

describe("summer_debug_views", () => {
  it("renders the six views of one pose and reports the method per view", async () => {
    const engine = fakeEngine({ projectRoot: project, bookmarks: { hero: { position: "Vector3(0, 5, 20)", look_at: "Vector3(0, 2, 0)", fov: 55 } } });
    const r = (await debugViews(engine, { scenePath: "res://three.tscn", bookmark_name: "hero" })) as SeeingSuccess;
    expect(r.ok).toBe(true);
    const tiles = engine.configs[0]!.tiles as Array<Record<string, unknown>>;
    expect(tiles.map((t) => t.view)).toEqual(["beauty", "lighting", "unshaded", "normals", "overdraw", "wireframe"]);
    expect(r.caption).toContain("normals=material_override");
    expect(r.caption).toContain("wireframe=debug_draw");
    expect(existsSync(join(project, ".summer", "shots", "hero.jpg"))).toBe(true);
  });
});

describe("summer_zoom", () => {
  const pose = { camera_position: "Vector3(0, 5, 20)", camera_look_at: "Vector3(0, 2, 0)", fov: 50 };

  it("renders the exact sub-frustum of a region", async () => {
    const engine = fakeEngine({ projectRoot: project });
    const r = (await zoom(engine, { scenePath: "res://three.tscn", ...pose, region: [0.4, 0.4, 0.2, 0.2], pad: 0 })) as SeeingSuccess;
    expect(r.ok).toBe(true);
    const tile = (engine.configs[0]!.tiles as Array<Record<string, unknown>>)[0]!;
    const crop = (tile.pose as { crop: number[] }).crop;
    expect(crop[0]).toBeCloseTo(0.4, 6);
    expect(crop[2]).toBeCloseTo(0.6, 6);
    expect(r.caption).toMatch(/Zoom x5\.0/);
  });

  it("resolves mark N with a marks render of the same pose, then zooms on its box", async () => {
    const engine = fakeEngine({
      projectRoot: project,
      native: (op) => ({
        ok: true,
        image_base64: OK_JPEG.toString("base64"),
        width: 1024,
        height: 576,
        framing: op.framing,
        marks: [{ id: 3, path: "Props/Crate_02", class: "MeshInstance3D", screen_rect: { x: 512, y: 288, w: 100, h: 60 } }],
        marks_candidates: 1,
      }),
    });
    const r = (await zoom(engine, { scenePath: "res://three.tscn", ...pose, mark: 3 })) as SeeingSuccess;
    expect(r.ok).toBe(true);
    expect(engine.calls[0]).toMatchObject({ op: "ScenePreview", scene_path: "res://three.tscn", marks: true, size: [1024, 576] });
    expect(r.caption).toContain("mark 3 -> Props/Crate_02");
    const missing = await zoom(engine, { scenePath: "res://three.tscn", ...pose, mark: 9 });
    expect(missing).toMatchObject({ ok: false, failure_reason: "mark_not_found" });
  });
});

describe("summer_frame_shot", () => {
  const COLS = 24;
  const ROWS = 14;

  function measure(config: Record<string, unknown>) {
    const candidates = config.candidates as Array<Record<string, unknown>>;
    if (!candidates) return analyzeBounds(config);
    return {
      ok: true,
      stage: "done",
      occluders: { counts: { hard: 4, soft: 9, subject: 12, ignored: 0 }, by_rule: { "hard:name": 4, "soft:name": 9 } },
      measurements: candidates.map((c, i) => {
        let grid = "";
        const dist: number[] = [];
        for (let r = 0; r < ROWS; r++) for (let col = 0; col < COLS; col++) {
          const code = r < 4 ? "." : r < 10 && col > 5 && col < 18 ? "S" : "H";
          grid += code;
          dist.push(code === "." ? -1 : code === "S" ? 30 : 60);
        }
        // Every third pose is blocked by a wall.
        return { i, position: c.position, look_at: c.look_at, fov: c.fov, vis: i % 3 === 0 ? "HHHHHHHHH" : "VVVVVVVVV", grid, dist, ...(i % 3 === 0 ? { blockers_hard: ["Walls/North"] } : {}) };
      }),
    };
  }

  it("measures candidates in-engine, returns the top 3, saves the best and renders one sheet", async () => {
    const engine = fakeEngine({ projectRoot: project, analyze: measure });
    const r = (await frameShot(engine, { scenePath: "res://three.tscn", shot: "establishing", subject: ["House1", "House2", "House3"] })) as SeeingSuccess;
    expect(r.ok).toBe(true);
    expect(engine.configs.map((c) => c.mode)).toEqual(["analyze", "analyze", "render"]);
    expect((engine.configs[1]!.candidates as unknown[]).length).toBe(36);
    expect(engine.configs[1]!.measure).toMatchObject({ grid_cols: 24, grid_rows: 14, near_lens_radius: 0.3 });
    expect(engine.configs[1]!.image_check).toEqual({ size: [96, 56] });
    const receipt = r.receipt as { top: unknown[]; rejected: Record<string, number>; bookmark: string };
    expect(receipt.top).toHaveLength(3);
    expect(receipt.rejected.hard_blocked).toBe(12);
    expect(receipt.bookmark).toBe("establishing_House1");
    expect(engine.bookmarks.establishing_House1).toBeDefined();
    expect((engine.configs[2]!.tiles as unknown[]).length).toBe(3);
    expect(existsSync(join(project, ".summer", "shots", "establishing_House1.jpg"))).toBe(true);
    expect(r.caption).toContain("rejected hard_blocked 12");
    expect(Buffer.byteLength(r.caption)).toBeLessThan(5000);
  });

  it("render:none returns scores only and save_bookmark:false writes nothing", async () => {
    const engine = fakeEngine({ projectRoot: project, analyze: measure });
    const r = (await frameShot(engine, { scenePath: "res://three.tscn", shot: "detail", subject: ["House1"], render: "none", save_bookmark: false })) as SeeingSuccess;
    expect(r.ok).toBe(true);
    expect(r.image).toBeNull();
    expect(engine.calls.some((c) => c.op === "SaveCameraBookmark")).toBe(false);
    expect(existsSync(join(project, ".summer"))).toBe(false);
  });

  it("eye_level needs a spawn, other shots need a subject; corridors need a corridor", async () => {
    const engine = fakeEngine({ projectRoot: project, analyze: measure });
    await expect(frameShot(engine, { shot: "eye_level" })).rejects.toThrow(/needs spawn/);
    await expect(frameShot(engine, { shot: "corridor" })).rejects.toThrow(/needs subject/);
    const noCorridor = fakeEngine({ projectRoot: project, analyze: (c) => ({ ...analyzeBounds(c), corridor_scan: { runs: [] } }) });
    expect(await frameShot(noCorridor, { scenePath: "res://three.tscn", shot: "corridor", subject: ["Alley1"] })).toMatchObject({ ok: false, failure_reason: "no_corridor_found" });
  });

  it("reports no_usable_pose with the rejection counts when everything is blocked", async () => {
    const blocked = fakeEngine({
      projectRoot: project,
      analyze: (c) => {
        const m = measure(c) as Record<string, unknown>;
        if (Array.isArray(m.measurements)) for (const x of m.measurements as Array<Record<string, unknown>>) x.vis = "HHHHHHHHH";
        return m;
      },
    });
    const r = await frameShot(blocked, { scenePath: "res://three.tscn", shot: "establishing", subject: ["House1"] });
    expect(r).toMatchObject({ ok: false, failure_reason: "no_usable_pose", detail: { rejected: { hard_blocked: 36 } } });
  });
});

// Round 1 (three_houses_v3, 2026-10-04): the corridor winner was "adjusted:
// raised" to 4.25 m and the next alley's to 3.5 m; the establishing winner
// (27.7 m up) showed the empty world; captions never said how high the camera
// really was.
describe("summer_frame_shot keeps eye-level and corridor cameras at eye height (round 1)", () => {
  const COLS = 24;
  const ROWS = 14;
  const ALLEY = { position: [-3, -1.8, -10], size: [6, 10, 22] };

  function corridorEngine(raiseFirst: boolean) {
    return fakeEngine({
      projectRoot: project,
      analyze: (config) => {
        const subjects = ((config.subjects ?? []) as string[]).map((p) => ({ path: p, resolved: p, has_geometry: true, visuals: 12, aabb: ALLEY }));
        const candidates = config.candidates as Array<Record<string, unknown>> | undefined;
        if (!candidates) {
          return { ok: true, stage: "done", subjects, corridor_scan: { runs: [{ seed: [0, 1.6, 0], dir: [0, 0, 1], fwd: 12, back: 10, left: 1.5, right: 1.5 }] } };
        }
        return {
          ok: true,
          stage: "done",
          subjects,
          measurements: candidates.map((c, i) => {
            let grid = "";
            const dist: number[] = [];
            for (let r = 0; r < ROWS; r++) for (let col = 0; col < COLS; col++) {
              const code = r < 3 ? "." : col < 6 || col >= 18 ? "H" : "S";
              grid += code;
              dist.push(code === "." ? -1 : code === "H" ? 2 + r * 0.3 : 9);
            }
            const p = c.position as number[];
            // What an old kernel did: pushed the camera up over a duct.
            if (raiseFirst && i === 0) {
              return { i, position: [p[0], 4.25, p[2]], look_at: c.look_at, fov: c.fov, vis: "VVVVVV", grid, dist, adjustments: [{ kind: "raised", by: 2.65 }], ground_y: 0 };
            }
            return { i, position: p, look_at: c.look_at, fov: c.fov, vis: "VVVVVV", grid, dist, adjustments: [{ kind: "eye_height", height: 1.6, ground_y: 0 }], ground_y: 0 };
          }),
        };
      },
    });
  }

  it("sends every corridor pose in eye mode on the scan's floor, never ranks a raised one, and states the real height", async () => {
    const engine = corridorEngine(true);
    const r = (await frameShot(engine, { scenePath: "res://three.tscn", shot: "corridor", subject: ["Alley1"], save_bookmark: false })) as SeeingSuccess;
    expect(r.ok).toBe(true);
    const sent = engine.configs[1]!.candidates as Array<{ position: number[]; eye?: Record<string, unknown> }>;
    expect(sent.length).toBe(24);
    for (const c of sent) {
      // The floor under the seed (y 0), not the subject's lowest point (-1.8).
      expect(c.position[1]).toBeCloseTo(1.6, 6);
      expect(c.eye).toEqual({ min: 1.5, max: 1.8, target: 1.6, stand: [0, 1.6, 0] });
    }
    const receipt = r.receipt as { top: Array<{ id: string; camera_y: number; height_above_ground: number }>; rejected: Record<string, number> };
    expect(receipt.rejected.raised_above_eye).toBe(1);
    for (const t of receipt.top) {
      expect(t.camera_y).toBeCloseTo(1.6, 6);
      expect(t.height_above_ground).toBeCloseTo(1.6, 6);
    }
    expect(r.caption).toContain("camera 1.60 m above the surface below it (camera y 1.60, surface y 0.00)");
    expect(r.caption).toContain("eye: 1.6 m above the walkable surface under each camera (corridor floor y 0.00); never raised");
    const tiles = engine.configs[2]!.tiles as Array<{ label: string }>;
    for (const t of tiles) expect(t.label).toMatch(/· camera 1\.60 m above surface \(y 1\.60\)$/);
  });

  it("eye_level poses carry the spawn's floor as their walkable reference", async () => {
    const engine = fakeEngine({
      projectRoot: project,
      analyze: (config) => {
        const candidates = config.candidates as Array<Record<string, unknown>> | undefined;
        const base = { ...analyzeBounds(config), spawn: { path: "Walker", origin: [16.5, 0, 9], forward: [0, 0, -1] } };
        if (!candidates) return base;
        return {
          ...base,
          measurements: candidates.map((c, i) => {
            let grid = "";
            for (let r = 0; r < ROWS; r++) for (let col = 0; col < COLS; col++) grid += r < 5 ? "." : r < 10 && col > 5 && col < 18 ? "S" : "H";
            return { i, position: c.position, look_at: c.look_at, fov: c.fov, vis: "VVVVVVVVV", grid, dist: [...grid].map((g) => (g === "." ? -1 : 20)), ground_y: 0 };
          }),
        };
      },
    });
    const r = (await frameShot(engine, { scenePath: "res://three.tscn", shot: "eye_level", spawn: "Walker", subject: ["House1"], render: "none", save_bookmark: false })) as SeeingSuccess;
    expect(r.ok).toBe(true);
    const sent = engine.configs[1]!.candidates as Array<{ position: number[]; eye?: Record<string, unknown> }>;
    for (const c of sent) expect(c.eye).toEqual({ min: 1.5, max: 1.8, target: 1.6, stand: [16.5, 0, 9] });
    expect(r.caption).toContain("eye: 1.6 m above the walkable surface under the camera at Walker; never raised");
    expect(r.caption).toContain("camera 1.60 m above the surface below it (camera y 1.60, surface y 0.00)");
  });

  it("establishing captions say the camera height too, and name the tier rule", async () => {
    const engine = fakeEngine({
      projectRoot: project,
      analyze: (config) => {
        const candidates = config.candidates as Array<Record<string, unknown>> | undefined;
        if (!candidates) return analyzeBounds(config);
        return {
          ...analyzeBounds(config),
          measurements: candidates.map((c, i) => {
            let grid = "";
            for (let r = 0; r < ROWS; r++) for (let col = 0; col < COLS; col++) grid += r < 4 ? "." : r < 10 && col > 5 && col < 18 ? "S" : "H";
            return { i, position: c.position, look_at: c.look_at, fov: c.fov, vis: "VVVVVVVVV", grid, dist: [...grid].map((g) => (g === "." ? -1 : 30)), ground_y: i % 2 ? 0 : null };
          }),
        };
      },
    });
    const r = (await frameShot(engine, { scenePath: "res://three.tscn", shot: "establishing", subject: ["House1"], save_bookmark: false })) as SeeingSuccess;
    expect(r.caption).toContain("tier rule: a pose showing more than 15% empty ground or world edge ranks below every pose showing less");
    expect(r.caption).toMatch(/camera [\d.]+ m above the surface below it \(camera y [\d.]+, surface y 0\.00\)|camera at y [\d.]+ \(absolute\); no surface below it \(world edge\)/);
    const tiles = engine.configs[2]!.tiles as Array<{ label: string }>;
    for (const t of tiles) expect(t.label).toMatch(/· camera ([\d.]+ m above surface \(y [\d.]+\)|y [\d.]+, nothing below)$/);
  });
});

describe("summer_frame_nodes checks an explicit from (proof run: the camera sat behind Backdrop/BD_A)", () => {
  const FIRE_ESCAPE = { position: [5, 2, -9], size: [5, 8, 1.5] };
  const COLS = 24;
  const ROWS = 14;

  function engineFor(requestedBehindWall: boolean, extra: (config: Record<string, unknown>) => Record<string, unknown> = () => ({})) {
    return fakeEngine({
      projectRoot: project,
      analyze: (config) => {
        const candidates = config.candidates as Array<Record<string, unknown>> | undefined;
        const base = {
          ok: true,
          stage: "done",
          subjects: ((config.subjects ?? []) as string[]).map((p) => ({ path: p, resolved: p, has_geometry: true, visuals: 4, aabb: FIRE_ESCAPE })),
          ...extra(config),
        };
        if (!candidates) return base;
        return {
          ...base,
          measurements: candidates.map((c, i) => {
            // The request (0) and every pose up to option 5 stand behind the wall.
            const behind = requestedBehindWall && i < 5;
            const grid = (behind ? "B" : "H").repeat(COLS * ROWS);
            return { i, position: c.position, look_at: c.look_at, fov: c.fov, vis: behind ? "BBBBBBBBB" : "VVVVVVVVV", grid, dist: new Array(COLS * ROWS).fill(3), ...(behind ? { blockers_back: ["Backdrop/BD_A"] } : {}) };
          }),
        };
      },
    });
  }

  it("measures the requested pose exactly (adjust:false) with nearby alternatives, warns and offers the nearest valid from", async () => {
    const engine = engineFor(true);
    const r = (await frameNodes(engine, { scenePath: "res://three_houses_v2.tscn", nodes: ["Alley1/FireEscape"], from: "Vector3(0.24, 0.15, -0.96)", fov: 50 })) as SeeingSuccess;
    expect(r.ok).toBe(true);
    expect(engine.configs.map((c) => c.mode)).toEqual(["analyze", "analyze"]);
    const check = engine.configs[1]!;
    expect(check.tasks).toEqual(["measure"]);
    const candidates = check.candidates as Array<Record<string, unknown>>;
    expect(candidates.length).toBeGreaterThan(10);
    expect(candidates.every((c) => c.adjust === false)).toBe(true);
    // Candidate 0 is exactly the pose that was rendered.
    const native = engine.calls.find((c) => c.op === "ScenePreview" && c.scene_path === "res://three_houses_v2.tscn")!;
    expect(`Vector3(${(candidates[0]!.position as number[]).join(", ")})`).toBe(String(native.camera_position));
    expect(r.caption.split("\n")[0]).toMatch(/^WARNING: this explicit from gives a view no player could have \(behind_surface\)/);
    expect(r.caption).toContain("Backdrop/BD_A");
    expect(r.caption).toContain("looks THROUGH it");
    expect(r.caption).toMatch(/nearest valid pose \(.+\): summer_frame_nodes from:"Vector3\(/);
    const receipt = r.receipt as { view_check: { ok: boolean; reason: string; nearest_valid: { from: string; position: string } } };
    expect(receipt.view_check.ok).toBe(false);
    expect(receipt.view_check.reason).toBe("behind_surface");
    expect(receipt.view_check.nearest_valid.from).toMatch(/^Vector3\(/);
  });

  it("says the view is clear when it is, and a direction preset skips the extra pass", async () => {
    const clear = engineFor(false);
    const r = (await frameNodes(clear, { scenePath: "res://a.tscn", nodes: ["Crate"], from: "Vector3(0, 0.3, 1)" })) as SeeingSuccess;
    expect(r.caption).not.toContain("WARNING");
    expect(r.caption).toContain("view check: clear — 9 of 9 sight lines to the nodes clear");
    expect((r.receipt as { view_check: { ok: boolean } }).view_check.ok).toBe(true);
    const preset = engineFor(true);
    await frameNodes(preset, { scenePath: "res://a.tscn", nodes: ["Crate"], direction: "front" });
    expect(preset.configs.map((c) => c.mode)).toEqual(["analyze"]);
  });

  it("viewOptions: the request first, then wider lenses and turns a caller can pass back as from + fov", () => {
    const box = { position: [-1, 0, -1] as const, size: [2, 2, 2] as const };
    const options = viewOptions(box, [0, 1, 0], [0, 0, 1], 50, 16 / 9, 0.8);
    expect(options[0]!.tag).toBe("as requested");
    expect(options[0]!.cost).toBe(0);
    expect(options.some((o) => o.tag === "same direction, fov 65")).toBe(true);
    expect(options.some((o) => o.tag === "from the opposite side")).toBe(true);
    expect(new Set(options.map((o) => `${o.from.join(",")}|${o.fov}`)).size).toBe(options.length);
  });

  it("judgeViewOptions picks the cheapest valid alternative", () => {
    const box = { position: [-1, 0, -1] as const, size: [2, 2, 2] as const };
    const options = viewOptions(box, [0, 1, 0], [0, 0, 1], 50, 16 / 9, 0.8);
    const ms = options.map((o, i) => ({ i, position: o.pose.position, look_at: o.pose.look_at, fov: o.pose.fov, vis: i === 0 || o.tag.startsWith("same direction") ? "HHHHHHHHH" : "VVVVVVVVV" }));
    const check = judgeViewOptions(options, ms);
    expect(check.problem?.reason).toBe("hard_blocked");
    expect(check.alternative?.tag).toMatch(/^turned 15 deg/);
  });
});

describe("marks get an occlusion test (trial: labels on nodes hidden behind walls)", () => {
  const marksNative = (op: Record<string, unknown>) =>
    op.marks
      ? {
          ok: true,
          image_base64: OK_JPEG.toString("base64"),
          width: 1024,
          height: 576,
          framing: op.framing,
          environment_used: "scene_world_environment",
          marks: [
            { id: 1, path: "House2/SideL/row0/Model/wall", class: "MeshInstance3D", screen_rect: { x: 10, y: 10, w: 300, h: 200 } },
            { id: 2, path: "House3/SideL/row2/Model/wall", class: "MeshInstance3D", screen_rect: { x: 700, y: 40, w: 200, h: 260 } },
          ],
          marks_candidates: 2,
        }
      : undefined;
  const occlusionAnalyze = (config: Record<string, unknown>) => ({
    ...analyzeBounds(config),
    ...(config.occlusion
      ? {
          occlusion: {
            position: (config.occlusion as { position: number[] }).position,
            marks: [
              { id: 1, path: "House2/SideL/row0/Model/wall", visible: 5, samples: 5 },
              { id: 2, path: "House3/SideL/row2/Model/wall", visible: 0, samples: 5, blocker: "House1/SideR/row1/Model/wall" },
            ],
          },
        }
      : {}),
  });

  it("frame_nodes marks:true tests every label from the rendered camera and notes the hidden ones", async () => {
    const engine = fakeEngine({ projectRoot: project, analyze: occlusionAnalyze, native: marksNative });
    const r = (await frameNodes(engine, { scenePath: "res://three.tscn", nodes: ["House2"], direction: "front", marks: true })) as SeeingSuccess;
    expect(r.ok).toBe(true);
    const check = engine.configs[1]!;
    expect(check.tasks).toEqual(["occlusion"]);
    const native = engine.calls.find((c) => c.op === "ScenePreview" && c.scene_path === "res://three.tscn")!;
    expect(`Vector3(${((check.occlusion as { position: number[] }).position).join(", ")})`).toBe(String(native.camera_position));
    expect((check.occlusion as { marks: unknown[] }).marks).toEqual([
      { id: 1, path: "House2/SideL/row0/Model/wall" },
      { id: 2, path: "House3/SideL/row2/Model/wall" },
    ]);
    expect(r.caption).toMatch(/ 2 -> House3\/SideL\/row2\/Model\/wall .*\(hidden behind House1\/SideR\/row1\/Model\/wall\)/);
    expect(r.caption).not.toMatch(/ 1 -> .*hidden/);
    expect(r.caption).toContain("1 of 2 labelled node(s) are HIDDEN");
    const marks = (r.receipt as { marks: Array<{ id: number; visibility?: { visible: number } }> }).marks;
    expect(marks.find((m) => m.id === 2)!.visibility!.visible).toBe(0);
  });

  it("zoom by mark warns when that node is hidden at the pose", async () => {
    const engine = fakeEngine({
      projectRoot: project,
      native: marksNative,
      render: (config) => ({
        ok: true,
        stage: "render_setup",
        tiles: [],
        ...(config.occlusion ? { occlusion: { marks: [{ id: 2, path: "House3/SideL/row2/Model/wall", visible: 0, samples: 5, blocker: "House1/SideR/row1/Model/wall" }] } } : {}),
      }),
    });
    const r = (await zoom(engine, { scenePath: "res://three.tscn", camera_position: "Vector3(0, 5, 20)", camera_look_at: "Vector3(0, 2, 0)", mark: 2 })) as SeeingSuccess;
    expect(r.ok).toBe(true);
    expect((engine.configs[0]!.occlusion as { marks: unknown[] }).marks).toEqual([{ id: 2, path: "House3/SideL/row2/Model/wall" }]);
    expect(r.caption).toContain("WARNING: mark 2's node is hidden behind House1/SideR/row1/Model/wall");
  });
});

describe("summer_zoom honours the region (proof run: a requested 2.6x came out as 1.3x)", () => {
  const pose = { camera_position: "Vector3(0, 5, 20)", camera_look_at: "Vector3(0, 2, 0)", fov: 50 };

  it("renders exactly the region at its own aspect and reports the real zoom", async () => {
    const engine = fakeEngine({ projectRoot: project });
    const r = (await zoom(engine, { scenePath: "res://three.tscn", ...pose, region: [0.5, 0.15, 0.3, 0.6] })) as SeeingSuccess;
    expect(r.ok).toBe(true);
    const config = engine.configs[0]!;
    const tile = (config.tiles as Array<Record<string, unknown>>)[0]!;
    const crop = (tile.pose as { crop: number[] }).crop;
    expect(crop[0]).toBeCloseTo(0.5, 9);
    expect(crop[1]).toBeCloseTo(0.15, 9);
    expect(crop[2]).toBeCloseTo(0.8, 9);
    expect(crop[3]).toBeCloseTo(0.75, 9);
    // The tile has the region's pixel aspect (0.3 x 0.6 of 16:9 = 0.889), so the sub-frustum is not widened.
    const rect = tile.rect as number[];
    expect(rect[2]! / rect[3]!).toBeCloseTo((0.3 / 0.6) * (16 / 9), 2);
    expect(tile.render_size).toEqual([rect[2], rect[3]]);
    expect(r.caption).toMatch(/^Zoom x3\.3 across, x1\.7 down/);
    expect(r.caption).toContain("region as asked (u 0.5-0.8, v 0.15-0.75)");
    expect(r.caption).not.toContain("widened_because");
    expect((r.receipt as { widened_because: string[] }).widened_because).toEqual([]);
  });

  it("names the pad in widened_because, and a mark gets its default 0.15", async () => {
    const engine = fakeEngine({ projectRoot: project });
    const r = (await zoom(engine, { scenePath: "res://three.tscn", ...pose, region: [0.4, 0.4, 0.2, 0.2], pad: 0.25 })) as SeeingSuccess;
    expect(r.caption).toMatch(/widened_because: pad 0\.25/);
    expect((r.receipt as { widened_because: string[] }).widened_because).toHaveLength(1);
    const marks = fakeEngine({
      projectRoot: project,
      native: (op) => ({ ok: true, image_base64: OK_JPEG.toString("base64"), width: 1024, height: 576, framing: op.framing, marks: [{ id: 3, path: "Props/Crate", class: "MeshInstance3D", screen_rect: { x: 512, y: 288, w: 100, h: 60 } }], marks_candidates: 1 }),
    });
    const m = (await zoom(marks, { scenePath: "res://three.tscn", ...pose, mark: 3 })) as SeeingSuccess;
    expect(m.caption).toMatch(/widened_because: pad 0\.15/);
  });
});

describe("previous-image slots are the compare baseline (coordinator: a plain sheet reset it)", () => {
  const bookmarks = { hero: { position: "Vector3(0, 5, 20)", look_at: "Vector3(0, 2, 0)", fov: 55, created: "2026-01-01T00:00:00Z" } };
  const BASELINE = Buffer.from("baseline-bytes");

  function seedSlot(): string {
    const dir = join(project, ".summer", "shots");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "hero.jpg");
    writeFileSync(path, BASELINE);
    return path;
  }

  it("a sheet without compare_previous keeps an existing baseline and says so", async () => {
    const slot = seedSlot();
    const engine = fakeEngine({ projectRoot: project, bookmarks });
    const r = (await shotSheet(engine, { scenePath: "res://three.tscn", shots: [{ bookmark_name: "hero" }] })) as SeeingSuccess;
    expect(readFileSync(slot)).toEqual(BASELINE);
    expect((engine.configs[0]!.tiles as Array<Record<string, unknown>>)[0]!.capture_path).toBeUndefined();
    expect(r.caption).toContain("kept the existing previous image (compare baseline) of hero");
  });

  it("update_previous:true or compare_previous:true replaces it; a missing slot is created", async () => {
    const slot = seedSlot();
    const engine = fakeEngine({ projectRoot: project, bookmarks });
    await shotSheet(engine, { scenePath: "res://three.tscn", shots: [{ bookmark_name: "hero" }], update_previous: true });
    expect(readFileSync(slot)).toEqual(OK_JPEG);
    writeFileSync(slot, BASELINE);
    await shotSheet(engine, { scenePath: "res://three.tscn", shots: [{ bookmark_name: "hero" }], compare_previous: true });
    expect(readFileSync(slot)).toEqual(OK_JPEG);
    rmSync(slot);
    await shotSheet(engine, { scenePath: "res://three.tscn", shots: [{ bookmark_name: "hero" }] });
    expect(readFileSync(slot)).toEqual(OK_JPEG);
  });

  it("debug views keep the baseline too unless update_previous:true", async () => {
    const slot = seedSlot();
    const engine = fakeEngine({ projectRoot: project, bookmarks });
    const r = (await debugViews(engine, { scenePath: "res://three.tscn", bookmark_name: "hero" })) as SeeingSuccess;
    expect(readFileSync(slot)).toEqual(BASELINE);
    expect(r.caption).toContain("it was kept as the compare baseline");
    await debugViews(engine, { scenePath: "res://three.tscn", bookmark_name: "hero", update_previous: true });
    expect(readFileSync(slot)).toEqual(OK_JPEG);
  });

  it("frame_nodes saving the bookmark redefines its pose, so it replaces the slot", async () => {
    const slot = seedSlot();
    const engine = fakeEngine({ projectRoot: project, analyze: analyzeBounds, bookmarks });
    await frameNodes(engine, { scenePath: "res://three.tscn", nodes: ["House1"], bookmark_name: "hero" });
    expect(readFileSync(slot)).toEqual(OK_JPEG);
  });
});

describe("summer_frame_shot reads the key light", () => {
  it("passes the scene's DirectionalLight3D to the light term and names it in the caption", async () => {
    const COLS = 24;
    const ROWS = 14;
    const engine = fakeEngine({
      projectRoot: project,
      analyze: (config) => {
        const candidates = config.candidates as Array<Record<string, unknown>> | undefined;
        const base = { ...analyzeBounds(config), key_light: { path: "Sun", direction: [0.6, -0.6, -0.5], energy: 1 } };
        if (!candidates) return base;
        return {
          ...base,
          measurements: candidates.map((c, i) => {
            let grid = "";
            for (let r = 0; r < ROWS; r++) for (let col = 0; col < COLS; col++) grid += r < 4 ? "." : r < 10 && col > 5 && col < 18 ? "S" : "H";
            return { i, position: c.position, look_at: c.look_at, fov: c.fov, vis: "VVVVVVVVV", grid, dist: [...grid].map((g) => (g === "." ? -1 : 30)) };
          }),
        };
      },
    });
    const r = (await frameShot(engine, { scenePath: "res://three.tscn", shot: "establishing", subject: ["House1"], render: "none", save_bookmark: false })) as SeeingSuccess;
    expect(r.caption).toContain("key light: Sun travelling Vector3(0.6, -0.6, -0.5)");
    const top = (r.receipt as { top: Array<{ terms: Record<string, number> }> }).top;
    expect(top[0]!.terms.light).toBeDefined();
    expect(top).toHaveLength(3);
  });
});

describe("the kernel's back-face, lens and transparency rules (source contract)", () => {
  const kernel = loadKernelSource();

  it("reads the side of each hit with a front-faces-only ray and keeps transparent bodies out of the sweeps", () => {
    expect(kernel).toMatch(/func _is_back\([\s\S]*?q\.hit_back_faces = false/);
    expect(kernel).toContain("const LAYER_SEE := 8");
    // The thick sweeps use class masks only, never LAYER_SEE.
    expect(kernel).toMatch(/var sweep_hard_mask := LAYER_HARD\n/);
    expect(kernel).toMatch(/var sweep_soft_mask := LAYER_SOFT\n/);
    expect(kernel).toContain("BaseMaterial3D.TRANSPARENCY_DISABLED");
    expect(kernel).toContain("BaseMaterial3D.CULL_DISABLED");
  });

  it("eye mode stands the camera on the surface below the lens and never raises it (round 1: corridor winners raised to 3.5-4.25 m)", () => {
    // The surface under an eye is cast from the lens itself, so a duct or a
    // balcony overhead never counts as ground.
    expect(kernel).toMatch(/func _surface_below\(pos: Vector3, mask: int\) -> Variant:\n\tvar hit := _ray\(pos, pos \+ Vector3\.DOWN \* 500\.0, mask\)/);
    expect(kernel).toContain("func _eye_place(");
    // The ground-clearance push ("raised") and the along-the-view nudge are off in eye mode.
    expect(kernel).toContain("for _attempt in (2 if adjust and not eye_mode else 0):");
    expect(kernel).toContain("while adjust and not eye_mode and step * k <= max_nudge + 0.0001:");
    expect(kernel).toContain('rec["ground_y"] = null if g == null else snappedf(float(g), 0.001)');
    expect(kernel).toContain('"kind": "eye_height"');
  });

  it("rejects a lens inside a closed shell or just behind a one-sided surface, and measures adjust:false poses as given", () => {
    expect(kernel).toContain('return "inside_volume"');
    expect(kernel).toContain('return "behind_surface"');
    expect(kernel).toContain('bool(cand.get("adjust", true))');
    expect(kernel).toContain('tasks.has("occlusion")');
    expect(kernel).toContain('_result["key_light"] = key');
  });
});
