/** Actual shipped GDScript + both render routes, without a GPU/editor window.
 * Opt in: SUMMER_EDITOR_BIN=/path/to/Summer npx vitest run <this file>.
 * The render response uses fixture pixels; this checks scene-load failure,
 * not rendering. A missing target retains a Subject node, as the editor's
 * MissingNode fallback does (verified separately against a real editor).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OK_JPEG } from "../../../test-helpers/seeing-engine.js";
import { debugViews, shotSheet, type SeeingClient } from "./seeing.js";

const binary = process.env.SUMMER_EDITOR_BIN;

describe.runIf(Boolean(binary))("seeing target load — real headless GDScript", () => {
  let project: string;
  beforeAll(() => {
    project = mkdtempSync(join(tmpdir(), "seeing-subject-test-"));
    writeFileSync(join(project, "project.godot"), 'config_version=5\n[application]\nconfig/name="Seeing subject regression"\n');
    writeFileSync(join(project, "valid.tscn"), '[gd_scene format=3]\n[node name="ValidEmptyScene" type="Node3D"]\n');
    writeFileSync(join(project, "run.gd"), `extends SceneTree
func _initialize():
	call_deferred("check")
func check():
	var wrapper = load(OS.get_cmdline_user_args()[0]).instantiate()
	root.add_child(wrapper)
	await process_frame
	quit()
`);
  });
  afterAll(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  function engine(): SeeingClient {
    return {
      getProjectRoot: () => project,
      getSceneState: async () => ({ provenance: { scenePath: "res://valid.tscn" } }),
      async executeOps(ops) {
        const op = ops[0]!;
        expect(op.op).toBe("ScenePreview");
        const path = String(op.scene_path);
        let wrapper = readFileSync(path, "utf8");
        // Runtime loading normally aborts on a missing instance; the editor
        // instead preserves a MissingNode. Keep that non-null Subject here so
        // the production kernel, rather than the scene parser, handles it.
        if (wrapper.includes('path="res://Missing.tscn"')) {
          wrapper = wrapper
            .replace(/^\[ext_resource[^\n]+\]\n/m, "")
            .replace('[node name="Subject" parent="." instance=ExtResource("1_subject")]', '[node name="Subject" type="Node3D" parent="."]');
          writeFileSync(path, wrapper);
        }
        execFileSync(binary!, ["--headless", "--path", project, "--audio-driver", "Dummy", "--script", "res://run.gd", "--", path], {
          timeout: 15_000,
          env: { ...process.env, HOME: project, SUMMER_NO_TELEMETRY: "1", DO_NOT_TRACK: "1", SUMMER_AUTO_LAUNCH: "0" },
          stdio: "pipe",
        });
        return { results: [{ ok: true, image_base64: OK_JPEG.toString("base64"), width: 64, height: 64, mime: "image/jpeg" }] };
      },
    };
  }

  const pose = { camera_position: "Vector3(0, 1, 7)", camera_look_at: "Vector3(0, 0, 0)" };
  for (const route of ["debug_views", "shot_sheet"] as const) {
    for (const missing of [true, false]) {
      it(`${route}: ${missing ? "rejects a missing target with a surviving Subject" : "accepts a valid empty scene"}`, async () => {
        const scenePath = missing ? "res://Missing.tscn" : "res://valid.tscn";
        expect(existsSync(join(project, "Missing.tscn"))).toBe(false);
        const client = engine();
        const result = route === "debug_views"
          ? await debugViews(client, { scenePath, ...pose, views: ["beauty"], max_size: 64 })
          : await shotSheet(client, { scenePath, shots: [pose], max_size: 64 });
        if (missing) {
          expect(result).toMatchObject({ ok: false, failure_reason: "scene_load_failed" });
          expect(result).not.toHaveProperty("image");
          expect(JSON.stringify(result)).toContain("res://Missing.tscn");
        } else {
          expect(result.ok).toBe(true);
        }
      }, 20_000);
    }
  }
});
