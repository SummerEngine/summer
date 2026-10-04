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
  layoutGrid,
  shotSheet,
  validateLabel,
  validateNodePath,
  validateScenePath,
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
    expect(r.caption).toContain("previous image predates the bookmark's current pose");
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
