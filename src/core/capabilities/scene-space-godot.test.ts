import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { buildPlacementScript } from "./placement-script.js";
import { buildSnapMeshScript } from "./surface-snap-mesh.js";
import { buildSceneTransformScript } from "./scene-space.js";

const engine = process.env.SUMMER_EDITOR_BIN;
if (!engine) console.warn("SKIP: native spatial inheritance regression needs SUMMER_EDITOR_BIN.");

it.skipIf(!engine)("matches native transforms and visibility across plain Node and top_level boundaries", () => {
  const project = mkdtempSync(join(tmpdir(), "summer-scene-space-"));
  try {
    writeFileSync(join(project, "project.godot"), 'config_version=5\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
    copyFileSync(fileURLToPath(new URL("../../../tests/godot/scene-space.gd", import.meta.url)), join(project, "regression.gd"));
    writeFileSync(join(project, "placement.gd"), buildPlacementScript({}));
    writeFileSync(join(project, "snap.gd"), buildSnapMeshScript({}));
    writeFileSync(join(project, "transform.gd"), buildSceneTransformScript("Parent/Top"));
    const child = spawnSync(engine!, ["--headless", "--summer-no-api", "--audio-driver", "Dummy", "--path", project, "--script", "res://regression.gd"], { encoding: "utf8", timeout: 10_000 });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stdout + child.stderr).toBe(0);
    expect(child.stderr).not.toMatch(/(?:SCRIPT )?ERROR:/);
    const result = JSON.parse(readFileSync(join(project, "result.json"), "utf8")) as { errors: string[]; observations: unknown[] };
    expect(result.errors).toEqual([]);
    expect(result.observations).toHaveLength(14);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
