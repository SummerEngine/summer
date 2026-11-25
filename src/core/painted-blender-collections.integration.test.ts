import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const blender = process.env.SUMMER_BLENDER_BIN;

it.runIf(Boolean(blender))("projects every mesh in the blockout collection tree", () => {
  const guide = readFileSync(new URL("../../library/skills/painted-25d-world/_building-blocks/blender-route.md", import.meta.url), "utf8");
  const snippet = guide.match(/^`{3}python\n([\s\S]*?)^`{3}/m)?.[1];
  expect(snippet).toBeTruthy();
  const project = mkdtempSync(join(tmpdir(), "blender-collection-bake-"));
  try {
    writeFileSync(join(project, "bake.py"), snippet!);
    writeFileSync(join(project, "fixture.py"), `import bpy, json, runpy
from pathlib import Path
from bpy_extras.object_utils import world_to_camera_view

scene = bpy.context.scene
camera = bpy.data.objects.new("PaintCamera", bpy.data.cameras.new("Test"))
camera.data.type = "ORTHO"
camera.data.ortho_scale = 12
camera.location.z = 10
scene.collection.objects.link(camera)

def collection(parent, name):
    result = bpy.data.collections.new(name)
    parent.children.link(result)
    return result

root = collection(scene.collection, "blockout")
child = collection(root, "Furniture")
grandchild = collection(child, "Workbench")
outside = collection(scene.collection, "Other")
props = []
for index, owner in enumerate([root, child, grandchild, outside]):
    mesh = bpy.data.meshes.new(owner.name)
    mesh.from_pydata([(0,0,0), (1,0,0), (0,1,0)], [], [(0,1,2)])
    prop = bpy.data.objects.new(owner.name, mesh)
    owner.objects.link(prop)
    prop.location.x = 2 * index - 3
    props.append(prop)
bpy.context.view_layer.update()
runpy.run_path("bake.py")
errors = []
for prop in props[:3]:
    uv = prop.data.uv_layers.get("proj")
    for loop in prop.data.loops:
        world = prop.matrix_world @ prop.data.vertices[loop.vertex_index].co
        expected = world_to_camera_view(scene, camera, world).xy
        errors.append((uv.data[loop.index].uv - expected).length if uv else None)
Path("result.json").write_text(json.dumps([errors, len(props[3].data.uv_layers)]))
`);
    execFileSync(blender!, ["--background", "--factory-startup", "--threads", "1", "--python-exit-code", "1", "--python", "fixture.py"], { cwd: project, timeout: 30000 });
    const [errors, outsideLayerCount]: [(number | null)[], number] = JSON.parse(readFileSync(join(project, "result.json"), "utf8"));
    expect(errors).toHaveLength(9);
    for (const error of errors) expect(error).toBeLessThan(0.000001);
    expect(outsideLayerCount).toBe(0);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 35000);
