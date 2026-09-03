/**
 * Unit tests for the outcome-eval harness (no engine, no model): the .tscn /
 * project.godot readers, the assertion predicates and their two rules
 * (evidence_missing is a FAIL; required gates), the probe builder, task-file
 * validation, golden compilation drift, and the opKinds pre-flight refusal.
 * These run in `npm test`; the engine-backed replay is `npm run eval:outcomes`.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  aabbIoU,
  evaluateAll,
  evaluateAssertion,
  matchSelector,
  parseVec3,
  taskVerdict,
  type Evidence,
  type Snapshot,
} from "./lib/assert.ts";
import { buildProbe, taskNeedsProbe } from "./lib/probe.ts";
import { crossCheckTasks, loadTasks, validateTaskShape } from "./lib/tasks.ts";
import { nodePathFor, parseProjectGodot, parseTscn, parseTscnValue, projectInputEventCount, projectMainScene } from "./lib/tscn.ts";
import { checkGoldens, compileGolden, goldenSourceFiles } from "./golden/compile.ts";

const here = import.meta.dirname;
const distPresent = existsSync(join(here, "..", "..", "dist", "core", "capability-skew.js"));

const TSCN = `[gd_scene load_steps=3 format=3 uid="uid://abc"]

[ext_resource type="Script" path="res://scripts/main/Player.gd" id="1_p"]

[sub_resource type="RectangleShape2D" id="RectangleShape2D_1"]
size = Vector2(32, 48)

[sub_resource type="Animation" id="Animation_a"]
length = 6.0
tracks/0/type = "position_3d"
tracks/0/path = NodePath("Camera3D")
tracks/0/keys = PackedFloat32Array(0, 1, -10, 12, 18, 3, 1, 14, 10, 14)

[sub_resource type="AnimationLibrary" id="AnimationLibrary_l"]
_data = {
&"flyover": SubResource("Animation_a")
}

[node name="Main" type="Node2D" unique_id=1]

[node name="Player" type="CharacterBody2D" parent="." unique_id=2]
position = Vector2(120, 560)
script = ExtResource("1_p")

[node name="CollisionShape2D" type="CollisionShape2D" parent="Player" unique_id=3]
shape = SubResource("RectangleShape2D_1")

[node name="HUD" type="CanvasLayer" parent="."]

[node name="ScoreLabel" type="Label" parent="HUD"]
anchors_preset = 1
anchor_left = 1.0
anchor_right = 1.0
text = "Score: 0"

[node name="AnimationPlayer" type="AnimationPlayer" parent="."]
libraries = {
&"": SubResource("AnimationLibrary_l")
}
autoplay = "flyover"

[connection signal="body_entered" from="Player" to="." method="_on_body_entered"]
`;

const PROJECT_GODOT = `; comment
config_version=5

[application]

config/name="X"
run/main_scene="res://main.tscn"
config/features=PackedStringArray("4.7")

[input]

move_left={
"deadzone": 0.5,
"events": [Object(InputEventKey,"resource_local_to_scene":false,"keycode":4194319,"pressed":false)
]
}
jump={
"deadzone": 0.5,
"events": [Object(InputEventKey,"keycode":32), Object(InputEventJoypadButton,"button_index":0)]
}
`;

describe("tscn reader", () => {
  const scene = parseTscn(TSCN);
  it("reads header, resources, nodes with root-relative paths, and connections", () => {
    expect(scene.header.format).toBe("3");
    expect(scene.extResources[0]).toMatchObject({ type: "Script", path: "res://scripts/main/Player.gd", id: "1_p" });
    expect(scene.subResources.map((r) => r.type)).toEqual(["RectangleShape2D", "Animation", "AnimationLibrary"]);
    expect(scene.nodes.map((n) => n.path)).toEqual([".", "Player", "Player/CollisionShape2D", "HUD", "HUD/ScoreLabel", "AnimationPlayer"]);
    expect(scene.nodes[1]!.props.script).toBe('ExtResource("1_p")');
    expect(scene.connections).toEqual([{ signal: "body_entered", from: "Player", to: ".", method: "_on_body_entered", attrs: expect.any(Object) }]);
  });
  it("keeps multi-line values whole and parses scalar literals", () => {
    const lib = scene.subResources.find((r) => r.type === "AnimationLibrary")!;
    expect(lib.props._data).toContain('&"flyover": SubResource("Animation_a")');
    const player = scene.nodes.find((n) => n.name === "AnimationPlayer")!;
    expect(player.props.autoplay).toBe('"flyover"');
    expect(parseTscnValue(player.props.autoplay!)).toBe("flyover");
    expect(parseTscnValue("6.0")).toBe(6);
    expect(parseTscnValue("true")).toBe(true);
    expect(parseTscnValue('NodePath("Camera3D")')).toBe("Camera3D");
    expect(nodePathFor("Box", "Grid")).toBe("Grid/Box");
  });
  it("reads project.godot sections, the main scene and input event counts", () => {
    const project = parseProjectGodot(PROJECT_GODOT);
    expect(projectMainScene(project)).toBe("res://main.tscn");
    expect(projectInputEventCount(project, "move_left")).toBe(1);
    expect(projectInputEventCount(project, "jump")).toBe(2);
    expect(projectInputEventCount(project, "missing")).toBeNull();
  });
});

function snapshot(partial: Partial<Snapshot>): Snapshot {
  return { nodes: [], lights: [], cameras: [], counts: {}, truncated: false, ...partial };
}

const box = (name: string, path: string, x: number, y: number, z: number, size = 1, cls = "MeshInstance3D") => ({
  name,
  path,
  class: cls,
  aabb: { pos: `Vector3(${x}, ${y}, ${z})`, size: `Vector3(${size}, ${size}, ${size})` },
});

function evidence(partial: Partial<Evidence>): Evidence {
  return { snap: null, diff: null, tscn: null, project: null, runtime: null, probe: null, preview: null, ...partial };
}

describe("assertion predicates", () => {
  const snap = snapshot({
    nodes: [
      { name: "Main", path: ".", class: "Node3D" },
      box("Cube_A", "Cube_A", -4.5, 0, -0.5),
      box("Cube_B", "Cube_B", -2.5, 0.2, -0.5),
      box("Wall_North", "Wall_North", -10, 0, -10, 2),
      box("Fountain", "Fountain", -1, 0, -1, 2),
      box("Bench", "Bench", -0.5, 0, 0),
      { name: "Terrain", path: "Terrain", class: "MeshInstance3D" },
      { name: "StaticBody3D", path: "Terrain/StaticBody3D", class: "StaticBody3D" },
      { name: "CollisionShape3D", path: "Terrain/StaticBody3D/CollisionShape3D", class: "CollisionShape3D" },
      { name: "Loose", path: "Loose", class: "StaticBody2D" },
      { name: "Player", path: "Player", class: "CharacterBody2D", script_fp: "abcd1234" },
      { name: "Shape", path: "Player/Shape", class: "CollisionShape2D" },
    ],
    lights: [{ path: "Sun", class: "DirectionalLight3D", energy: 1.2, color: "Color(1,1,1,1)" }],
    cameras: [{ path: "Camera3D", current: true }],
    counts: { MeshInstance3D: 6, DirectionalLight3D: 1, CharacterBody2D: 1, StaticBody2D: 1 },
  });
  const tscn = parseTscn(`[gd_scene format=3]

[ext_resource type="Script" path="res://p.gd" id="1"]

[node name="Main" type="Node3D"]

[node name="Cube_A" type="MeshInstance3D" parent="."]

[node name="Player" type="CharacterBody2D" parent="."]
script = ExtResource("1")
`);
  const ev = evidence({ snap, tscn });

  it("selectors match by name glob, class: and path: with alternation", () => {
    const node = { name: "Wall_North", path: "Grid/Wall_North", class: "MeshInstance3D" };
    expect(matchSelector("Wall*|Floor*", node)).toBe(true);
    expect(matchSelector("class:MeshInstance3D", node)).toBe(true);
    expect(matchSelector("path:Grid/*", node)).toBe(true);
    expect(matchSelector("Floor*", node)).toBe(false);
    expect(parseVec3("Vector3(1.5, -2, 3e1)")).toEqual({ x: 1.5, y: -2, z: 30 });
  });

  it("count / lights / camera_current read the snapshot", () => {
    expect(evaluateAssertion({ id: "c", predicate: "count", args: { class: "MeshInstance3D", op: ">=", value: 6 }, required: true }, ev).pass).toBe(true);
    expect(evaluateAssertion({ id: "c", predicate: "count", args: { class: "MeshInstance3D", op: ">", value: 6 }, required: true }, ev).pass).toBe(false);
    expect(evaluateAssertion({ id: "l", predicate: "lights", args: { min: 1, energy_range: [1, 2] }, required: true }, ev).pass).toBe(true);
    expect(evaluateAssertion({ id: "l", predicate: "lights", args: { min: 2 }, required: true }, ev)).toMatchObject({ pass: false, reason: "too_few_lights" });
    expect(evaluateAssertion({ id: "k", predicate: "camera_current", args: {}, required: true }, ev).pass).toBe(true);
  });

  it("exists needs the node in BOTH the edited scene and the saved file (unsaved = failure)", () => {
    expect(evaluateAssertion({ id: "e", predicate: "exists", args: { selector: "Cube_A" }, required: true }, ev).pass).toBe(true);
    const unsaved = evaluateAssertion({ id: "e", predicate: "exists", args: { selector: "Cube_*" }, required: true }, ev);
    expect(unsaved).toMatchObject({ pass: false, reason: "unsaved", severity: "unsaved" });
    expect((unsaved.detail as { unsaved: string[] }).unsaved).toEqual(["Cube_B"]);
    expect(evaluateAssertion({ id: "e", predicate: "exists", args: { selector: "Nothing*" }, required: true }, ev)).toMatchObject({ pass: false, reason: "no_match", severity: "structural" });
  });

  it("spatial predicates: on_ground, no_overlap, aabb_within, gold_iou", () => {
    expect(evaluateAssertion({ id: "g", predicate: "on_ground", args: { selector: "Cube_A", ground_y: 0, eps: 0.05 }, required: true }, ev).pass).toBe(true);
    const floating = evaluateAssertion({ id: "g", predicate: "on_ground", args: { selector: "Cube_*", ground_y: 0, eps: 0.05 }, required: true }, ev);
    expect(floating).toMatchObject({ pass: false, reason: "floating", severity: "spatial" });
    expect(evaluateAssertion({ id: "o", predicate: "no_overlap", args: { a: "Fountain*", b: "Wall*", tol: 0.01 }, required: true }, ev).pass).toBe(true);
    const overlap = evaluateAssertion({ id: "o", predicate: "no_overlap", args: { a: "Bench", b: "Fountain*", tol: 0 }, required: true }, ev);
    expect(overlap).toMatchObject({ pass: false, reason: "overlap" });
    expect((overlap.detail as { overlaps: string[][] }).overlaps).toEqual([["Bench", "Fountain"]]);
    expect(evaluateAssertion({ id: "w", predicate: "aabb_within", args: { selector: "Cube_A", size: { y: [0.9, 1.1] }, min: [-5, -1, -1], max: [5, 2, 1] }, required: true }, ev).pass).toBe(true);
    // Cube_A matches its gold box exactly (IoU 1); Cube_B floats 0.2 above it
    // (IoU 0.8/1.2 = 0.667): mean 0.833 < 0.9 -> the layout check fails.
    const gold = [{ name: "Cube_A", aabb: { pos: "Vector3(-4.5, 0, -0.5)", size: "Vector3(1, 1, 1)" } }, { name: "Cube_B", aabb: { pos: "Vector3(-2.5, 0, -0.5)", size: "Vector3(1, 1, 1)" } }];
    const iou = evaluateAssertion({ id: "iou", predicate: "gold_iou", args: { min: 0.9 }, required: true }, evidence({ snap, tscn, gold }));
    expect(iou).toMatchObject({ pass: false, reason: "gold_mismatch", severity: "spatial" });
    expect((iou.detail as { mean_iou: number }).mean_iou).toBeCloseTo(0.833, 2);
    expect(evaluateAssertion({ id: "iou", predicate: "gold_iou", args: { min: 0.8 }, required: true }, evidence({ snap, tscn, gold })).pass).toBe(true);
    expect(aabbIoU({ pos: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } }, { pos: { x: 0.5, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } })).toBeCloseTo(1 / 3);
  });

  it("collision_under walks the path-sorted node list; script_attached needs live fp + saved script", () => {
    expect(evaluateAssertion({ id: "t", predicate: "collision_under", args: { selector: "*Terrain*" }, required: true }, ev).pass).toBe(true);
    expect(evaluateAssertion({ id: "p", predicate: "collision_under", args: { selector: "Player*" }, required: true }, ev).pass).toBe(true);
    const loose = evaluateAssertion({ id: "s", predicate: "collision_under", args: { selector: "class:StaticBody2D" }, required: true }, ev);
    expect(loose).toMatchObject({ pass: false, reason: "no_collision" });
    expect(evaluateAssertion({ id: "sc", predicate: "script_attached", args: { selector: "Player*" }, required: true }, ev).pass).toBe(true);
    expect(evaluateAssertion({ id: "sc", predicate: "script_attached", args: { selector: "Cube_A" }, required: true }, ev).pass).toBe(false);
  });

  it("tscn_prop / tscn_resource / signal_connected / input_action / main_scene read the on-disk files", () => {
    const scene = parseTscn(TSCN);
    const project = parseProjectGodot(PROJECT_GODOT);
    const disk = evidence({ snap, tscn: scene, project });
    expect(evaluateAssertion({ id: "a", predicate: "tscn_prop", args: { selector: "class:Label", key: "anchor_right", op: "==", value: 1.0, quantifier: "any" }, required: true }, disk).pass).toBe(true);
    expect(evaluateAssertion({ id: "a", predicate: "tscn_prop", args: { selector: "class:Label", key: "anchor_left", op: "==", value: 0.5 }, required: true }, disk).pass).toBe(false);
    expect(evaluateAssertion({ id: "ap", predicate: "tscn_prop", args: { selector: "class:AnimationPlayer", key: "autoplay", op: "exists" }, required: true }, disk).pass).toBe(true);
    expect(evaluateAssertion({ id: "r", predicate: "tscn_resource", args: { type: "Animation", key: "length", op: ">=", value: 5.5 }, required: true }, disk).pass).toBe(true);
    expect(evaluateAssertion({ id: "r", predicate: "tscn_resource", args: { type: "Animation", key: "tracks/*/type", op: "==", value: "position_3d" }, required: true }, disk).pass).toBe(true);
    expect(evaluateAssertion({ id: "r", predicate: "tscn_resource", args: { type: "HeightMapShape3D" }, required: true }, disk)).toMatchObject({ pass: false, reason: "resource_missing" });
    expect(evaluateAssertion({ id: "s", predicate: "signal_connected", args: { from: "Player", signal: "body_entered", to: "*", method: "*" }, required: true }, disk).pass).toBe(true);
    expect(evaluateAssertion({ id: "i", predicate: "input_action", args: { name: "jump", min_events: 2 }, required: true }, disk).pass).toBe(true);
    expect(evaluateAssertion({ id: "i", predicate: "input_action", args: { name: "move_right", min_events: 1 }, required: true }, disk)).toMatchObject({ pass: false, reason: "action_missing" });
    expect(evaluateAssertion({ id: "m", predicate: "main_scene", args: { path: "res://main.tscn" }, required: true }, disk).pass).toBe(true);
  });

  it("runtime and probe predicates read their evidence; missing evidence is FAIL(evidence_missing), never a skip", () => {
    const rt = evidence({ runtime: { played: true, running_during_window: true, errors: [], error_count: 0, stopped: true, seconds: 3 } });
    expect(evaluateAssertion({ id: "rc", predicate: "runs_clean", args: { seconds: 3 }, required: true }, rt).pass).toBe(true);
    const dirty = evidence({ runtime: { played: true, running_during_window: true, errors: [{ error: "x" }], error_count: 1, stopped: true, seconds: 3 } });
    expect(evaluateAssertion({ id: "rc", predicate: "runs_clean", args: { seconds: 3 }, required: true }, dirty)).toMatchObject({ pass: false, reason: "debugger_errors", severity: "runtime" });
    const probe = evidence({
      probe: { ok: true, reports: { sees: { camera: true, matched: 2, corners_inside: 15, corners_total: 16, fraction: 0.938 }, sm: { found: true, active: true, state: "Idle" }, "_colors:hud": 12, y_delta_after_jump: 87.5 }, frames: ["hud.jpg"], frame_warnings: [], errors_seen: [], finished: true },
    });
    expect(evaluateAssertion({ id: "sees", predicate: "camera_sees", args: { selector: "Wall*", fraction: 0.9 }, required: true }, probe).pass).toBe(true);
    expect(evaluateAssertion({ id: "sees", predicate: "camera_sees", args: { selector: "Wall*", fraction: 1.0 }, required: true }, probe)).toMatchObject({ pass: false, reason: "out_of_frustum" });
    expect(evaluateAssertion({ id: "sm", predicate: "state_machine", args: { selector: "*", expected_state: "Idle" }, required: true }, probe).pass).toBe(true);
    expect(evaluateAssertion({ id: "sm", predicate: "state_machine", args: { selector: "*", expected_state: "Walk" }, required: true }, probe)).toMatchObject({ pass: false, reason: "wrong_state" });
    expect(evaluateAssertion({ id: "pr", predicate: "probe_report", args: { key: "y_delta_after_jump", op: ">", value: 20 }, required: true }, probe).pass).toBe(true);
    expect(evaluateAssertion({ id: "fb", predicate: "frame_not_blank", args: { name: "hud" }, required: true }, probe).pass).toBe(true);
    expect(evaluateAssertion({ id: "other", predicate: "camera_sees", args: { selector: "Wall*", fraction: 0.5 }, required: true }, probe)).toMatchObject({ pass: false, reason: "evidence_missing", severity: "evidence_missing" });

    const empty = evidence({});
    for (const predicate of ["count", "exists", "added_only", "on_ground", "camera_sees", "runs_clean", "input_action", "preview_camera_ok", "tscn_prop", "runtime_prop"]) {
      const r = evaluateAssertion({ id: predicate, predicate, args: { class: "X", op: ">=", value: 1, selector: "*", name: "x", key: "k", added: [] }, required: true }, empty);
      expect(r, predicate).toMatchObject({ pass: false, reason: "evidence_missing", severity: "evidence_missing" });
    }
    expect(evaluateAssertion({ id: "u", predicate: "no_such_predicate", args: {}, required: true }, ev)).toMatchObject({ pass: false, reason: "evidence_missing" });
  });

  it("preview_camera_ok requires the scene camera, the scene environment and a non-blank frame", () => {
    const good = evidence({ preview: { ok: true, used_scene_camera: true, environment_used: "scene_world_environment", distinct_colors: 300, bytes: 40000 } });
    expect(evaluateAssertion({ id: "pv", predicate: "preview_camera_ok", args: {}, required: true }, good).pass).toBe(true);
    const synthetic = evidence({ preview: { ok: true, used_scene_camera: false, used_synthetic_camera: true, environment_used: "scene_world_environment", distinct_colors: 300, bytes: 1 } });
    expect(evaluateAssertion({ id: "pv", predicate: "preview_camera_ok", args: {}, required: true }, synthetic)).toMatchObject({ pass: false, reason: "synthetic_camera", severity: "visual_gate" });
    const blank = evidence({ preview: { ok: true, used_scene_camera: true, environment_used: "scene_world_environment", distinct_colors: 1, bytes: 1 } });
    expect(evaluateAssertion({ id: "pv", predicate: "preview_camera_ok", args: {}, required: true }, blank)).toMatchObject({ pass: false, reason: "blank_frame" });
  });

  it("added_only accepts only the allowed additions/removals", () => {
    const diff = { added: ["LowWall"], removed: ["GridBox_0", "GridBox_1"], changed: [], counts_delta: {} };
    const d = evidence({ diff });
    expect(evaluateAssertion({ id: "ao", predicate: "added_only", args: { added: ["*Wall*"], removed_allowed: ["GridBox_*"] }, required: true }, d).pass).toBe(true);
    expect(evaluateAssertion({ id: "ao", predicate: "added_only", args: { added: ["*Wall*"] }, required: true }, d)).toMatchObject({ pass: false, reason: "fixture_removed" });
  });

  it("taskVerdict gates on required predicates and reports the first severity in the fixed order", () => {
    const results = evaluateAll(
      [
        { id: "bonus", predicate: "count", args: { class: "MeshInstance3D", op: ">", value: 99 }, required: false },
        { id: "spatial", predicate: "on_ground", args: { selector: "Cube_*", ground_y: 0, eps: 0.01 }, required: true },
        { id: "unsaved", predicate: "exists", args: { selector: "Cube_*" }, required: true },
        { id: "ok", predicate: "camera_current", args: {}, required: true },
      ],
      ev
    );
    const verdict = taskVerdict(results);
    expect(verdict.pass).toBe(false);
    expect(verdict.failed_required.sort()).toEqual(["spatial", "unsaved"]);
    expect(verdict.severity).toBe("unsaved");
    expect(taskVerdict(results.filter((r) => r.id === "ok" || r.id === "bonus"))).toEqual({ pass: true, severity: null, failed_required: [] });
  });
});

describe("probe builder", () => {
  it("emits one report per probe assertion, keyed by assertion id, plus the task snippet", () => {
    const specs = [
      { id: "sees", predicate: "camera_sees", args: { selector: "GridBox_*|class:MeshInstance3D", fraction: 0.9, at_seconds: 6.2 }, required: true },
      { id: "walk", predicate: "state_machine", args: { selector: "*AnimationTree*", expected_state: "Walk", after: { press: "move_forward", hold_ms: 600 } }, required: true },
      { id: "hud", predicate: "frame_not_blank", args: { name: "hud" }, required: true },
      { id: "count", predicate: "count", args: { class: "X", op: ">=", value: 1 }, required: true },
    ];
    const built = buildProbe(specs, 'report("custom", 1)\n');
    expect(built.report_keys).toEqual(["sees", "walk", "hud"]);
    expect(built.source).toContain("extends SummerProbeBase");
    expect(built.source).toContain('_eval_camera_sees("sees", ["GridBox_*"])');
    expect(built.source).toContain('await _eval_hold_action("move_forward", 600)');
    expect(built.source).toContain('save_frame("hud")');
    expect(built.source).toContain('report("_colors:hud"');
    expect(built.source).toContain('\treport("custom", 1)');
    expect(built.source.trimEnd().endsWith("finish()")).toBe(true);
    expect(built.budget_seconds).toBeGreaterThanOrEqual(12);
    expect(taskNeedsProbe([{ id: "c", predicate: "count", args: {}, required: true }])).toBe(false);
    expect(taskNeedsProbe([{ id: "c", predicate: "count", args: {}, required: true }], "report('x', 1)")).toBe(true);
  });
});

describe("task files", () => {
  it("the committed suite loads, cross-checks against fixtures and the registry index, and every task has a golden", () => {
    const tasks = loadTasks(join(here, "tasks"));
    expect(tasks.map((t) => t.id)).toEqual([
      "T1.1-courtyard",
      "T1.3-edit-in-place",
      "T1.4-layout-from-spec",
      "T3.1-three-platforms",
      "T4.1-health-bar",
      "T5.1-idle-walk",
      "T6.1-hills",
      "T7.1-flyover",
    ]);
    expect(crossCheckTasks(tasks, join(here, "fixtures"), join(here, "..", "..", "registry", "generated", "index.json"))).toEqual([]);
    for (const t of tasks) {
      expect(existsSync(join(here, "golden", `${t.id}.golden.jsonl`)), t.id).toBe(true);
      expect(t.assertions.some((a) => a.required)).toBe(true);
    }
  });

  it("rejects malformed task files with named errors", () => {
    const errors = validateTaskShape(
      { id: "bad id", tier: "T1", title: "", prompt: " ", fixture: "empty3d", assertions: [{ id: "a", predicate: "nope", args: {}, required: "yes" }, { id: "a", predicate: "count", args: {} }] },
      "/x/T1.9-x.yaml"
    );
    expect(errors.some((e) => e.includes("id must match"))).toBe(true);
    expect(errors.some((e) => e.includes("unknown predicate"))).toBe(true);
    expect(errors.some((e) => e.includes("duplicate assertion id"))).toBe(true);
    expect(errors.some((e) => e.includes("required must be boolean"))).toBe(true);
    expect(errors.some((e) => e.includes("prompt"))).toBe(true);
  });
});

describe("goldens", () => {
  it("every committed golden JSONL matches its readable source (compile.ts --check)", () => {
    expect(goldenSourceFiles().length).toBe(14);
    expect(checkGoldens()).toEqual([]);
  });
  it("compiles a source into a header line plus one tool_call record per step with expected results", () => {
    const compiled = compileGolden(join(here, "golden", "src", "mutants", "T1.1-courtyard.drop-light.yaml"));
    const lines = compiled.text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ kind: "golden", task: "T1.1-courtyard", mutation: "drop-light", expect_fail: ["light-present"] });
    expect(lines[1]).toMatchObject({ kind: "tool_call", tool: "summer_run_script", result: { ok: true } });
    expect(typeof (lines[1]!.args as Record<string, unknown>).source).toBe("string");
    expect(compiled.out).toBe(join("mutants", "T1.1-courtyard.drop-light.golden.jsonl"));
  });
});

describe.skipIf(!distPresent)("pre-flight refusal (needs dist/ — run npm run build)", () => {
  it("refuses when the advert lacks a needed op, lets an engine without an advert through, and honours the simulate hook", async () => {
    const { preflight, taskOpNeeds } = await import("./lib/preflight.ts");
    const task = {
      assertions: [
        { id: "c", predicate: "count", args: { class: "X", op: ">=", value: 1 }, required: true },
        { id: "rc", predicate: "runs_clean", args: { seconds: 2 }, required: true },
      ],
    };
    const golden = { records: [{ kind: "tool_call" as const, tool: "summer_run_script", args: { source: "x" } }, { kind: "tool_call" as const, tool: "summer_batch", args: { ops: [{ op: "AddNode" }] } }] };
    const needs = taskOpNeeds(task, golden);
    expect([...needs.keys()].sort()).toEqual(
      ["AddNode", "DiffWorldSnapshot", "GetDebuggerErrors", "GetWorldSnapshot", "IsGameRunning", "OpenScene", "PlayGame", "RunSceneScript", "SaveDirtyScenes", "SaveDirtyScripts", "SaveScene", "StopGame"].sort()
    );
    expect(needs.get("RunSceneScript")).toEqual(["replay:summer_run_script"]);
    const full = [...needs.keys()];
    const ok = preflight({ capabilities: { opKinds: full } }, needs);
    expect(ok).toMatchObject({ advertised: true, missing: [] });
    const lacking = preflight({ capabilities: { opKinds: full.filter((op) => op !== "GetWorldSnapshot") } }, needs);
    expect(lacking.missing).toEqual(["GetWorldSnapshot"]);
    const noAdvert = preflight({ version: "0.5.60" }, needs);
    expect(noAdvert).toMatchObject({ advertised: false, missing: [], opkinds_sha256: null });
    const simulated = preflight({ capabilities: { opKinds: full } }, needs, ["GetWorldSnapshot", "RunVerification"]);
    expect(simulated.missing).toEqual(["GetWorldSnapshot"]);
  });
});
