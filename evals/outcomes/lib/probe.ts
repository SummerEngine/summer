/**
 * Probe builder: ONE RunVerification probe per task, generated from the task's
 * probe-backed assertions (camera_sees, state_machine, frame_not_blank) plus an
 * optional task-authored snippet (probe_report keys). The probe runs the saved
 * main scene in the engine's disposable verify child (--fixed-fps 60,
 * --summer-seed 20260725, real renderer), so its reports are reproducible by
 * construction. Every report is keyed by the ASSERTION ID it serves.
 *
 * The harness-owned helpers extend the engine's injected SummerProbeBase
 * (VERIFY_RUNNER.md) — no new engine op (design §6.4).
 */

import type { AssertionSpec } from "./assert.ts";
import { selectorNameGlobs } from "./assert.ts";

const PROBE_NEEDED_BY = new Set(["camera_sees", "state_machine", "frame_not_blank", "probe_report"]);

export function taskNeedsProbe(assertions: AssertionSpec[], snippet?: string): boolean {
  return assertions.some((a) => PROBE_NEEDED_BY.has(a.predicate)) || (typeof snippet === "string" && snippet.trim().length > 0);
}

function gdString(value: string): string {
  return JSON.stringify(value);
}

function gdStringArray(values: string[]): string {
  return `[${values.map(gdString).join(", ")}]`;
}

function indent(block: string, tabs: number): string {
  const pad = "\t".repeat(tabs);
  return block
    .split("\n")
    .map((line) => (line.trim().length === 0 ? "" : pad + line))
    .join("\n");
}

const HELPERS = `
func _eval_find_all(globs: Array) -> Array:
	var out: Array = []
	_eval_walk(get_tree().root, globs, out)
	return out

func _eval_walk(n: Node, globs: Array, out: Array) -> void:
	for g in globs:
		if String(n.name).match(String(g)):
			out.append(n)
			break
	for c in n.get_children():
		_eval_walk(c, globs, out)

func _eval_camera_sees(key: String, globs: Array) -> void:
	var cam := get_viewport().get_camera_3d()
	var nodes := _eval_find_all(globs)
	var per: Array = []
	var inside_total := 0
	var corners_total := 0
	for n in nodes:
		if not (n is VisualInstance3D):
			continue
		var aabb: AABB = n.get_aabb()
		var inside := 0
		for i in range(8):
			var corner: Vector3 = n.global_transform * aabb.get_endpoint(i)
			if cam != null and cam.is_position_in_frustum(corner):
				inside += 1
		per.append({"path": String(get_tree().root.get_path_to(n)), "inside": inside})
		inside_total += inside
		corners_total += 8
	var fraction := 0.0
	if corners_total > 0:
		fraction = float(inside_total) / float(corners_total)
	report(key, {"camera": cam != null, "matched": per.size(), "corners_inside": inside_total, "corners_total": corners_total, "fraction": snappedf(fraction, 0.001), "nodes": per})

func _eval_state_machine(key: String, globs: Array) -> void:
	var trees: Array = []
	for n in _eval_find_all(globs):
		if n is AnimationTree:
			trees.append(n)
	if trees.is_empty():
		report(key, {"found": false})
		return
	var t: AnimationTree = trees[0]
	var playback = t.get("parameters/playback")
	var state := ""
	if playback != null and playback.has_method("get_current_node"):
		state = String(playback.get_current_node())
	report(key, {"found": true, "trees": trees.size(), "active": t.active, "state": state})

func _eval_hold_action(action: String, hold_ms: int) -> void:
	var ev := InputEventAction.new()
	ev.action = action
	ev.pressed = true
	Input.parse_input_event(ev)
	await get_tree().create_timer(hold_ms / 1000.0).timeout

func _eval_release_action(action: String) -> void:
	var up := InputEventAction.new()
	up.action = action
	up.pressed = false
	Input.parse_input_event(up)
	await get_tree().process_frame

func _eval_distinct_colors() -> int:
	var tex := get_viewport().get_texture()
	if tex == null:
		return 0
	var img := tex.get_image()
	if img == null:
		return 0
	var colors := {}
	var step := maxi(1, mini(img.get_width(), img.get_height()) / 48)
	for y in range(0, img.get_height(), step):
		for x in range(0, img.get_width(), step):
			colors[img.get_pixel(x, y).to_html(false)] = true
	return colors.size()
`;

export interface ProbeBuildResult {
  source: string;
  /** Assertion ids whose reports this probe produces. */
  report_keys: string[];
  /** Upper bound on scene seconds the probe waits (for max_seconds sizing). */
  budget_seconds: number;
}

/** Build the probe. `snippet` is inserted verbatim inside _ready() (indented
 *  one tab) BEFORE the built-in checks unless it contains the marker line
 *  `# eval:after-builtins`. It may use report()/press()/save_frame(). */
export function buildProbe(assertions: AssertionSpec[], snippet?: string): ProbeBuildResult {
  const steps: string[] = [];
  const keys: string[] = [];
  let budget = 4;
  for (const a of assertions) {
    switch (a.predicate) {
      case "camera_sees": {
        const globs = selectorNameGlobs(String(a.args.selector ?? "*"));
        const at = typeof a.args.at_seconds === "number" ? a.args.at_seconds : 0;
        if (at > 0) {
          steps.push(`await get_tree().create_timer(${at.toFixed(2)}).timeout`, `await settle(1)`);
          budget += at + 1;
        }
        steps.push(`_eval_camera_sees(${gdString(a.id)}, ${gdStringArray(globs)})`);
        keys.push(a.id);
        break;
      }
      case "state_machine": {
        const globs = selectorNameGlobs(String(a.args.selector ?? "*"));
        const after = a.args.after as { press?: string; hold_ms?: number } | undefined;
        if (after && typeof after.press === "string") {
          const hold = typeof after.hold_ms === "number" ? Math.max(50, Math.round(after.hold_ms)) : 600;
          steps.push(
            `await _eval_hold_action(${gdString(after.press)}, ${hold})`,
            `_eval_state_machine(${gdString(a.id)}, ${gdStringArray(globs)})`,
            `await _eval_release_action(${gdString(after.press)})`,
            `await get_tree().create_timer(0.3).timeout`
          );
          budget += hold / 1000 + 0.5;
        } else {
          steps.push(`await settle_physics(2)`, `_eval_state_machine(${gdString(a.id)}, ${gdStringArray(globs)})`);
        }
        keys.push(a.id);
        break;
      }
      case "frame_not_blank": {
        const name = String(a.args.name ?? a.id);
        steps.push(`await settle(2)`, `save_frame(${gdString(name)})`, `report(${gdString(`_colors:${name}`)}, _eval_distinct_colors())`);
        keys.push(a.id);
        break;
      }
      default:
        break;
    }
  }
  const body: string[] = ["await super._ready()", "await settle(2)", "await settle_physics(2)"];
  const marker = "# eval:after-builtins";
  const custom = typeof snippet === "string" && snippet.trim().length > 0 ? snippet.replace(/\r\n/g, "\n").trimEnd() : "";
  if (custom && !custom.includes(marker)) body.push(indent(custom, 0));
  body.push(...steps);
  if (custom && custom.includes(marker)) body.push(indent(custom.replace(marker, "").trimEnd(), 0));
  body.push("finish()");
  if (custom) budget += 4;
  const source = `extends SummerProbeBase\n${HELPERS}\nfunc _ready() -> void:\n${indent(body.join("\n"), 1)}\n`;
  return { source, report_keys: keys, budget_seconds: Math.ceil(budget) };
}
