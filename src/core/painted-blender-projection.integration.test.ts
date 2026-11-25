import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const blender = process.env.SUMMER_BLENDER_BIN;

it.runIf(Boolean(blender))("bakes a linked prop at each object's own position in the painting", () => {
  const guide = readFileSync(new URL("../../library/skills/painted-25d-world/_building-blocks/blender-route.md", import.meta.url), "utf8");
  const snippet = guide.match(/^`{3}python\n([\s\S]*?)^`{3}/m)?.[1];
  expect(snippet).toBeTruthy();
  const work = mkdtempSync(join(tmpdir(), "painted-blender-projection-"));
  try {
    writeFileSync(join(work, "bake.py"), snippet!);
    writeFileSync(join(work, "measure.py"), `import bpy, json, runpy
from pathlib import Path
from bpy_extras.object_utils import world_to_camera_view

scene = bpy.context.scene
camera = bpy.data.objects.new("PaintCamera", bpy.data.cameras.new("Test"))
camera.data.type = "ORTHO"
camera.data.ortho_scale = 12
camera.location.z = 10
scene.collection.objects.link(camera)
blockout = bpy.data.collections.new("blockout")
scene.collection.children.link(blockout)
shared = bpy.data.meshes.new("Panel")
shared.from_pydata([(0,0,0), (1,0,0), (0,1,0)], [], [(0,1,2)])
outside = bpy.data.objects.new("Outside", shared)
scene.collection.objects.link(outside)
for name, x in [("Left", -3), ("Right", 3)]:
    obj = bpy.data.objects.new(name, shared)
    blockout.objects.link(obj)
    obj.location.x = x
bpy.context.view_layer.update()
runpy.run_path("bake.py")
errors = []
for obj in blockout.objects:
    for loop in obj.data.loops:
        point = obj.matrix_world @ obj.data.vertices[loop.vertex_index].co
        projection = world_to_camera_view(scene, camera, point)
        uv = obj.data.uv_layers.active.data[loop.index].uv
        errors.append((uv - projection.xy).length)
Path("measurements.json").write_text(json.dumps([errors, len(outside.data.uv_layers)]))
`);
    execFileSync(blender!, ["--background", "--factory-startup", "--threads", "1", "--python-exit-code", "1", "--python", "measure.py"], {cwd: work, timeout: 30000});
    const [errors, outsideLayers]: [number[], number] = JSON.parse(readFileSync(join(work, "measurements.json"), "utf8"));
    expect(errors).toHaveLength(6);
    expect(Math.max(...errors)).toBeLessThan(0.000001);
    expect(outsideLayers).toBe(0);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 35000);
