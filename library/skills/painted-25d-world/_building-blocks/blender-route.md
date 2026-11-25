# Blender route: bake the projection into UVs

Use this only when the host has Blender and the level must ship as plain textured meshes (no projection shader).
It gives the same picture as `paint_projection.gdshader`.

1. Build the blockout in Blender with the same orthographic camera: rotation (60, 0, 45) degrees in Blender's
   Z-up axes (90 - 30 down, 45 around), `ortho_scale` = frame width in metres. Render it (Workbench, studio light,
   outlines on) at 2048x1152 or larger.
2. Paint over the render (SKILL.md step 4) and resize the painting to the exact render size.
3. Save a separate `.blend` export copy. If the render uses static geometry modifiers such as Array, Mirror or Simple Deform, apply those modifiers **in the export copy before projecting the UVs**. Use Object Mode and the modifier menu’s Apply command, or fill in `static_modifiers` below with the object names and the exact modifier names in stack order. Already-applied meshes need no entries. Keep the original file for editing.
4. For each mesh in the `blockout` collection and its child collections, project its final vertices from the paint camera.

```python
import bpy
from bpy_extras.object_utils import world_to_camera_view

scene, cam = bpy.context.scene, bpy.data.objects["PaintCamera"]
blockout = bpy.data.collections["blockout"]
static_modifiers = {}  # Example: {"Fence": ["Array"], "Arch": ["Mirror"]}
for object_name, names in static_modifiers.items():
    ob = blockout.all_objects[object_name]
    with bpy.context.temp_override(object=ob, active_object=ob):
        for name in names:
            if bpy.ops.object.modifier_apply(modifier=name, single_user=True) != {"FINISHED"}:
                raise RuntimeError(f"Could not apply {object_name}: {name}")

for ob in blockout.all_objects:
    if ob.type != "MESH":
        continue
    # A linked duplicate has its own world position but shares mesh UVs.
    if ob.data.users > 1:
        ob.data = ob.data.copy()
    me = ob.data
    uv = me.uv_layers.new(name="proj")
    uv.active = uv.active_render = True
    for loop in me.loops:
        p = world_to_camera_view(scene, cam, ob.matrix_world @ me.vertices[loop.vertex_index].co)
        uv.data[loop.index].uv = (p.x, p.y)
```

   With an orthographic camera the UVs are exact per vertex, so no subdivision is needed.
5. One material for all meshes: the painting as base colour (texture extension EXTEND). Export glTF with separate
   textures. Leave glTF’s Apply Modifiers off. Applying a modifier during export copies or deforms the geometry after its UVs were projected. Name solid objects `<name>-col` so the engine adds collision on import.
6. In the engine, override every imported mesh with an unshaded `StandardMaterial3D` that uses the painting, and
   import the painting lossless. Blender (x, y, z) is engine (x, z, -y): rebuild the paint camera from the same
   30 / 45 degree direction with `keep_aspect` KEEP_WIDTH and `size` = the ortho scale.
