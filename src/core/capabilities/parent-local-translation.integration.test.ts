import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildSceneTransformScript, PARENT_TRANSLATION_GDSCRIPT, SCENE_SPACE_GDSCRIPT } from "./scene-space.js";

const binary = process.env.SUMMER_EDITOR_BIN;

it.runIf(Boolean(binary))("reconstructs representable world movements at Godot precision and refuses lossy writes", () => {
  const project = mkdtempSync(join(tmpdir(), "parent-local-translation-"));
  try {
    const fixture = readFileSync(new URL("../../../tests/godot/parent-local-translation.gd", import.meta.url), "utf8");
    writeFileSync(join(project, "check.gd"), fixture.replace("# SCENE_SPACE_HELPERS", () => SCENE_SPACE_GDSCRIPT + PARENT_TRANSLATION_GDSCRIPT));
    writeFileSync(join(project, "long-read.gd"), buildSceneTransformScript("Piece", false, [10001.0043, 0, 0]));
    writeFileSync(join(project, "far-read.gd"), buildSceneTransformScript("Piece", false, [4097.0252, 0, 0]));
    writeFileSync(join(project, "project.godot"), "config_version=5\n");
    execFileSync(binary!, ["--headless", "--path", project, "--audio-driver", "Dummy", "--script", "res://check.gd"], {
      env: { ...process.env, HOME: project, SUMMER_NO_TELEMETRY: "1", DO_NOT_TRACK: "1" }, timeout: 15_000,
    });
    expect(JSON.parse(readFileSync(join(project, "result.json"), "utf8"))).toEqual({ count: 36, errors: [] });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
