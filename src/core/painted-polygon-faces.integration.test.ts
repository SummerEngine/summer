import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const editor = process.env.SUMMER_EDITOR_BIN;

it.skipIf(!editor).each(["Jolt Physics", "GodotPhysics3D"])("lights both windings of a concave blockout and preserves its floor in %s", (physics) => {
  const project = mkdtempSync(join(tmpdir(), "painted-polygon-"));
  try {
    copyFileSync(new URL("../../library/skills/painted-25d-world/_building-blocks/blockout_builder.gd", import.meta.url), join(project, "blockout_builder.gd"));
    copyFileSync(new URL("../../tests/godot/painted-polygon-faces.gd", import.meta.url), join(project, "case.gd"));
    const lShape = [[0, 0], [3, 0], [3, 1], [1, 1], [1, 2], [0, 2]];
    const polygon = { kind: "poly", top: 1, depth: 2, color: "stone" };
    writeFileSync(join(project, "footprints.json"), JSON.stringify({ objects: [
      { ...polygon, name: "Quay", points: lShape, solid: true },
      { ...polygon, name: "Patio", points: lShape.toReversed(), solid: false },
    ] }));
    writeFileSync(join(project, "project.godot"), `config_version=5\n[physics]\n3d/physics_engine="${physics}"\n`);
    execFileSync(editor!, ["--headless", "--summer-no-api", "--summer-no-publish", "--path", project, "--script", "res://case.gd"], {
      env: { HOME: project, PATH: process.env.PATH, SUMMER_NO_TELEMETRY: "1" }, timeout: 15000,
    });
    const faces = { flat: true, outward: true, area: 4, walls: 12 };
    expect(JSON.parse(readFileSync(join(project, "result.json"), "utf8"))).toEqual({
      Quay: faces, Patio: faces, floor_from_above: true, floor_from_below: true, notch_open: true,
    });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
