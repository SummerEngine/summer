import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolInputError } from "../../tool-errors.js";
import { fakeEngine, OK_JPEG } from "../../../test-helpers/seeing-engine.js";
import { escapeTscnString } from "../seeing/probe.js";
import { loadAuditKernel, sceneAudit, validateAuditArgs, type AuditSuccess } from "./audit.js";
import { AUDIT_CHECKS } from "./args.js";
import { bytes, SUMMARY_CAP_BYTES } from "./summary.js";

let project: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "audit-project-"));
  writeFileSync(join(project, "project.godot"), "config_version=5\n");
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

const HOSTILE = ["$&", "$`", "$'", '"); OS.execute("rm", ["-rf", "/"]); ("', "line\nbreak", "quote\"d", "back\\slash", "../../etc/passwd"];

const ID9 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
function inst(p: string, extra: Record<string, unknown> = {}) {
  return { p, k: p.toLowerCase(), s: `res://kit/${p.toLowerCase()}.tscn`, r: "prop", in: true, o: [0, 0, 0], b: ID9, sc: [1, 1, 1], det: 1, c: [0, 0.5, 0], e: [1, 1, 1], le: [1, 1, 1], lc: [0, 0.5, 0], m: 1, f: [0, 0, 0], cl: Array(16).fill(8), ...extra };
}

/** A kernel result with one through hole, one lamp with nothing under it and
 *  200 floating crates (enough to overflow any page). */
function kernelResult() {
  const crates = Array.from({ length: 200 }, (_, i) => inst(`Props/Crate_${i}`, { o: [i, 0, 3], c: [i, 0.5, 3] }));
  const instances = [
    inst("House/Back/Frame", { k: "facade_frame_a", r: "wall", o: [31.5, 0, -7.9], c: [31.5, 1.5, -7.9] }),
    inst("House/Back/Door", { k: "door_b", r: "insert", o: [31.5, 0, -7.9], c: [31.5, 1.4, -7.9] }),
    inst("House/Back/Lamp", { k: "lamp_a", o: [28, 2.5, -7], c: [28, 2.6, -7] }),
    ...crates,
  ];
  return {
    ok: true,
    stage: "done",
    ms: { collect: 5, roles: 2, mesh_pass: 90, physics_build: 140, through_hole: 180, floor_gap: 90, floating_sunken: 4, total: 700 },
    stats: { nodes: 2400, instances: 202, mesh_instances: 640, unique_meshes: 100, tris_unique: 300000, rays: 80000 },
    instances,
    lines: [
      {
        n: [0, 0, -1],
        t: [-1, 0, 0],
        d: 8.03,
        spacing: 0.286,
        through: [0.143, 0.429, 0.715, 1.001].map((y) => [-32.45, y, 0, 6.9, -32.6, -32.3, y - 0.14, y + 0.14, 5]),
        pieces: [[0, -33, -30, 0, 3]],
        inserts: [[1, -32.66, -30.34, 0, 2.74]],
        zfight: [],
      },
    ],
    support: [[2, 2.5, 2.8, Array.from({ length: 5 }, () => null)], ...crates.map((_, i) => [i + 3, 0.06, 0.4, Array.from({ length: 5 }, () => [0, -1])])],
    warnings: [],
    errors: [],
  };
}

describe("input validation: caller text never reaches a scene file or GDScript unchecked", () => {
  it.each(HOSTILE)("refuses root %j", (value) => {
    expect(() => validateAuditArgs({ root: value })).toThrow(ToolInputError);
  });
  it.each([...HOSTILE, "res://a.gd", "user://x.tscn", "res://../x.tscn", 'res://a".tscn'])("refuses scenePath %j", (value) => {
    expect(() => validateAuditArgs({ scenePath: value })).toThrow(ToolInputError);
  });
  it("refuses unknown checks and bad paging", () => {
    expect(() => validateAuditArgs({ checks: ["everything" as never] })).toThrow(ToolInputError);
    expect(() => validateAuditArgs({ offset: -1 })).toThrow(ToolInputError);
    expect(() => validateAuditArgs({ limit: 0 })).toThrow(ToolInputError);
    expect(() => validateAuditArgs({ limit: 51 })).toThrow(ToolInputError);
    expect(() => validateAuditArgs({ budget_ms: 100 })).toThrow(ToolInputError);
    expect(() => validateAuditArgs({ budget_ms: 60001 })).toThrow(ToolInputError);
    expect(() => validateAuditArgs({ budget_ms: 1500.5 })).toThrow(ToolInputError);
  });
  it("accepts ordinary values and defaults to all 12 checks", () => {
    const v = validateAuditArgs({ scenePath: "res://town.tscn", root: "Block3/Props" });
    expect(v).toMatchObject({ scenePath: "res://town.tscn", root: "Block3/Props", minSeverity: "look", offset: 0, limit: 15, render: "none", budgetMs: 3000 });
    expect(v.checks).toEqual([...AUDIT_CHECKS]);
    expect(AUDIT_CHECKS).toHaveLength(12);
  });

  it("takes no kit metadata: a manifests argument is refused by the schema, and the removed checks are unknown", async () => {
    const { sceneAuditArgsSchema } = await import("./args.js");
    expect(sceneAuditArgsSchema.safeParse({ manifests: ["res://kit/kit.json"] }).success).toBe(false);
    for (const gone of ["insert_host", "mount_gap"]) {
      expect(() => validateAuditArgs({ checks: [gone as never] })).toThrow(ToolInputError);
    }
  });

  it("sends nothing when any argument is hostile", async () => {
    const engine = fakeEngine({ projectRoot: project });
    await expect(sceneAudit(engine, { root: '"); OS.execute("x' })).rejects.toThrow(/Nothing was sent/);
    await expect(sceneAudit(engine, { scenePath: "res://$&.tscn\n" })).rejects.toThrow(/Nothing was sent/);
    expect(engine.calls).toEqual([]);
  });
});

describe("the private-copy path: arguments travel as data, the kernel is read-only", () => {
  it("embeds only the validated scene path and the kernel; root and checks go to config.json", async () => {
    const engine = fakeEngine({ projectRoot: project, audit: () => kernelResult() });
    await sceneAudit(engine, { scenePath: "res://levels/town.tscn", root: "Block 3", checks: ["through_hole"] });
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]).toMatchObject({ op: "ScenePreview", framing: "free", size: [16, 16] });
    const wrapper = engine.wrappers[0]!;
    expect(wrapper).toContain('[ext_resource type="PackedScene" path="res://levels/town.tscn" id="1_subject"]');
    expect(wrapper).not.toContain("Block 3");
    expect(wrapper).toContain(escapeTscnString(loadAuditKernel()));
    expect(engine.configs[0]).toMatchObject({ mode: "audit", root: "Block 3", checks: ["through_hole"], poses: false, budget_ms: 3000, scene_path: "res://levels/town.tscn" });
    expect(engine.configs[0]).not.toHaveProperty("manifests");
  });

  it("the kernel reads its config from its own wrapper and never writes project files or shells out", () => {
    const kernel = loadAuditKernel();
    expect(kernel).toContain('get_slice("::", 0)');
    expect(kernel).toContain('path_join("config.json")');
    for (const forbidden of ["OS.execute", "OS.shell", "OS.create_process", "DirAccess", "ResourceSaver", "EditorInterface", "set_owner", "queue_free", "add_child", "remove_child", "set_meta", "ProjectSettings.set", "save("]) {
      expect(kernel, forbidden).not.toContain(forbidden);
    }
    // The only file it opens for writing is result.json in its own directory.
    expect(kernel.match(/FileAccess\.open\(/g)).toHaveLength(1);
    expect(kernel).toContain('FileAccess.open(_out_dir.path_join("result.json"), FileAccess.WRITE)');
  });

  it("gives roles from geometry and engine data only: no names, no metadata files", () => {
    const kernel = loadAuditKernel();
    const fns = new Map(kernel.split("\nfunc ").slice(1).map((body) => [body.slice(0, body.indexOf("(")), body] as const));
    // No name patterns at all, and no metadata read besides its own config.
    expect(kernel).not.toMatch(/RegEx\.create_from_string\("\(\?i\)/);
    expect(kernel).not.toMatch(/manifest/i);
    expect(kernel).not.toMatch(/path_join\("(?!config\.json"|result\.json")[^"]*\.(json|md)"\)/);
    for (const name of ["_see_through", "_mat_see_through", "_shape_of", "_classify_shapes", "_classify_rest", "_sheet_front", "_walls_under", "_find_inserts", "_open_at", "_facade_lines", "_find_members", "_touch_line", "_member", "_resolve_underlays", "_zf_flags"]) {
      const body = fns.get(name);
      expect(body, name).toBeDefined();
      for (const field of ['["piece"]', '["name"]', '["scene"]', '["path"]', ".name", "resource_path", "resource_name", "RegEx"]) {
        expect(body, `${name} reads ${field}`).not.toContain(field);
      }
    }
  });
});

describe("sceneAudit", () => {
  it("returns a page under 5 KB with counts, time per check and sorted issues", async () => {
    const engine = fakeEngine({ projectRoot: project, audit: () => kernelResult() });
    const r = (await sceneAudit(engine, { scenePath: "res://town.tscn" })) as AuditSuccess;
    expect(r.ok).toBe(true);
    expect(bytes(r.summary)).toBeLessThanOrEqual(SUMMARY_CAP_BYTES);
    expect(r.image).toBeNull();
    const issues = r.summary.issues as Array<Record<string, unknown>>;
    expect(issues[0]).toMatchObject({ n: 1, check: "through_hole", sev: "error", path: "House/Back/Frame" });
    expect(issues[1]).toMatchObject({ n: 2, check: "floating", sev: "error", path: "House/Back/Lamp" });
    expect(r.summary.counts).toMatchObject({ through_hole: { error: 1 }, floating: { error: 1, warn: 200 } });
    expect(r.summary.ms).toMatchObject({ setup: 237, through_hole: 180, editor_total: 700 });
    expect(r.summary.next_offset).toBe(issues.length);
    expect(r.summary.total).toBe(r.summary.matching);
  });

  it("pages, filters by check and severity", async () => {
    const engine = fakeEngine({ projectRoot: project, audit: () => kernelResult() });
    const errorsOnly = (await sceneAudit(engine, { scenePath: "res://a.tscn", min_severity: "error" })) as AuditSuccess;
    expect(errorsOnly.summary.matching).toBe(2);
    expect(errorsOnly.summary.next_offset).toBeNull();
    const page2 = (await sceneAudit(engine, { scenePath: "res://a.tscn", offset: 5, limit: 3 })) as AuditSuccess;
    expect((page2.summary.issues as Array<{ n: number }>).map((i) => i.n)).toEqual([6, 7, 8]);
    const only = (await sceneAudit(engine, { scenePath: "res://a.tscn", checks: ["through_hole"] })) as AuditSuccess;
    expect(only.summary.counts).toEqual({ through_hole: { error: 1 } });
    expect(engine.configs.at(-1)!.checks).toEqual(["through_hole"]);
  });

  it("render sheet: one more ScenePreview, ONE image with tiles labelled by issue number", async () => {
    const engine = fakeEngine({ projectRoot: project, audit: () => kernelResult() });
    const r = (await sceneAudit(engine, { scenePath: "res://a.tscn", render: "sheet", limit: 4 })) as AuditSuccess;
    expect(engine.calls).toHaveLength(2);
    expect(engine.configs[0]).toMatchObject({ mode: "audit", poses: true });
    const render = engine.configs[1]!;
    expect(render.mode).toBe("render");
    const tiles = render.tiles as Array<{ label: string; pose: { position: number[]; look_at: number[] } }>;
    expect(tiles.map((t) => t.label)).toEqual(["#1 through_hole", "#2 floating", "#3 floating", "#4 floating"]);
    // The hole is framed from its open side (the street, -Z), never from behind the wall.
    expect(tiles[0]!.pose.position[2]).toBeLessThan(tiles[0]!.pose.look_at[2]!);
    expect(r.image).toMatchObject({ base64: OK_JPEG.toString("base64"), mime: "image/jpeg" });
    expect(r.summary.sheet).toMatchObject({ tiles: [1, 2, 3, 4] });
    expect(bytes(r.summary)).toBeLessThanOrEqual(SUMMARY_CAP_BYTES);
  });

  it("a kernel that never ran is a structured failure", async () => {
    const engine = fakeEngine({ projectRoot: project, silentKernel: true });
    const r = await sceneAudit(engine, { scenePath: "res://a.tscn" });
    expect(r).toMatchObject({ ok: false, failure_reason: "audit_did_not_run" });
  });

  it("a kernel failure passes its reason through", async () => {
    const engine = fakeEngine({ projectRoot: project, audit: () => ({ ok: false, stage: "collect", failure_reason: "node_not_found", errors: ["root node not found in the scene: Nope"] }) });
    const r = await sceneAudit(engine, { scenePath: "res://a.tscn", root: "Nope" });
    expect(r).toMatchObject({ ok: false, failure_reason: "node_not_found" });
  });

  it("an engine without ScenePreview answers engine_lacks_op and sends nothing", async () => {
    const engine = fakeEngine({ projectRoot: project, capabilities: { opKinds: ["GetSceneTree"] } });
    const r = await sceneAudit(engine, { scenePath: "res://a.tscn" });
    expect(r).toMatchObject({ ok: false, failure_reason: "engine_lacks_op" });
    expect(engine.calls).toEqual([]);
  });

  it("floor_gap: the kernel's strips reach the page", async () => {
    const engine = fakeEngine({
      projectRoot: project,
      audit: () => ({
        ok: true,
        stage: "done",
        instances: [
          inst("Ground/B0", { k: "floor_tile_b", s: "res://kit/ground/floor_tile_b.tscn", r: "floor", c: [0, 0, -11], e: [8.4, 0.1, 7.5] }),
          inst("Ground/Underlay", { k: "underlay", s: "", r: "underlay" }),
          inst("Block1/Backdrop", { k: "backdrop", r: "wall" }),
        ],
        floors: { cell: 0.32, per_owner: [[0, 300, 0, 0, 0]], gaps: Array.from({ length: 8 }, (_, k) => [k * 0.25, -15.13, 0.02, 0, 1, -0.055, 4, 2, 0.25, 0.1, 0.025, null, -1, 2]) },
      }),
    });
    const r = (await sceneAudit(engine, { scenePath: "res://a.tscn", checks: ["floor_gap"] })) as AuditSuccess;
    const [issue] = r.summary.issues as Array<{ why: string; next: string; ev: Record<string, unknown> }>;
    expect(issue!.why).toMatch(/^bare strip 2 x 0.1 m \(0.2 m2\) between Ground\/B0's edge and Block1\/Backdrop/);
    expect(issue!.next).toBe("summer_measure Ground/B0 vs Block1/Backdrop; extend the floor to the wall");
  });

  it("budget_ms: a check past its share stops and is reported partial in the counts, never clean", async () => {
    // A kernel under load: with the default budget the facade scan covers
    // 62% and the floor scan 40%; with 20 s, everything.
    const slow = (config: Record<string, unknown>) => ({
      ...kernelResult(),
      floors: { cell: 0.3, gaps: [], per_owner: [] },
      partial: Number(config.budget_ms) >= 20000 ? {} : { through_hole: [620, 1000], floor_gap: [400, 1000] },
    });
    const engine = fakeEngine({ projectRoot: project, audit: slow });
    const r = (await sceneAudit(engine, { scenePath: "res://a.tscn", checks: ["through_hole", "floor_gap"] })) as AuditSuccess;
    expect(engine.configs[0]!.budget_ms).toBe(3000);
    expect(r.summary.counts).toEqual({ through_hole: { error: 1, partial: 0.62 }, floor_gap: { partial: 0.4 } });
    expect(r.summary.clean).toEqual([]);
    expect(r.summary.budget_ms).toBe(3000);
    expect((r.summary.notes as string[]).some((n) => n.startsWith("budget_ms 3000: stopped early (editor time): through_hole 62%, floor_gap 40% covered"))).toBe(true);
    expect(bytes(r.summary)).toBeLessThanOrEqual(SUMMARY_CAP_BYTES);
    const full = (await sceneAudit(engine, { scenePath: "res://a.tscn", checks: ["through_hole", "floor_gap"], budget_ms: 20000 })) as AuditSuccess;
    expect(engine.configs[1]!.budget_ms).toBe(20000);
    expect(full.summary.counts).toEqual({ through_hole: { error: 1 } });
    expect(full.summary.clean).toEqual(["floor_gap"]);
  });

  it("the kernel polls the budget in every check loop and reports what it covered", () => {
    const kernel = loadAuditKernel();
    const fns = new Map(kernel.split("\nfunc ").slice(1).map((body) => [body.slice(0, body.indexOf("(")), body] as const));
    for (const name of ["_scan_line", "_scan_floors", "_scan_strips", "_scan_support", "_scan_overlaps", "_scan_long_props", "_scan_uv", "_scan_zfight_geometry", "_scan_lights", "_scan_resources", "_scan_clearances"]) {
      const body = fns.get(name);
      expect(body, name).toBeDefined();
      expect(body, name).toContain("_over()");
      expect(body, name).toContain("_count(");
    }
    expect(kernel).toContain('_budget_us = int(float(_cfg.get("budget_ms", 0)) * 1000.0)');
    expect(kernel).toContain('_result["partial"] = partial');
  });

  it("z_fight geometry: its own time in ms, partial under the budget like any check, and the 5 KB cap holds", async () => {
    const pairs = Array.from({ length: 60 }, (_, k) => [2 + 2 * k, 3 + 2 * k, 0.4, 0, [k, 3, -8], [0, 0, 1], 5, "walkable area", true, [], [], "brick", "brick", false, 0.4, 2, `Props/Crate_${2 * k}`, `Props/Crate_${3 + 2 * k}`]);
    const engine = fakeEngine({
      projectRoot: project,
      audit: () => ({ ...kernelResult(), ms: { ...kernelResult().ms, z_fight_geometry: 210 }, zfight_geo: { near: 0.05, far: 4000, pairs, in_mesh: [] }, partial: { z_fight_geometry: [70, 100] } }),
    });
    const r = (await sceneAudit(engine, { scenePath: "res://a.tscn", checks: ["z_fight"] })) as AuditSuccess;
    expect(r.summary.ms).toMatchObject({ z_fight_geometry: 210 });
    expect(r.summary.counts).toEqual({ z_fight: { warn: 60, partial: 0.7 } });
    expect(bytes(r.summary)).toBeLessThanOrEqual(SUMMARY_CAP_BYTES);
    expect((r.summary.issues as unknown[]).length).toBeGreaterThan(2);
  });

  it("without scenePath it audits the open scene", async () => {
    const engine = fakeEngine({ projectRoot: project, audit: () => kernelResult() });
    const r = (await sceneAudit(engine, {})) as AuditSuccess;
    expect(r.summary.scenePath).toBe("res://main.tscn");
  });
});
