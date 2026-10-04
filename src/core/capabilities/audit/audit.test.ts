import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolInputError } from "../../tool-errors.js";
import { fakeEngine, OK_JPEG } from "../../../test-helpers/seeing-engine.js";
import { escapeTscnString } from "../seeing/probe.js";
import { loadAuditKernel, sceneAudit, validateAuditArgs, validateManifestPath, type AuditSuccess } from "./audit.js";
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

/** A kernel result with one through hole, one insert in the wrong host and
 *  200 floating crates (enough to overflow any page). */
function kernelResult() {
  const crates = Array.from({ length: 200 }, (_, i) => inst(`Props/Crate_${i}`, { o: [i, 0, 3], c: [i, 0.5, 3] }));
  const instances = [
    inst("House/Back/Frame", { k: "high_rise_facade_frame_tripple", r: "wall", o: [31.5, 0, -7.9], c: [31.5, 1.5, -7.9] }),
    inst("House/Back/Door", { k: "door_tripple_standard_03", r: "insert", o: [31.5, 0, -7.9], c: [31.5, 1.4, -7.9] }),
    ...crates,
  ];
  return {
    ok: true,
    stage: "done",
    ms: { collect: 5, manifests_roles: 2, mesh_pass: 90, physics_build: 140, through_hole: 180, floor_gap: 90, floating_sunken: 4, insert_host: 10, total: 700 },
    stats: { nodes: 2692, instances: 202, mesh_instances: 690, unique_meshes: 106, tris_unique: 336553, rays: 80000 },
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
    inserts: [[1, "wall_tripple_standard_door_02", [0, 0, -0.105], [31.5, 0, -7.9], [-1, 0, 0, 0, 1, 0, 0, 0, -1], [[0, "high_rise_facade_frame_tripple", [31.5, 0, -7.9], [-1, 0, 0, 0, 1, 0, 0, 0, -1]]], [0]]],
    support: crates.map((_, i) => [i + 2, 0.06, 0.4, Array.from({ length: 5 }, () => [0, -1])]),
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
  it.each([...HOSTILE, "res://a.gd", "res://../pieces.json", "user://pieces.json", "res://x/pieces.json\n", 'res://"x.json', "res://a$b.json", "res:///etc/passwd.json"])("refuses manifest %j", (value) => {
    expect(() => validateManifestPath(value)).toThrow(ToolInputError);
  });
  it("refuses unknown checks and bad paging", () => {
    expect(() => validateAuditArgs({ checks: ["everything" as never] })).toThrow(ToolInputError);
    expect(() => validateAuditArgs({ offset: -1 })).toThrow(ToolInputError);
    expect(() => validateAuditArgs({ limit: 0 })).toThrow(ToolInputError);
    expect(() => validateAuditArgs({ limit: 51 })).toThrow(ToolInputError);
    expect(() => validateAuditArgs({ manifests: Array(9).fill("res://a/pieces.json") })).toThrow(ToolInputError);
  });
  it("accepts ordinary values and defaults to all 14 checks", () => {
    const v = validateAuditArgs({ scenePath: "res://three_houses_v2.tscn", root: "Alley3/Props", manifests: ["res://starter/real-city-alley-kit/pieces.json"] });
    expect(v).toMatchObject({ scenePath: "res://three_houses_v2.tscn", root: "Alley3/Props", minSeverity: "look", offset: 0, limit: 15, render: "none" });
    expect(v.checks).toEqual([...AUDIT_CHECKS]);
  });

  it("sends nothing when any argument is hostile", async () => {
    const engine = fakeEngine({ projectRoot: project });
    await expect(sceneAudit(engine, { root: '"); OS.execute("x' })).rejects.toThrow(/Nothing was sent/);
    await expect(sceneAudit(engine, { scenePath: "res://$&.tscn\n" })).rejects.toThrow(/Nothing was sent/);
    await expect(sceneAudit(engine, { manifests: ["res://../../x.json"] })).rejects.toThrow(/Nothing was sent/);
    expect(engine.calls).toEqual([]);
  });
});

describe("the private-copy path: arguments travel as data, the kernel is read-only", () => {
  it("embeds only the validated scene path and the kernel; root, checks and manifests go to config.json", async () => {
    const engine = fakeEngine({ projectRoot: project, audit: () => kernelResult() });
    await sceneAudit(engine, { scenePath: "res://levels/town.tscn", root: "Alley 3", checks: ["through_hole"], manifests: ["res://kit/pieces.json"] });
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]).toMatchObject({ op: "ScenePreview", framing: "free", size: [16, 16] });
    const wrapper = engine.wrappers[0]!;
    expect(wrapper).toContain('[ext_resource type="PackedScene" path="res://levels/town.tscn" id="1_subject"]');
    expect(wrapper).not.toContain("Alley 3");
    expect(wrapper).not.toContain("res://kit/pieces.json");
    expect(wrapper).toContain(escapeTscnString(loadAuditKernel()));
    expect(engine.configs[0]).toMatchObject({ mode: "audit", root: "Alley 3", checks: ["through_hole"], manifests: ["res://kit/pieces.json"], poses: false, scene_path: "res://levels/town.tscn" });
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
});

describe("sceneAudit", () => {
  it("returns a page under 5 KB with counts, time per check and sorted issues", async () => {
    const engine = fakeEngine({ projectRoot: project, audit: () => kernelResult() });
    const r = (await sceneAudit(engine, { scenePath: "res://three_houses_v2.tscn" })) as AuditSuccess;
    expect(r.ok).toBe(true);
    expect(bytes(r.summary)).toBeLessThanOrEqual(SUMMARY_CAP_BYTES);
    expect(r.image).toBeNull();
    const issues = r.summary.issues as Array<Record<string, unknown>>;
    expect(issues[0]).toMatchObject({ n: 1, check: "through_hole", sev: "error", path: "House/Back/Frame" });
    expect(issues[1]).toMatchObject({ n: 2, check: "insert_host", sev: "error", path: "House/Back/Door" });
    expect(r.summary.counts).toMatchObject({ through_hole: { error: 1 }, insert_host: { error: 1 } });
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
    const only = (await sceneAudit(engine, { scenePath: "res://a.tscn", checks: ["insert_host"] })) as AuditSuccess;
    expect(only.summary.counts).toEqual({ insert_host: { error: 1 } });
    expect(engine.configs.at(-1)!.checks).toEqual(["insert_host"]);
  });

  it("render sheet: one more ScenePreview, ONE image with tiles labelled by issue number", async () => {
    const engine = fakeEngine({ projectRoot: project, audit: () => kernelResult() });
    const r = (await sceneAudit(engine, { scenePath: "res://a.tscn", render: "sheet", limit: 4 })) as AuditSuccess;
    expect(engine.calls).toHaveLength(2);
    expect(engine.configs[0]).toMatchObject({ mode: "audit", poses: true });
    const render = engine.configs[1]!;
    expect(render.mode).toBe("render");
    const tiles = render.tiles as Array<{ label: string; pose: { position: number[]; look_at: number[] } }>;
    expect(tiles.map((t) => t.label)).toEqual(["#1 through_hole", "#2 insert_host", "#3 floating", "#4 floating"]);
    // The hole is framed from its open side (the alley, -Z), never from behind the wall.
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

  it("without scenePath it audits the open scene", async () => {
    const engine = fakeEngine({ projectRoot: project, audit: () => kernelResult() });
    const r = (await sceneAudit(engine, {})) as AuditSuccess;
    expect(r.summary.scenePath).toBe("res://main.tscn");
  });
});
