---
name: 3d-lighting
description: "Light a 3D scene: sun, omni and spot lights, WorldEnvironment, sky, shadows and ambient."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: rendering-and-lighting
user-invocable: false
allowed-tools: Read Grep summer_add_node summer_set_prop summer_set_resource_property summer_save_scene summer_run_script summer_screenshot
paths: ["**/*.tscn", "**/*.tres"]
---

# 3D Lighting for Summer Engine

Outdoor and indoor lighting setups for 3D scenes.

## Light Types

| Type | Use case |
|------|----------|
| DirectionalLight3D | Sun, moon, outdoor primary light |
| OmniLight3D | Point lights (lamps, torches) |
| SpotLight3D | Flashlights, stage lights |

## Basic Outdoor Setup

### 1. Directional Light (Sun)

A light is one node plus a few properties: build it with one `summer_run_script`
call. Every scene tool takes a **required** `scenePath`, the exact `res://` scene
to change (get it from `summer_get_project_context`); the snippets use
`res://main.tscn`. One property change on an existing light is one
`summer_set_prop`.

```
summer_run_script(scenePath="res://main.tscn", source="""
func run(ctx):
    var world = ctx.get_or_create("Node3D", "World")
    ctx.add_node("DirectionalLight3D", "Sun", world, {
        "rotation_degrees": Vector3(-45, 30, 0),
        "light_energy": 1.0,
        "shadow_enabled": true,
        "light_color": Color(1, 0.95, 0.9, 1),
    })
    ctx.save_scene()
""")
```

Warm sunlight: `Color(1, 0.95, 0.9, 1)`. Cool moonlight: `Color(0.8, 0.85, 1, 1)`.

### 2. WorldEnvironment (Sky + Ambient)

The Environment resource has:
- `background_mode` — 2 for sky, 1 for color, 3 for canvas (`Environment.BG_SKY` = 2, `BG_COLOR` = 1, `BG_CANVAS` = 3; default is 0, `BG_CLEAR_COLOR`)
- `sky` — Sky resource (ProceduralSkyMaterial or PhysicalSkyMaterial)
- `ambient_light_source` — AMBIENT_SOURCE_SKY or AMBIENT_SOURCE_COLOR
- `ambient_light_color`
- `tonemap_mode`

A sky is a `Sky` resource in `environment.sky`, with a `ProceduralSkyMaterial` (or `PhysicalSkyMaterial`) in its `sky_material`. `summer_set_resource_property` only sets properties on a resource that already exists, so build the node, the Environment, the Sky and its material in one script:

```
summer_run_script(scenePath="res://main.tscn", source="""
func run(ctx):
    var env := Environment.new()
    env.background_mode = Environment.BG_SKY
    env.sky = Sky.new()
    env.sky.sky_material = ProceduralSkyMaterial.new()
    env.ambient_light_source = Environment.AMBIENT_SOURCE_SKY
    env.tonemap_mode = Environment.TONE_MAPPER_FILMIC
    ctx.add_node("WorldEnvironment", "WorldEnvironment", ctx.find("World"), {"environment": env})
    ctx.save_scene()
""")
```

Later, one value on that Environment is one `summer_set_resource_property` (`resourceProperty="environment"`, `subProperty="background_mode"`).

**Simpler path:** start from the `3d-basic` template, which already has a sky, and copy its structure.

### 3. Fill Light (Optional)

A second, weaker directional or omni for shadow fill:

```
summer_run_script(scenePath="res://main.tscn", source="""
func run(ctx):
    ctx.add_node("DirectionalLight3D", "FillLight", ctx.find("World"), {
        "rotation_degrees": Vector3(-30, -120, 0),
        "light_energy": 0.3,
        "shadow_enabled": false,
        "light_color": Color(0.7, 0.8, 1, 1),
    })
    ctx.save_scene()
""")
```

## Indoor / Point Lights

```
summer_run_script(scenePath="res://main.tscn", source="""
func run(ctx):
    ctx.add_node("OmniLight3D", "Lamp", ctx.find("World"), {
        "position": Vector3(2, 3, 2),
        "light_energy": 0.8,
        "light_color": Color(1, 0.9, 0.7, 1),
        "omni_range": 8.0,
    })
    ctx.save_scene()
""")
```

Many lamps (a street, a corridor) are a loop in the same script, not one call per lamp.

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
no renderer is available. If they want GI with zero bake step,
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

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@latest` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `summer_add_node` | `summer engine add-node` |
| `summer_get_project_context` | `summer engine get-project-context` |
| `summer_run_script` | `summer engine run-script` |
| `summer_save_scene` | `summer engine save-scene` |
| `summer_screenshot` | `summer engine screenshot` |
| `summer_set_prop` | `summer engine set-prop` |
| `summer_set_resource_property` | `summer engine set-resource-property` |
<!-- /shell-commands -->
