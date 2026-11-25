import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const binary = process.env.SUMMER_BIN ?? process.env.SUMMER_EDITOR_BIN;

it.skipIf(!binary).each(["centered", "offset"])("projects and frames the %s paint camera as the window resizes", (frame) => {
  const project = mkdtempSync(join(tmpdir(), "summer-painted-camera-"));
  try {
    const source = new URL("../../library/skills/painted-25d-world/_building-blocks/", import.meta.url);
    const painted = join(project, "painted");
    mkdirSync(painted);
    for (const file of ["painted_world.gd", "painted_location.gd", "paint_projection.gdshader"]) {
      copyFileSync(new URL(file, source), join(painted, file));
    }
    copyFileSync(new URL("../../tests/godot/painted-world-camera.gd", import.meta.url), join(project, "case.gd"));
    writeFileSync(join(project, "project.godot"), "config_version=5\n");
    const output = execFileSync(binary!, [
      "--headless", "--path", project, "--summer-no-api", "--summer-no-publish", "--script", "res://case.gd", ...(frame === "offset" ? ["--", "--paint-offset"] : []),
    ], { env: { HOME: project, PATH: process.env.PATH, SUMMER_NO_TELEMETRY: "1" }, encoding: "utf8", timeout: 15000 });
    expect(output).toContain("PAINTED_CAMERA_OK");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
