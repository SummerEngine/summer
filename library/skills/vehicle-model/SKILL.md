---
name: vehicle-model
description: Use when generating a hard-surface vehicle — car, motorcycle, spaceship, hover bike, boat, mech, tank, helicopter. Static mesh, optional secondary detail-texture pass, wired as Vehicle3D (player-driven) or MeshInstance3D (background). Trigger on "make a car", "spaceship model", "generate a mech", "I need a vehicle", "hover bike", "tank model", "racing car".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: 3d-assets
user-invocable: true
allowed-tools: Read Grep summer_search_assets summer_list_my_assets summer_get_asset summer_import_asset_by_id summer_generate_3d summer_generate_image summer_import_from_url summer_add_node summer_set_prop summer_inspect_node summer_inspect_resource summer_get_scene_tree summer_save_scene
paths: ["assets/vehicles/**", "assets/models/**", "**/*.tscn", "**/*.gd"]
---

# Vehicle Model — Hard-Surface 3D Generation

Vehicles are the hardest 3D-gen category. Hard surfaces (flat panels, sharp edges, symmetrical bodies) expose every flaw the AI mesher has — smoothing-group artifacts on flat panels, asymmetric headlights, melted door seams. This skill exists to push the success rate up by giving the model **multi-angle reference**, picking the right backend, and using a **secondary detail-texture pass** to recover crispness on the body panels.

Backing tool: `summer_generate_3d`. Default model is `hunyuan` (best general quality). For pure hard-surface (clean spaceship, F1 car), try `trellis` first — it tends to preserve panel edges better.

## When to use

- "Make me a player car for a racing game."
- "Generate a sci-fi fighter spaceship."
- "I need a hover bike for the desert level."
- "Create a mech for the boss fight."
- "Background traffic — generate three civilian sedans."

## When NOT to use

- Character driving the vehicle → that's `character-model`. Generate them separately and parent the character to the vehicle's seat.
- Vehicle interior (cockpit, dashboard) as a first-person view → generate as a separate "interior" prop via `prop-model` with first-person framing.
- A scenery vehicle that never moves and is far from camera (parked truck in the distance) → `prop-model` is fine; vehicle-model's overhead isn't worth it.
- Procedural / customizable vehicles (modular ship parts) → use `environment-kit` to generate a vehicle-parts kit instead.

## Polycount targets

| Use case | Tris | Pass via |
|---|---|---|
| Player vehicle (close camera, lots of screen time) | 15k–30k | `target_polycount: 25000` |
| Hero showpiece (cinematic, garage view) | 30k–60k | `target_polycount: 50000` |
| Background traffic (mid-range, multiple onscreen) | 2k–5k | `target_polycount: 4000` |
| Distant flyby / parked scenery | 1k–2k | `target_polycount: 1500` |

Vehicles benefit more from polycount than props — flat panels need edge density to look right. Don't go below 2k for anything the camera will get close to.

## Multi-angle reference — the single biggest quality lever

Vehicles are highly view-dependent. A front-only reference produces a mesh with great front detail and a melted rear. There are two ways to give the mesher more than one angle, and they are not the same thing:

**(a) A real multi-image request — prefer this.** `summer_generate_3d` takes an `imageUrls` array of up to four views. These are passed through as separate views, not fused into one picture.

```
summer_generate_3d(
  kind="image-to-3d",
  imageUrls=["<front url>", "<3/4 rear-side url>", "<profile url>"],
  model="hunyuan",
  options={ target_polycount: 25000 }
)
```

**(b) A composite reference image**, when you only have one slot to work with:

```
summer_generate_image(
  prompt="A sleek red sports car, front view AND 3/4 rear-side view side by side, two angles in one image, white background, studio lighting, clean references for 3D modeling, isolated, no scenery."
)

summer_generate_3d(
  kind="image-to-3d",
  imageUrl="<composite reference url>",
  model="hunyuan",
  options={ target_polycount: 25000 }
)
```

If the user has reference images already (concept art, photos), pass them straight to `imageUrls` — do not composite them down into one image first; that throws away the multi-view path.

## Steps

### 1. Search before generating

```
summer_search_assets(query="<vehicle type>", assetType="3d_model", source="all")
```

### 2. Pick model and polycount

For hard-edged vehicles (spaceships, F1, mechs), try `trellis` first — sharper panel edges. For organic-curved vehicles (muscle cars, motorcycles, classic boats), `hunyuan` handles the curves better.

### 3. Build the prompt

Pattern: `<vehicle type> + <silhouette / era / style> + <materials> + <surface state> + isolated suffix`.

| Goal | Prompt that works |
|---|---|
| Player race car | `A sleek modern Formula 1 race car, aerodynamic carbon-fiber bodywork, large rear wing, exposed wheels, racing livery in red and white. Front and 3/4 side views. Game asset, stylized, clean white background, isolated vehicle.` |
| Sci-fi fighter | `A sleek single-seat sci-fi space fighter, swept-forward wings, twin engine nacelles, glass cockpit canopy, painted matte gray with cyan trim. Front and 3/4 side views. Game asset, stylized hard-surface, white background, isolated vehicle.` |
| Hover bike | `A rusted desert hover bike, exposed engine block, single seat, handlebars, no wheels (hover thrusters underneath), weathered orange paint. Front and 3/4 side views. Game asset, stylized, white background, isolated vehicle.` |
| Mech | `A 4 meter tall bipedal combat mech, blocky armored torso, articulated arms with rifle and missile pod, thick legs with hydraulic pistons, painted olive drab with hazard stripes. Front and 3/4 side views. Game asset, hard-surface stylized, white background, isolated vehicle.` |
| Background sedan | `A generic 90s civilian sedan, four doors, beige paint, slightly worn. Front and 3/4 side views. Game asset, low-detail stylized, white background, isolated vehicle.` |

Nothing in the prompt text "triggers" multi-view. The phrase `front and 3/4 side views` only shapes what the *image* model draws; the 3D tool has no prompt-sniffing and sees whatever pixels you hand it. Multi-view comes from the `imageUrls` array, nothing else.

### 4. Confirm and call

> About to generate `red_race_car` via `hunyuan`, target ~25k tris, multi-angle ref. ~$0.60, ~90s. OK?

```
summer_generate_3d(
  prompt="A sleek modern Formula 1 race car, ...",
  model="hunyuan",
  options={ target_polycount: 25000 },
  wait=true
)
summer_get_asset(assetId="<assetId>")
summer_import_asset_by_id(assetId="<assetId>", path="res://assets/vehicles/race_car.glb")
```

### 5. Inspect for hard-surface artifacts

```
summer_inspect_resource(path="res://assets/vehicles/race_car.glb")
```

Open the import preview. Look for:
- **Smoothing-group artifacts on flat panels** (visible as banding under light) → fix in step 6 with a detail texture, or re-import with `Generate Tangents = on` and a custom shader.
- **Asymmetric headlights / wheels** → regenerate with `symmetric, mirrored bilateral` added to the prompt.
- **Melted door seams / panel gaps** → run the detail-texture pass (step 6).

### 6. Optional: secondary detail-texture pass

For hero vehicles, run a texture-only pass to recover panel-line crispness without re-meshing:

```
summer_generate_3d(
  kind="texture",
  imageUrl="<original front-view reference>",
  model="hunyuan",
  options={ target_polycount: 25000 }  // matched to existing mesh
)
```

This re-textures the existing mesh with sharper detail — panel lines, decals, weathering. Cheaper than re-meshing. Apply via material override in the editor.

### 7. Wire into the scene

| Use case | Parent type | Notes |
|---|---|---|
| Player-driven (car, bike, hover) | `VehicleBody3D` (wheeled) or `RigidBody3D` (free physics) | Add `VehicleWheel3D` children for wheeled vehicles |
| Player-driven (spaceship, mech) | `RigidBody3D` or `CharacterBody3D` | Custom thrust / walk code, see `fps-controller` |
| Background scenery (parked, flyby) | `MeshInstance3D` under a `Node3D` | No physics, no collision needed for distant traffic |
| Background traffic (moving but not interactive) | `Node3D` + `AnimationPlayer` driving the position | Cheap, no physics overhead |

**Player car wiring:**

```
summer_add_node(scenePath="res://main.tscn", parent="./World", type="VehicleBody3D", name="RaceCar")
summer_instantiate_scene(scenePath="res://main.tscn", parent="./World/RaceCar", scene="res://assets/vehicles/race_car.glb", name="Body")
summer_add_node(scenePath="res://main.tscn", parent="./World/RaceCar", type="CollisionShape3D", name="Collider")
summer_set_prop(scenePath="res://main.tscn", path="./World/RaceCar/Collider", key="shape", value="BoxShape3D")
summer_set_resource_property(scenePath="res://main.tscn", nodePath="./World/RaceCar/Collider", resourceProperty="shape", subProperty="size", value="Vector3(4.5, 1.1, 1.9)")
# Add VehicleWheel3D children at each wheel position
summer_save_scene(scenePath="res://main.tscn")
```

A `.glb` cannot be assigned to `MeshInstance3D.mesh` — an imported `.glb` is a scene, not a `Mesh` (`ResourceLoader.get_recognized_extensions_for_type("Mesh")` on the shipped 4.6.1 binary returns `["tres", "mesh", "res"]`, no `glb`). Instantiate it. Assigning a bare class name like `"BoxShape3D"` to a resource property auto-instantiates it, which is how you get a shape you can then size.

Every scene-mutating tool takes an explicit `scenePath`; node paths are relative to that scene's root (`./`); `summer_set_prop`'s property argument is `key`; and `summer_set_resource_property` needs all five of `scenePath`, `nodePath`, `resourceProperty`, `subProperty`, `value`.

**Background scenery wiring:**

```
summer_instantiate_scene(scenePath="res://main.tscn", parent="./World/Street", scene="res://assets/vehicles/sedan.glb", name="ParkedSedan")
summer_save_scene(scenePath="res://main.tscn")
```

## Anti-patterns

- **Single-angle reference for a hero vehicle.** Front-only → melted rear. Pass an `imageUrls` array (up to four views) for anything the player gets close to.
- **Expecting the prompt to request multi-view.** It cannot. `imageUrls` is the only multi-view mechanism.
- **Flat-shaded prompt for hard surfaces.** "Smooth shading", "rounded edges" → loses the panel-line crispness that defines vehicles. Prefer "hard-surface", "panel-lined", "crisp edges".
- **Skipping symmetry callouts.** Vehicles are bilaterally symmetric — without `symmetric, mirrored` you get one headlight bigger than the other 30% of the time.
- **Asking the mesh pass to invent decals / liveries.** It can't — the mesh has the silhouette but the decals get geometry-baked weirdly. Use the texture pass for liveries.
- **Wrapping a background sedan in VehicleBody3D.** Wastes physics for a parked car. Use MeshInstance3D under Node3D.
- **Picking `meshy` (legacy).** Worse hard-surface fidelity than hunyuan or trellis.

## Edge cases

- **Tracked vehicle (tank).** AI mesh-gen handles the hull but the tracks come back as a fused ring. Generate the hull only, then add tracks as a separate `prop-model` (or use a tiled texture on a torus). For animation, scroll the track texture's UV.
- **Articulated vehicle (mech with shoulders, hips, knees).** The mesh is one piece — joints aren't separated. For animated mechs, treat as a humanoid: generate as `character-model` with the rig pass, then animate via `generate-motion` (custom backend, prompt as "mech walks heavily").
- **Vehicle with rotor (helicopter, drone).** Generate without rotor, then add the rotor as a separate `prop-model` and parent it. Spin via code in `_process`.
- **Open-top vehicle (convertible, jeep).** Specify "open top, no roof" — defaults often add a roof.
- **The user wants the cockpit interior visible.** Generate exterior here, then a separate `prop-model` for the interior, and switch meshes when the camera enters first-person view.

## Fallback (no MCP)

1. Generate the multi-angle reference at the Summer dashboard (or Midjourney / nano-banana web).
2. Upload to Hunyuan or Trellis web playground → image-to-3D → download `.glb`.
3. Drop into `res://assets/vehicles/`.
4. Wire as VehicleBody3D / MeshInstance3D in Summer Engine manually.

## Handoff

After the vehicle is wired:

> `race_car.glb` placed at `./World/RaceCar` as a VehicleBody3D. Next:
> - **Vehicle controls:** WASD steering / accel — see `fps-controller` for the vehicle controller pattern (or write directly with `engine_force`, `steering`, and `brake` on VehicleBody3D).
> - **Driver character:** generate via `character-model` and parent to the seat position.
> - **Engine sound + tire screech:** `sound-effect` for one-shots, `ambient-bed` for the engine loop.
> - **Particles:** exhaust smoke, dust trail, sparks on collision — `vfx-smoke` / `vfx-hit-spark` or built-in GPUParticles3D.

## See also

- `character-model` — for the driver/pilot.
- `prop-model` — for separable parts (rotors, decals as decals, modular kit pieces).
- `asset-strategy` — meta-router.
- `fps-controller` — for player-driven vehicle input wiring.
- `../../references/mcp-tools-reference/mcp-tools-reference.md` — `summer_generate_3d` schema, including `kind: "texture"` for the secondary detail pass.
