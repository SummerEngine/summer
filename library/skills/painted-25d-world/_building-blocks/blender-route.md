# Blender route: bake the projection into UVs

Use this only when the host has Blender and the level must ship as plain textured meshes (no projection shader).
It gives the same picture as `paint_projection.gdshader`.

1. Build the blockout in Blender with the same orthographic camera: rotation (60, 0, 45) degrees in Blender's
   Z-up axes (90 - 30 down, 45 around), `ortho_scale` = frame width in metres. Render it (Workbench, studio light,
   outlines on) at 2048x1152 or larger.
2. Paint over the render (SKILL.md step 4) and resize the painting to the exact render size.
3. Project: for every mesh, add one UV layer and set each loop's UV to the camera-view position of its vertex.

```python
import bpy
from bpy_extras.object_utils import world_to_camera_view

scene, cam = bpy.context.scene, bpy.data.objects["PaintCamera"]
for ob in bpy.data.collections["blockout"].objects:
    if ob.type != "MESH":
        continue
    me = ob.data
    uv = me.uv_layers.new(name="proj")
    uv.active = uv.active_render = True
    for loop in me.loops:
        p = world_to_camera_view(scene, cam, ob.matrix_world @ me.vertices[loop.vertex_index].co)
        uv.data[loop.index].uv = (p.x, p.y)
```

   With an orthographic camera the UVs are exact per vertex, so no subdivision is needed.
4. One material for all meshes: the painting as base colour (texture extension EXTEND). Export glTF with separate
   textures. Name solid objects `<name>-col` so the engine adds collision on import.
5. In the engine, override every imported mesh with an unshaded `StandardMaterial3D` that uses the painting, and
   import the painting lossless. Blender (x, y, z) is engine (x, z, -y): rebuild the paint camera from the same
   30 / 45 degree direction with `keep_aspect` KEEP_WIDTH and `size` = the ortho scale.
