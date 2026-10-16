---
name: organic-model
description: "Generate organic 3D shapes (trees, rocks, mushrooms, plants, crystals) where irregularity looks natural."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: 3d-assets
user-invocable: true
allowed-tools: Read Grep summer_assets_search summer_assets_get summer_import_asset_by_id summer_assets_generate_3d summer_assets_generate_image summer_import_from_url summer_add_node summer_set_prop summer_inspect_node summer_get_scene_tree summer_save_scene summer_jobs_wait summer_call
paths: ["assets/organic/**", "assets/models/**", "**/*.tscn", "**/*.gd"]
---

# Organic Model — Easy-Mode 3D Generation

Organic shapes (trees, rocks, mushrooms, coral, alien flora, crystals, vines, bones) are **the most forgiving category for AI 3D generation**. Lumps look natural. Asymmetry looks natural. Smoothing-group artifacts read as bark texture. The "melted" look that ruins vehicles and characters is fine on a mossy boulder.

This is the cheapest, fastest way to fill out a scene, and the first choice when the user says "this scene feels empty". The failure rate is the lowest of any 3D-asset family.

Backing operation: `assets.generate_3d` (it answers with a job: `jobs.wait` until it finishes). Default `hunyuan` works well here, but `trellis` is faster and the quality difference is hard to see on organic shapes. Pick `trellis` when generating many at once.

## When to use

- "Make me a pine tree."
- "Generate five different rocks I can scatter."
- "I need glowing mushrooms for the cave."
- "Fill this forest scene with foliage."
- "Alien plants for the planet surface."
- "Coral for the underwater level."
- The user wants visual density quickly and cheaply.

## When NOT to use

- Character (humanoid, even if "tree-person") → `character-model` (rigging matters).
- Vehicle, weapon, hard-surface object → `prop-model` or `vehicle-model`.
- Tileable ground (grass field, sand) → `asset-strategy` Pipeline 2 (textures, not meshes).
- Animated organic (Venus fly trap that opens, breathing pod) → generate static here, animate in-engine with bones or shape keys.
- A single hero-tree centerpiece (Yggdrasil, the One Tree) — generate via `prop-model` with higher polycount and detail attention.

## Polycount targets

Organic geometry tolerates aggressive polycount cuts because the silhouette is irregular — viewers can't spot poly-count drops the way they spot a low-poly cylinder.

| Use case | Tris | Pass via |
|---|---|---|
| Hero tree (mid-distance, prominent) | 4k–8k | `targetPolycount: 6000` |
| Background tree (forest filler) | 1k–3k | `targetPolycount: 2000` |
| Distant tree (use billboard imposter) | 200–500 | `targetPolycount: 400` |
| Large rock / boulder | 800–2000 | `targetPolycount: 1500` |
| Small organic (mushroom, fruit, crystal) | 300–1000 | `targetPolycount: 600` |
| Vine / branch decoration | 200–500 | `targetPolycount: 400` |

Generating a forest? Make 3 hero trees + 5 background trees + 3 rocks at low polycount, then scatter via `MultiMeshInstance3D` for hundreds of copies at near-zero rendering cost.

## Steps

### 1. Search before generating

```
assets.search({ query: "<organic type>", assetType: "3d_model", scope: "all" })
```

### 2. Build the prompt

Pattern: `<species> + <state/condition> + <key features> + isolated suffix`. Organic prompts are shorter than prop prompts — the model already knows what a tree looks like.

| Goal | Prompt that works |
|---|---|
| Pine tree | `A tall pine tree with dense green needles and a straight trunk, slight lean. Game asset, stylized low-poly game art, white background, isolated object.` |
| Oak tree | `A wide oak tree with sprawling branches and seasonal autumn leaves in orange and red. Game asset, stylized, white background, isolated object.` |
| Boulder | `A large mossy boulder, irregular weathered surface, patches of green moss on top. Game asset, stylized, white background, isolated object.` |
| Glowing mushroom | `A cluster of three bioluminescent mushrooms on a small mossy base, pale cyan glow, translucent caps. Game asset, stylized, white background, isolated object.` |
| Alien plant | `An alien spiral plant with tendril-like fronds, deep purple with glowing pink tips, growing from a bulbous base. Game asset, stylized, white background, isolated object.` |
| Coral cluster | `A branching coral cluster, bright orange and pink, sea-fan shapes, multiple branches. Game asset, stylized, white background, isolated object.` |
| Crystal | `A jagged amethyst crystal cluster growing from a stone base, deep purple with translucent facets. Game asset, stylized, white background, isolated object.` |
| Vine | `A hanging jungle vine with broad green leaves and small white flowers, ~2 meter length. Game asset, stylized, white background, isolated object.` |

Organic prompts that DON'T work:

| Bad prompt | Failure mode |
|---|---|
| `a tree` | Returns a generic tree, but inconsistent species across regenerations — the scene looks chaotic. Always specify species. |
| `a forest` | Returns one fused mesh of multiple trees → impossible to scatter. Generate one tree, scatter via MultiMeshInstance3D. |
| `realistic tree with photoreal bark` | Realistic = expensive polycount, ugly when stylized assets surround it. Match scene style. |
| `a tree on a hill` | The hill becomes geometry. Always say `isolated object`. |

### 3. Confirm and call

> About to generate `pine_tree_01` via `trellis`, target ~2k tris, ~30s. This uses credits. OK?

For batch generation, batch the confirmation:

> About to generate 3 trees + 3 rocks + 5 mushrooms (11 generations, ~5 min). All low-poly via `trellis`. OK?

`dryRun: true` on one call gives its credits (`estimate.credits`) for the batch confirmation. Start every generation of the batch first, then wait on the jobs.

```
assets.generate_3d({
  prompt: "A tall pine tree with dense green needles and a straight trunk, slight lean. Game asset, stylized low-poly game art, white background, isolated object.",
  model: "trellis",
  targetPolycount: 2000
})
jobs.wait({ jobId: "<job.id>", timeoutSeconds: 50 })   // again until finished; result.assetId
assets.get({ assetId: "<assetId>" })
summer_import_asset_by_id(assetId="<assetId>", path="res://assets/organic/pine_tree_01.glb")
```

### 4. Generate variation, not duplication

If the user wants "five rocks", don't generate one rock and copy it five times in the scene — generate five subtly different prompts:

```
"A medium boulder, mossy granite, rounded shape"
"A medium boulder, weathered limestone, sharp jagged edges"
"A medium boulder, dark basalt, flat-topped"
"A medium boulder, sandstone, layered horizontal striations"
"A medium boulder, mossy granite, tall narrow shape"
```

Then scatter all five with random rotation. Five unique meshes + rotation = looks like 50 unique rocks.

### 5. Wire into the scene

| Use case | Wiring | Notes |
|---|---|---|
| Single hero tree, mid-scene | `MeshInstance3D` under `Node3D` | One per scene; nothing fancy |
| Forest scatter (50+ trees) | `MultiMeshInstance3D` with one mesh ref | Single draw call for all instances |
| Foliage variety (3 species) | One `MultiMeshInstance3D` per species | Each species is one draw call |
| Distant trees | Billboard imposter (Sprite3D with a tree image) | Switch from mesh to billboard at ~50m via LOD |
| Rocks with collision | `StaticBody3D` parent + `CollisionShape3D` (ConcaveShape from mesh) | Only for rocks the player can walk into |
| Rocks without collision (background) | Just `MeshInstance3D` | Most distant rocks don't need it |

**Hero tree:**

```
summer_instantiate_scene(scenePath="res://main.tscn", parent="./World/Forest", scene="res://assets/organic/oak_tree.glb", name="HeroOak")
summer_save_scene(scenePath="res://main.tscn")
```

A `.glb` cannot be assigned to `MeshInstance3D.mesh`. An imported `.glb` is a scene, not a `Mesh` — on the shipped 4.6.1 binary `ResourceLoader.get_recognized_extensions_for_type("Mesh")` returns `["tres", "mesh", "res"]`, with no `glb`. `summer_instantiate_scene` adds it as a child in one op. (For the `MultiMeshInstance3D` path below you do need a real `Mesh`: pull it out of the instantiated scene's `MeshInstance3D` in script, or save it as a `.tres`.)

Every scene-mutating tool takes an explicit `scenePath`; node paths are relative to that scene's root (`./`).

**Forest scatter (MultiMesh):** create a `MultiMeshInstance3D`, assign a `MultiMesh` resource referencing the tree mesh, set `instance_count` to e.g. 100, and populate `set_instance_transform()` from a script with random positions + rotations. See `scene-composition` for the scatter pattern.

### 6. LOD and billboards

For dense forests, the cheapest fix beyond MultiMesh is the billboard imposter:

1. Generate the tree mesh once at high polycount.
2. Render it from one angle to a transparent PNG (an `EditorScript` can capture a viewport).
3. Use that PNG as a `Sprite3D` with `billboard = enabled`.
4. Swap from `MeshInstance3D` to `Sprite3D` at ~50m camera distance with `visibility_range_end` on the mesh and `visibility_range_begin` on the sprite (both on `GeometryInstance3D`), or a custom LOD script.

In a 200-tree forest, only the ~10 closest trees need to be real meshes; the other 190 can be billboards.

## Anti-patterns

- **Generating "a forest" as one prompt.** Returns a single fused mesh — useless for placement. Always one species per generation, then scatter.
- **Regenerating the same species 5 times for variety.** Generate 5 *different* species/states/colors for true variety; identical regenerations don't differ enough.
- **High polycount on background organics.** A 30k-tri rock used 50 times in the background tanks the frame rate. Cap distant organics at 2k.
- **Ignoring MultiMeshInstance3D.** 100 individual MeshInstance3D nodes = 100 draw calls. 100 instances of one MultiMesh = 1 draw call. Same visual result.
- **Adding collision to every leaf and pebble.** Player only needs collision on things the body can hit. Skip it for distant scenery and small ground litter.
- **Using `meshy` (legacy).** No reason to — `trellis` is faster and `hunyuan` is higher quality.

## Edge cases

- **Animated foliage (wind sway).** Generate static here, then add wind sway via a hand-written vertex displacement shader on the material. No animation rig needed.
- **Underwater organics (kelp, anemones).** Same flow; expect Hunyuan to add a "ground attachment" base unless you say `floating, suspended in water`.
- **Branching meshes (vines, roots) come back too thick.** Specify `thin tendril, fine branches`, or accept and scale Y down in the editor.
- **Snow / ice / frozen variant.** Add `covered in snow, frosted, ice crystals` to the prompt — works well on trees and rocks. For temperature variants of the same scene, generate the variant rather than retexturing.
- **Crystal/glass organic.** Mesh comes back opaque. Generate the geometry, then assign a `StandardMaterial3D` with `transparency = ALPHA` and emissive in the editor.
- **Bones, skulls, dead trees.** All work; organic forgives them more than props would. Add `weathered, sun-bleached` for desert / tundra feel.

## Without Summer Engine

In a session without Summer Engine tools (the assets profile; the `summer-assets` skill has the whole loop), do steps 1-4 and skip steps 5-6 (scene wiring, LOD). Save the file where the person asked with `out` (the `summer-assets` skill says how), and tell them the path and format. The file is GLB; level of detail and billboards are the person's engine's job.

## Fallback (no MCP)

1. Run prompts at the Summer dashboard or any 3D-gen web playground (Hunyuan, Trellis, Meshy).
2. Download `.glb` files into `res://assets/organic/`.
3. Build scatter scenes manually in Summer Engine.

For totally free / offline alternatives: **Quaternius** (free stylized organics), **AmbientCG** (rocks + textures), **Sketchfab** free filter, **Polyhaven** (HDRIs + scans).

## Handoff

After the organic models are scattered:

> Forest scatter ready: 3 species at `res://assets/organic/`, 100 instances each via MultiMeshInstance3D in `./World/Forest`. Next:
> - **Wind shader** (sway in breeze): hand-write a vertex displacement shader.
> - **Ground texture** (grass beneath the trees): `asset-strategy` Pipeline 2 for tileable ground.
> - **Lighting / fog** (forest mood): `3d-lighting` for ambient + directional sun + volumetric fog.
> - **Ambient audio** (forest birds, leaves): `ambient-bed`.
> - **Hero props** (a stump, a fallen log, a shrine): `prop-model` for the hand-placed standouts.

## See also

- `prop-model` — for hand-placed standout pieces.
- `environment-kit` — pair with this skill: kit pieces give the architecture, organic gives the natural softness.
- `asset-strategy` — meta-router; ground textures and skyboxes go to Pipeline 2 / panoramic gen.
- `scene-composition` — MultiMeshInstance3D scatter pattern.
- `summer_docs_read` id `reference/mcp-tools-reference` — how to call `assets.generate_3d`; `summer_search` returns its exact input.

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@latest` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

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
| `summer_inspect_node` | `summer engine inspect-node` |
| `summer_instantiate_scene` | `summer engine instantiate-scene` |
| `summer_save_scene` | `summer engine save-scene` |
| `summer_set_prop` | `summer engine set-prop` |
| `jobs.wait`, `summer_jobs_wait` | `summer jobs wait` |
| `summer_search` | `summer ops search "<what you want>"` |
<!-- /shell-commands -->
