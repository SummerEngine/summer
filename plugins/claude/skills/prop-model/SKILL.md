---
name: prop-model
description: "Generate one static 3D prop (sword, barrel, chest, lantern, statue): one object, no rig, a MeshInstance3D."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: 3d-assets
user-invocable: true
allowed-tools: Read Grep summer_assets_search summer_assets_get summer_import_asset_by_id summer_assets_generate_3d summer_assets_generate_image summer_import_from_url summer_add_node summer_set_prop summer_inspect_node summer_get_scene_tree summer_save_scene summer_jobs_wait summer_call
paths: ["assets/models/**", "**/*.tscn", "**/*.gd"]
---

# Prop Model — Generate One Static 3D Prop and Wire It

One prop, one mesh, one MeshInstance3D. Most game-world objects are static props, so this is the most common 3D-asset call. The skill keeps two things tight: the **prompt shape** that produces a clean isolated mesh on the first try, and the **wire-in pattern** that gets the asset into the scene without leaving orphans in `res://assets/models/`.

The backing operation is `assets.generate_3d`; it answers with a job that `jobs.wait` follows. Default model is `hunyuan` (Hunyuan 3D v3.1 Pro — best quality). Use `trellis` when speed matters (Trellis 2 is ~2× faster, slightly lower fidelity). `meshy` is the legacy fallback — only pick it if the user asks by name.

## When to use

- "Make me a treasure chest."
- "Generate a viking axe."
- "I need a wooden barrel for the cellar."
- "Create a sci-fi crate."
- Any single, static, non-character, non-modular object the player will see in 3D space.

## When NOT to use

- Character / humanoid → `character-model` (needs T-pose + rig pass).
- A set of matching pieces (walls, floors, doors, pillars) → `environment-kit` (style-locked family).
- Trees, rocks, foliage → `organic-model` (organic forgives AI artifacts; cheaper recipe).
- Cars, ships, mechs → `vehicle-model` (hard-surface specifics).
- Walls / floors / repeating geometry → `asset-strategy` Pipeline 2 (textures + CSG).
- "I just need a placeholder" → propose a primitive (`BoxMesh` / `CylinderMesh`) instead. Generation is metered.

## Steps

### 1. Search before generating

```
assets.search({ query: "<prop name>", assetType: "3d_model", scope: "all" })
```

If a fitting model exists, propose reuse:

> Found `assets/models/treasure_chest_01.glb`. Reuse this, or generate fresh?

### 2. Pick a polycount target

| Use case | Tris | Pass via |
|---|---|---|
| Hero prop (sword on hip, key item) | 3k–8k | `targetPolycount: 5000` |
| Background prop (crate, barrel, sack) | 200–800 | `targetPolycount: 600` |
| Mid-range interactive (chest, lantern) | 1k–3k | `targetPolycount: 2000` |
| Cinematic showcase (throne, statue) | 10k–30k | `targetPolycount: 20000` |

Default if you don't pass it: provider picks (~10k–30k). For most game-world props, that's overkill — pass a target.

### 3. Build the prompt

Pattern: `<object> + <material> + <silhouette/details> + isolated-object suffix`.

| Goal | Prompt that works |
|---|---|
| Treasure chest | `A wooden treasure chest with iron bands and a heavy padlock, lid slightly ajar, gold coins spilling. Game asset, centered, stylized, white background, isolated object.` |
| Viking axe | `A two-handed viking battle axe, weathered iron head with rune etchings, leather-wrapped wooden haft. Game asset, centered, stylized, white background, isolated object.` |
| Lantern | `A medieval brass lantern with stained glass panels and a hooked handle, candle inside. Game asset, centered, stylized, white background, isolated object.` |
| Throne | `An ornate stone throne carved with serpent motifs, red velvet cushion, tall pointed back. Game asset, centered, stylized, white background, isolated object.` |
| Sci-fi crate | `A weathered sci-fi cargo crate, metal panels with yellow hazard stripes, recessed handles. Game asset, centered, stylized, white background, isolated object.` |
| Potion bottle | `A glass potion bottle with a cork stopper, glowing purple liquid inside, leather strap around the neck. Game asset, centered, stylized, white background, isolated object.` |

The `isolated object` and `white background` clauses are load-bearing — without them you get scene context (table, ground plane) baked into the mesh.

### 4. Confirm and call

> About to generate `viking_axe` via `hunyuan`, target ~5k tris, ~60s. This uses credits. OK?

To say how many credits, run the same call with `dryRun: true` first: it returns `estimate` (`credits`, `balance`, `enough`) and generates nothing.

```
assets.generate_3d({
  prompt: "A two-handed viking battle axe, weathered iron head with rune etchings, leather-wrapped wooden haft. Game asset, centered, stylized, white background, isolated object.",
  model: "hunyuan",
  targetPolycount: 5000
})
jobs.wait({ jobId: "<job.id>", timeoutSeconds: 50 })   // again until finished
```

The finished job's `result` holds `assetId` and `fileUrl`. Treat `assetId` as the
stable handle and `fileUrl` as a fallback preview/import URL.

### 5. Import and wire

```
assets.get({ assetId: "<assetId>" })
summer_import_asset_by_id(
  assetId="<assetId>",
  path="res://assets/models/viking_axe.glb",
  parent="./World/Props",
  scenePath="res://main.tscn",
  name="VikingAxe"
)
summer_save_scene(scenePath="res://main.tscn")
```

`scenePath` is **required whenever `parent` is set** — it names the exact scene that receives the model, and the scene does not have to be the active editor tab. Omitting it fails the import with a `pass the exact scenePath when parent is set` hint. `summer_save_scene` likewise takes an explicit `scenePath`; there is no bare form.

For interactive props (chest the player opens, lantern the player picks up),
wrap the instantiated model in a `StaticBody3D` (or `RigidBody3D` for physics
props) with a `CollisionShape3D` sibling — see `scene-composition` for
the parent-shape pattern.

## Anti-patterns

- **Scene context in the prompt.** "A sword lying on a wooden table" → the table becomes geometry. Always say `isolated object`.
- **Multi-object prompts.** "A sword and a shield" → fused single mesh. Generate separately.
- **Skipping `targetPolycount` for background props.** A 30k-tri barrel in the background tanks frame rate when the level has 50 of them.
- **Forgetting to import.** `fileUrl` from `assets.generate_3d` is a remote URL — you MUST `summer_import_asset_by_id` or `summer_import_from_url` before referencing it as `res://...`.
- **Generating before searching.** Reuse beats regenerate every time.
- **Picking `meshy` by default.** It's legacy. `hunyuan` is better; `trellis` is faster.

## Edge cases

- **Transparent objects (glass, ice, gem).** AI 3D gen makes these opaque. Generate the mesh, then assign a `StandardMaterial3D` with `transparency = ALPHA` and a low `albedo_color.a` in the editor.
- **Long thin props (spear, staff, banner pole).** Hunyuan sometimes thickens the shaft. Trellis handles thin geometry better — try it as the second attempt.
- **Concave interior (open chest, hollow vase).** Specify "lid open" or "hollow inside" — Hunyuan defaults to closed solids.
- **Symmetrical prop comes back asymmetric.** Add `symmetric, mirrored` to the prompt and regenerate.

## Without Summer Engine

In a session without Summer Engine tools (the assets profile; the `summer-assets` skill has the whole loop), do steps 1-4 and skip step 5 (import and wiring). Save the file where the person asked with `out` (the `summer-assets` skill says how), and tell them the path and format. The file is GLB. Generated models are not at real-world size, so give the person the target size (a chair about 1 m, a door about 2 m) to scale it to.

## Fallback (no MCP)

The user can run the same prompt in the Summer dashboard or a supported
provider UI, download the `.glb`, and drop it into `res://assets/models/`.
Summer Engine's Import dock will pick it up. Then instance the `.glb` scene in
the level (an imported `.glb` is a scene, not a `Mesh`).

## Handoff

After the prop is wired:

> `viking_axe.glb` imported and placed at `./World/Props/VikingAxe`. Next:
> - For physics (player can knock it over), wrap in `RigidBody3D` + `CollisionShape3D` — see `scene-composition`.
> - For pickup interaction, see `design-mechanic` for the pickup pattern.
> - For matching props in the same style (chest → barrel → crate as a treasure-room kit), use `environment-kit` with this prop as the style anchor.

## See also

- `asset-strategy` — the meta-router that decides between this skill and Pipeline 2 (textures).
- `character-model` — for humanoids.
- `environment-kit` — for style-locked sets.
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
| `summer_inspect_node` | `summer engine inspect-node` |
| `summer_save_scene` | `summer engine save-scene` |
| `summer_set_prop` | `summer engine set-prop` |
| `jobs.wait`, `summer_jobs_wait` | `summer jobs wait` |
| `summer_search` | `summer ops search "<what you want>"` |
<!-- /shell-commands -->
