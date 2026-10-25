---
name: vehicle-model
description: "Generate a hard-surface vehicle (car, spaceship, mech, boat, tank) as a static or VehicleBody3D mesh."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: 3d-assets
user-invocable: true
allowed-tools: Read Grep summer_assets_search summer_assets_get summer_import_asset_by_id summer_assets_generate_3d summer_assets_generate_image summer_import_from_url summer_add_node summer_set_prop summer_inspect_node summer_inspect_resource summer_get_scene_tree summer_save_scene summer_jobs_wait summer_call
paths: ["assets/vehicles/**", "assets/models/**", "**/*.tscn", "**/*.gd"]
---

# Vehicle Model — Hard-Surface 3D Generation

Vehicles are the hardest 3D-gen category. Hard surfaces (flat panels, sharp edges, symmetrical bodies) expose every flaw the AI mesher has — smoothing-group artifacts on flat panels, asymmetric headlights, melted door seams. This skill exists to push the success rate up by giving the model **multi-angle reference**, picking the right backend, and using a **secondary detail pass** (decals) to recover crispness on the body panels.

Backing operation: `assets.generate_3d` (it answers with a job: `jobs.wait` until it finishes). Default model is `hunyuan` (best general quality). For pure hard-surface (clean spaceship, F1 car), try `trellis` first — it tends to preserve panel edges better.

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
| Player vehicle (close camera, lots of screen time) | 15k–30k | `targetPolycount: 25000` |
| Hero showpiece (cinematic, garage view) | 30k–60k | `targetPolycount: 50000` |
| Background traffic (mid-range, multiple onscreen) | 2k–5k | `targetPolycount: 4000` |
| Distant flyby / parked scenery | 1k–2k | `targetPolycount: 1500` |

Vehicles benefit more from polycount than props — flat panels need edge density to look right. Don't go below 2k for anything the camera will get close to.

## Multi-angle reference — the single biggest quality lever

Vehicles are highly view-dependent. A front-only reference produces a mesh with great front detail and a melted rear. There are two ways to give the mesher more than one angle, and they are not the same thing:

**(a) A real multi-image request — prefer this.** `assets.generate_3d` takes an `imageUrls` array of two to four views. These are passed through as separate views, not fused into one picture. Several views run on Meshy (`meshy` or `meshy-7.1`; any other model is switched to Meshy).

```
assets.generate_3d({
  kind: "image-to-3d",
  imageUrls: ["<front url>", "<3/4 rear-side url>", "<profile url>"],
  model: "meshy",
  targetPolycount: 25000
})
```

**(b) A composite reference image**, when you only have one slot to work with:

```
assets.generate_image({
  prompt: "A sleek red sports car, front view AND 3/4 rear-side view side by side, two angles in one image, white background, studio lighting, clean references for 3D modeling, isolated, no scenery.",
  aspectRatio: "16:9"
})

assets.generate_3d({
  kind: "image-to-3d",
  imageUrl: "<composite reference url>",
  model: "hunyuan",
  targetPolycount: 25000
})
```

If the user has reference images already (concept art, photos), pass them straight to `imageUrls` — do not composite them down into one image first; that throws away the multi-view path.

## Steps

### 1. Search before generating

```
assets.search({ query: "<vehicle type>", assetType: "3d_model", scope: "all" })
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

Nothing in the prompt text "triggers" multi-view. The phrase `front and 3/4 side views` only shapes what the *image* model draws; the 3D operation has no prompt-sniffing and sees whatever pixels you hand it. Multi-view comes from the `imageUrls` array, nothing else.

### 4. Confirm and call

> About to generate `red_race_car` via `hunyuan`, target ~25k tris, multi-angle ref. Uses credits, ~90s. OK?

The same call with `dryRun: true` first gives the credits for the confirmation (`estimate.credits`, and `enough` against their balance).

```
assets.generate_3d({
  prompt: "A sleek modern Formula 1 race car, ...",
  model: "hunyuan",
  targetPolycount: 25000
})
jobs.wait({ jobId: "<job.id>", timeoutSeconds: 50 })   // again until finished; result.assetId
assets.get({ assetId: "<assetId>" })
summer_import_asset_by_id(assetId="<assetId>", path="res://assets/vehicles/race_car.glb")
```

### 5. Inspect for hard-surface artifacts

```
summer_inspect_resource(path="res://assets/vehicles/race_car.glb")
```

Open the import preview. Look for:
- **Smoothing-group artifacts on flat panels** (visible as banding under light) → cover with step 6's detail decals, or re-import with `Generate Tangents = on` and a custom shader.
- **Asymmetric headlights / wheels** → regenerate with `symmetric, mirrored bilateral` added to the prompt.
- **Melted door seams / panel gaps** → regenerate from a cleaner multi-view reference, or paint the seams back with step 6's decals.

### 6. Optional: secondary detail pass

There is no texture-only 3D pass among the asset operations (`assets.generate_3d` takes `text-to-3d` or `image-to-3d`). For hero vehicles, recover panel-line crispness without re-meshing by drawing the detail as images and laying it on the mesh:

```
assets.generate_image({
  prompt: "Flat orthographic livery and panel-line decal for a red Formula 1 car side, crisp seams, sponsor stripes, transparent background",
  referenceImageUrl: "<original front-view reference>",
  aspectRatio: "16:9",
  removeBackground: true
})
```

Import it and apply it with `Decal` nodes or as a detail texture in a material override in the editor. Cheaper than re-meshing.

### 7. Wire into the scene

| Use case | Parent type | Notes |
|---|---|---|
| Player-driven (car, bike, hover) | `VehicleBody3D` (wheeled) or `RigidBody3D` (free physics) | Add `VehicleWheel3D` children for wheeled vehicles |
| Player-driven (spaceship, mech) | `RigidBody3D` or `CharacterBody3D` | Custom thrust / walk code (`character-movement` for walkers) |
| Background scenery (parked, flyby) | `MeshInstance3D` under a `Node3D` | No physics, no collision needed for distant traffic |
| Background traffic (moving but not interactive) | `Node3D` + `AnimationPlayer` driving the position | Cheap, no physics overhead |

**Player car wiring** (one `summer_run_script`; `scenePath` is the exact scene to change):

```
summer_run_script(scenePath="res://main.tscn", source="""
func run(ctx):
    var car = ctx.add_node("VehicleBody3D", "RaceCar", ctx.find("World"))
    ctx.instance_scene("res://assets/vehicles/race_car.glb", car, "Body")
    var box = BoxShape3D.new()
    box.size = Vector3(4.5, 1.1, 1.9)
    ctx.add_node("CollisionShape3D", "Collider", car, {"shape": box})
    # Add one VehicleWheel3D per wheel here, at the hub positions summer_inspect_asset measured on the model.
    ctx.save_scene()
""")
```

A `.glb` cannot be assigned to `MeshInstance3D.mesh` — an imported `.glb` is a scene, not a `Mesh` (`ResourceLoader.get_recognized_extensions_for_type("Mesh")` on the shipped engine returns `["tres", "mesh", "res"]`, no `glb`). Instantiate it (`ctx.instance_scene` in a script, `summer_instantiate_scene` for one model). Build and size the collision shape before you assign it.

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
- **Asking the mesh pass to invent decals / liveries.** It can't — the mesh has the silhouette but the decals get geometry-baked weirdly. Use step 6's decals for liveries.
- **Wrapping a background sedan in VehicleBody3D.** Wastes physics for a parked car. Use MeshInstance3D under Node3D.
- **Picking `meshy` (legacy).** Worse hard-surface fidelity than hunyuan or trellis.

## Edge cases

- **Tracked vehicle (tank).** AI mesh-gen handles the hull but the tracks come back as a fused ring. Generate the hull only, then add tracks as a separate `prop-model` (or use a tiled texture on a torus). For animation, scroll the track texture's UV.
- **Articulated vehicle (mech with shoulders, hips, knees).** The mesh is one piece — joints aren't separated. For animated mechs, treat as a humanoid: generate as `character-model` with the rig pass, then animate with `text-to-motion` (prompt "walks heavily").
- **Vehicle with rotor (helicopter, drone).** Generate without rotor, then add the rotor as a separate `prop-model` and parent it. Spin via code in `_process`.
- **Open-top vehicle (convertible, jeep).** Specify "open top, no roof" — defaults often add a roof.
- **The user wants the cockpit interior visible.** Generate exterior here, then a separate `prop-model` for the interior, and switch meshes when the camera enters first-person view.

## Without Summer Engine

In a session without Summer Engine tools (the assets profile; the `summer-assets` skill has the whole loop), do steps 1-6 and skip step 7 (scene wiring, `VehicleWheel3D`). Save the file where the person asked with `out` (the `summer-assets` skill says how), and tell them the path and format. The file is GLB and not at real-world size: give the person the target length (a car about 4.5 m) and tell them where the wheels are, so they can set up their engine's vehicle physics.

## Fallback (no MCP)

1. Generate the multi-angle reference at the Summer dashboard (or Midjourney / nano-banana web).
2. Upload to Hunyuan or Trellis web playground → image-to-3D → download `.glb`.
3. Drop into `res://assets/vehicles/`.
4. Wire as VehicleBody3D / MeshInstance3D in Summer Engine manually.

## Handoff

After the vehicle is wired:

> `race_car.glb` placed at `./World/RaceCar` as a VehicleBody3D. Next:
> - **Vehicle controls:** WASD steering / accel — write them with `engine_force`, `steering`, and `brake` on VehicleBody3D.
> - **Driver character:** generate via `character-model` and parent to the seat position.
> - **Engine sound + tire screech:** `sound-effect` for one-shots, `ambient-bed` for the engine loop.
> - **Particles:** exhaust smoke, dust trail, sparks on collision — `vfx-smoke` / `vfx-hit-spark` or built-in GPUParticles3D.

## See also

- `character-model` — for the driver/pilot.
- `prop-model` — for separable parts (rotors, decals as decals, modular kit pieces).
- `asset-strategy` — meta-router.
- `summer_docs_read` id `reference/mcp-tools-reference` — how to call `assets.generate_3d`; `summer_search` returns its exact input.

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@4.9.0` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `assets.generate_3d`, `summer_assets_generate_3d` | `summer assets generate-3d` |
| `summer_assets_generate_image` | `summer assets generate-image` |
| `summer_assets_get` | `summer assets get` |
| `summer_assets_search` | `summer assets search` |
| `summer_docs_read` | `summer docs read` |
| `summer_add_node` | `summer engine add-node` |
| `summer_get_scene_tree` | `summer engine get-scene-tree` |
| `summer_import_asset_by_id` | `summer engine import-asset-by-id` |
| `summer_import_from_url` | `summer engine import-from-url` |
| `summer_inspect_asset` | `summer engine inspect-asset` |
| `summer_inspect_node` | `summer engine inspect-node` |
| `summer_inspect_resource` | `summer engine inspect-resource` |
| `summer_instantiate_scene` | `summer engine instantiate-scene` |
| `summer_run_script` | `summer engine run-script` |
| `summer_save_scene` | `summer engine save-scene` |
| `summer_set_prop` | `summer engine set-prop` |
| `jobs.wait`, `summer_jobs_wait` | `summer jobs wait` |
| `summer_search` | `summer ops search "<what you want>"` |
<!-- /shell-commands -->
