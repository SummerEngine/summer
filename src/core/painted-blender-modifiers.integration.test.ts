import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const blender = process.env.SUMMER_BLENDER_BIN;

it.runIf(Boolean(blender))("projects array copies before default glTF export and keeps unrelated modifiers and linked meshes", () => {
  const guide = readFileSync(new URL("../../library/skills/painted-25d-world/_building-blocks/blender-route.md", import.meta.url), "utf8");
  const snippet = guide.match(/^`{3}python\n([\s\S]*?)^`{3}/m)![1];
  const work = mkdtempSync(join(tmpdir(), "blender-static-projection-"));
  try {
    writeFileSync(join(work, "bake.py"), snippet.replace("static_modifiers = {}", 'static_modifiers = {"Fence": ["Array"]}'));
    writeFileSync(join(work, "measure.py"), `import bpy, json, runpy
from bpy_extras.object_utils import world_to_camera_view
from pathlib import Path

scene = bpy.context.scene
cam = bpy.data.objects.new("PaintCamera", bpy.data.cameras.new("Camera"))
cam.data.type = "ORTHO"
cam.data.ortho_scale = 12
cam.location.z = 10
scene.collection.objects.link(cam)
blockout = bpy.data.collections.new("blockout")
scene.collection.children.link(blockout)
mesh = bpy.data.meshes.new("Panel")
mesh.from_pydata([(-2,-1,0),(-1,-1,0),(-1,1,0),(-2,1,0)], [], [(0,1,2,3)])
outside = bpy.data.objects.new("Outside", mesh)
scene.collection.objects.link(outside)
fence = bpy.data.objects.new("Fence", mesh)
blockout.objects.link(fence)
array = fence.modifiers.new("Array", "ARRAY")
array.count = 2
array.use_relative_offset = False
array.use_constant_offset = True
array.constant_offset_displace.x = 4
fence.modifiers.new("Keep", "TRIANGULATE")
bpy.context.view_layer.update()
runpy.run_path("bake.py")
errors = []
for loop in fence.data.loops:
    pos = fence.matrix_world @ fence.data.vertices[loop.vertex_index].co
    expected = world_to_camera_view(scene, cam, pos).xy
    errors.append((fence.data.uv_layers.active.data[loop.index].uv - expected).length)
bpy.ops.object.select_all(action="DESELECT")
fence.select_set(True)
bpy.ops.export_scene.gltf(filepath=str(Path("fence.gltf").resolve()), export_format="GLTF_SEPARATE", use_selection=True)
Path("measure.json").write_text(json.dumps([errors, [m.name for m in fence.modifiers], len(outside.data.vertices), len(outside.data.uv_layers)]))
`);
    execFileSync(blender!, ["--background", "--factory-startup", "--threads", "1", "--python-exit-code", "1", "--python", "measure.py"], { cwd: work, timeout: 30000 });
    const [errors, retained, outsideVertices, outsideLayers] = JSON.parse(readFileSync(join(work, "measure.json"), "utf8"));
    expect(errors).toHaveLength(8);
    expect(Math.max(...errors)).toBeLessThan(0.000001);
    expect(retained).toEqual(["Keep"]);
    expect([outsideVertices, outsideLayers]).toEqual([4, 0]);
    const gltf = JSON.parse(readFileSync(join(work, "fence.gltf"), "utf8"));
    const attributes = gltf.meshes[0].primitives[0].attributes;
    expect(gltf.accessors[attributes.POSITION].count).toBe(8);
    expect(gltf.accessors[attributes.TEXCOORD_0].count).toBe(8);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 35000);
