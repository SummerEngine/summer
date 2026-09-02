---
name: 3d-lighting
description: Use when setting up lighting in a Summer Engine 3D scene — adding lights, configuring WorldEnvironment, sky, or shadows. Covers DirectionalLight3D versus Omni versus Spot, shadow tuning, ambient and sky-driven lighting, and the current Summer rendering conventions. Trigger on "lighting", "shadows", "WorldEnvironment", "sun", "ambient", "sky", "light".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: rendering-and-lighting
user-invocable: false
allowed-tools: Read Grep summer_add_node summer_set_prop summer_set_resource_property summer_save_scene summer_run_script summer_screenshot
paths: ["**/*.tscn", "**/*.tres"]
---

# 3D Lighting for Summer Engine

Set up lighting and environment for 3D scenes. Follow these patterns for outdoor and indoor setups.

## Light Types

| Type | Use case |
|------|----------|
| DirectionalLight3D | Sun, moon, outdoor primary light |
| OmniLight3D | Point lights (lamps, torches) |
| SpotLight3D | Flashlights, stage lights |

## Basic Outdoor Setup

### 1. Directional Light (Sun)

Every tool below also takes a **required** `scenePath` (the exact `res://` scene
to mutate — get it from `summer_get_project_context`). It is elided in these
snippets for readability; a real call without it is rejected by the tool schema.

```
summer_add_node(scenePath="res://main.tscn", parent="./World", type="DirectionalLight3D", name="Sun")
summer_set_prop(scenePath="res://main.tscn", path="./World/Sun", key="rotation_degrees", value="Vector3(-45, 30, 0)")
summer_set_prop(path="./World/Sun", key="light_energy", value="1.0")
summer_set_prop(path="./World/Sun", key="shadow_enabled", value="true")
summer_set_prop(path="./World/Sun", key="light_color", value="Color(1, 0.95, 0.9, 1)")
```

Warm sunlight: `Color(1, 0.95, 0.9, 1)`. Cool moonlight: `Color(0.8, 0.85, 1, 1)`.

### 2. WorldEnvironment (Sky + Ambient)

```
summer_add_node(parent="./World", type="WorldEnvironment", name="WorldEnvironment")
summer_set_prop(path="./World/WorldEnvironment", key="environment", value="Environment")
```

Then configure the Environment's sub-properties. The Environment resource has:
- `background_mode` — 2 for sky, 1 for color, 3 for canvas (`Environment.BG_SKY` = 2, `BG_COLOR` = 1, `BG_CANVAS` = 3; default is 0, `BG_CLEAR_COLOR`)
- `sky` — Sky resource (ProceduralSkyMaterial or PhysicalSkyMaterial)
- `ambient_light_source` — AMBIENT_SOURCE_SKY or AMBIENT_SOURCE_COLOR
- `ambient_light_color`
- `tonemap_mode`

For a simple procedural sky:

```
summer_set_resource_property(nodePath="./World/WorldEnvironment", resourceProperty="environment", subProperty="background_mode", value="2")
```

You may need to create a Sky resource and assign it. In the editor this is done via the inspector; via MCP, SetResourceProperty on nested resources may require the resource to exist first. If `environment` is "Environment", the engine creates a default. For `sky`, you might set `sky` to "ProceduralSkyMaterial" or similar—check Godot docs for the exact property chain.

**Simpler path:** Use the 3d-basic template which already has a sky. Copy that structure.

### 3. Fill Light (Optional)

A second, weaker directional or omni for shadow fill:

```
summer_add_node(parent="./World", type="DirectionalLight3D", name="FillLight")
summer_set_prop(path="./World/FillLight", key="rotation_degrees", value="Vector3(-30, -120, 0)")
summer_set_prop(path="./World/FillLight", key="light_energy", value="0.3")
summer_set_prop(path="./World/FillLight", key="shadow_enabled", value="false")
summer_set_prop(path="./World/FillLight", key="light_color", value="Color(0.7, 0.8, 1, 1)")
```

## Indoor / Point Lights

```
summer_add_node(parent="./World", type="OmniLight3D", name="Lamp")
summer_set_prop(path="./World/Lamp", key="position", value="Vector3(2, 3, 2)")
summer_set_prop(path="./World/Lamp", key="light_energy", value="0.8")
summer_set_prop(path="./World/Lamp", key="light_color", value="Color(1, 0.9, 0.7, 1)")
summer_set_prop(path="./World/Lamp", key="omni_range", value="8")
```

## Property Reference

| Property | Type | Example |
|----------|------|---------|
| light_energy | float | `1.0`, `1.5` |
| light_color | Color | `"Color(1, 0.95, 0.9, 1)"` |
| shadow_enabled | bool | `true` |
| rotation_degrees | Vector3 | `"Vector3(-45, 30, 0)"` |
| position | Vector3 | `"Vector3(0, 10, 0)"` |
| omni_range | float | `10` (OmniLight3D) |
| spot_range | float | `10` (SpotLight3D) |
| spot_angle | float | `45` (degrees, SpotLight3D) |

## Color Format

Always use `Color(r, g, b, a)` with values 0.0–1.0:

- Warm white: `Color(1, 0.95, 0.9, 1)`
- Cool white: `Color(0.9, 0.95, 1, 1)`
- Orange (torch): `Color(1, 0.6, 0.2, 1)`
- Green (alien): `Color(0.5, 1, 0.5, 1)`

## Baked lighting — what you can and cannot do from here

Real-time lighting (everything above) is fully scriptable. Baking mostly is too on
this build — the split that matters is *which process* runs the bake, not whether a
script can trigger it.

| Approach | Callable from MCP / a script? |
|---|---|
| DirectionalLight3D / Omni / Spot with `shadow_enabled` | Yes |
| `WorldEnvironment` + `Environment` (sky, ambient, tonemap, glow, SSAO, SSR) | Yes |
| `SDFGI` real-time GI | Yes — `Environment.sdfgi_enabled = true`, no bake step at all |
| `VoxelGI` | Yes — `VoxelGI.bake()` **is** bound to script (`ClassDB.class_has_method("VoxelGI", "bake")` is true) |
| **`LightmapGI` bake** | **Yes, from the live editor.** Summer binds `LightmapGI.bake(from_node, image_data_path)` to script (upstream leaves it button-only). Call it from `summer_run_script`. The GPU lightmapper needs a real renderer (a RenderingDevice): a normal desktop editor has one; a cloud container needs xvfb + GL (`running-in-the-cloud`); a **pure-headless** process has none and the call returns `BAKE_ERROR_NO_LIGHTMAPPER`. |
| **`OccluderInstance3D` occlusion bake** | **No.** `bake_single_node` is not script-callable. Editor-button only. |

So when the user asks for baked lighting: add and configure the `LightmapGI` node,
set the meshes' `gi_mode`, then run the bake yourself from `summer_run_script` —
`lgi.bake(lgi, "res://lightmaps/scene_lm.exr")` — and check the returned bake-error
enum (0 is OK; `BAKE_ERROR_NO_LIGHTMAPPER` means no renderer in this process, not a
missing binding). Verify with a `framing:"camera"` screenshot, which renders the
real environment. Only fall back to "press Bake Lightmaps in the editor" when
there is genuinely no renderer available. If they want GI with zero bake step,
steer to `SDFGI` (`Environment.sdfgi_enabled`) or `VoxelGI`.

Note the related trap: `Engine.has_singleton("EditorInterface")` returns **true**
even in a headless non-editor process, so it is not a valid capability probe.
`ClassDB.can_instantiate("EditorScript")` returns false outside the editor and is
the reliable check.

## Fallback (no MCP — edit `.tscn` directly)

If Summer MCP isn't connected, append the lighting block to your scene file:

```
[node name="Sun" type="DirectionalLight3D" parent="World"]
transform = Transform3D(0.866, 0, -0.5, 0.354, 0.707, 0.612, 0.354, -0.707, 0.612, 0, 0, 0)
light_color = Color(1, 0.95, 0.9, 1)
light_energy = 1.0
shadow_enabled = true

[node name="WorldEnvironment" type="WorldEnvironment" parent="World"]
```

Then create `Environment` and `Sky` resources via the inspector or load from `.tres`.

## Collaborative protocol

This skill mutates the scene (adds lights + WorldEnvironment + tunes Environment sub-properties). Always ask before applying: "May I add a DirectionalLight3D Sun with shadows + a WorldEnvironment with a procedural sky?".
