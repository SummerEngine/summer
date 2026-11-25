import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const binary = process.env.SUMMER_EDITOR_BIN;

it.runIf(Boolean(binary))("keeps named props visible and hides the painted door and step slabs", () => {
  const project = mkdtempSync(join(tmpdir(), "painted-prop-names-"));
  try {
    const painted = join(project, "painted");
    mkdirSync(painted);
    for (const file of ["painted_location.gd", "blockout_builder.gd", "paint_projection.gdshader"]) {
      copyFileSync(new URL("../../library/skills/painted-25d-world/_building-blocks/" + file, import.meta.url), join(painted, file));
    }
    copyFileSync(new URL("../../tests/godot/painted-prop-names.gd", import.meta.url), join(project, "case.gd"));
    const visible = ["Bench", "OutdoorTable", "IndoorLamp", "FootstepsSign"];
    const hidden = ["Entry_door", "Cottage_STEPS", "FrontDoor", "Steps"];
    const objects = [...visible, ...hidden].map((name, index) => ({
      kind: "box", name, color: "wood", size: [1, 1.4, 0.8], pos: [2 * index - 7, 0, 0], solid: index % 2 === 1,
    }));
    writeFileSync(join(project, "props.json"), JSON.stringify({ objects }));
    writeFileSync(join(project, "project.godot"), "config_version=5\n");
    execFileSync(binary!, ["--headless", "--summer-no-api", "--summer-no-publish", "--path", project, "--script", "res://case.gd"], {
      env: { HOME: project, PATH: process.env.PATH, SUMMER_NO_TELEMETRY: "1" }, timeout: 15000,
    });
    const rows = JSON.parse(readFileSync(join(project, "result.json"), "utf8"));
    for (const name of [...visible, ...hidden]) {
      expect(rows[name], name).toMatchObject({ visible: visible.includes(name), painted: visible.includes(name) });
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
