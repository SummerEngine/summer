---
name: environment-kit
description: Use when generating a modular environment kit — wall pieces, floor tiles, pillars, doors, arches, corner blocks that snap together to form a level. Multiple meshes that share a visual style. Trigger on "build a dungeon kit", "modular walls", "level kit", "tileset", "interior pieces", "snap-together pieces", "make a kit for the temple".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: 3d-assets
user-invocable: true
allowed-tools: Read Grep summer_search_assets summer_list_my_assets summer_get_asset summer_import_asset_by_id summer_generate_3d summer_generate_image summer_import_from_url summer_add_node summer_set_prop summer_inspect_node summer_get_scene_tree summer_save_scene
paths: ["assets/kits/**", "assets/models/**", "**/*.tscn", "**/*.gd"]
---

# Environment Kit — Style-Locked Modular Pieces

A kit is a *family* of meshes — wall, floor, door, pillar, corner, arch — that the level designer snaps together to build interiors and exteriors. The skill exists to solve **one specific failure mode**: generating each piece with a fresh prompt produces six pieces that look like they came from six different games. The fix is the **style anchor pattern** — generate one piece first, lock its prompt suffix, and reuse that exact suffix for every subsequent piece.

The backing tool is `summer_generate_3d`, called multiple times. Each call costs ~$0.50, so a 6-piece kit is ~$3 and ~5 minutes. Confirm scope before starting.

## When to use

- "Build me a dungeon kit — walls, floor, door, pillar."
- "I need modular wall pieces for a sci-fi corridor."
- "Make a tileset for a wooden tavern interior."
- "Generate the pieces for a stone temple — I'll assemble the level."
- The user wants to build a level out of repeating, snapping pieces.

## When NOT to use

- A single hero prop (single chest, single throne) → `prop-model`.
- Open-world terrain (rolling hills, forests) → use a heightmap + scattered organic models from `organic-model`.
- Repeating flat surfaces only (just walls and floors, no decorative pieces) → `asset-strategy` Pipeline 2 (textures + CSG) is cheaper and snaps perfectly to grid.
- Characters or vehicles in the scene — those are separate skills.

## The style anchor pattern

This is the whole skill. Get this right and the kit looks unified. Get this wrong and you waste $3.

1. **Generate the anchor piece first.** Pick the most visually defining piece — usually the wall or the door. Iterate the prompt until the user approves it visually.
2. **Extract the style suffix.** Everything after the object description. Example anchor prompt:
   ```
   A stone dungeon wall section, mossy granite blocks with iron reinforcements, 
   torch-bracket sconce, weathered surface. Game asset, centered, stylized 
   low-poly game art, warm torchlight palette, white background, isolated object.
   ```
   The suffix to lock is everything from `Game asset, ...` onward, plus `mossy granite blocks with iron reinforcements, weathered surface, warm torchlight palette` — the material + palette tokens.
3. **Reuse the suffix verbatim** for every other piece. Only change the object description at the front.

| Anchor: wall | `A stone dungeon wall section, ...` + LOCKED SUFFIX |
| Floor tile | `A stone dungeon floor tile, square, ...` + SAME LOCKED SUFFIX |
| Pillar | `A stone dungeon pillar, square base, fluted shaft, ...` + SAME LOCKED SUFFIX |
| Door | `A stone dungeon doorway, arched, heavy wooden door with iron studs, ...` + SAME LOCKED SUFFIX |
| Corner block | `A stone dungeon corner wall section, two walls joined at right angle, ...` + SAME LOCKED SUFFIX |
| Arch | `A stone dungeon archway with keystone, ...` + SAME LOCKED SUFFIX |

If the user says "the door doesn't match the rest", the answer is almost always: the suffix drifted. Check the exact strings.

## Snap-grid alignment

Kit pieces only feel modular if they snap to a fixed grid. Pick the grid before generating and tell the user.

| Grid size | Use for | Notes |
|---|---|---|
| **1m** | Tight interiors (dungeons, ship corridors, cells) | Wall = 1×3×0.3m. Floor = 1×1m. Most common. |
| **2m** | Standard interiors (homes, taverns, offices) | Wall = 2×3×0.3m. Floor = 2×2m. Halves piece count. |
| **4m** | Exteriors and large halls (temples, warehouses, throne rooms) | Wall = 4×4×0.4m. Floor = 4×4m. Quarter the piece count for the same area. |

**Critical:** include the dimensions in the prompt. `summer_generate_3d` doesn't enforce them, but Hunyuan respects scale cues — `2 meter tall wall section` produces a mesh that imports near 2m tall. Then verify with `summer_inspect_resource` and scale-correct in the editor if needed.

## Steps

### 1. Confirm scope and pick the grid

> About to build a dungeon kit. Suggested pieces: wall, floor, pillar, door, corner, arch (6 pieces, ~$3, ~5 min). Snap grid: 2m (standard interior). OK?

### 2. Generate the anchor (wall)

Use the prop-style prompt with explicit dimensions:

```
summer_generate_3d(
  prompt="A 2 meter wide by 3 meter tall stone dungeon wall section, mossy granite blocks with iron reinforcements, torch-bracket sconce, weathered surface. Game asset, centered, stylized low-poly game art, warm torchlight palette, white background, isolated object.",
  model="hunyuan",
  options={ target_polycount: 1500 },
  wait=true
)
summer_get_asset(assetId="<assetId>")
summer_import_asset_by_id(assetId="<assetId>", path="res://assets/kits/dungeon/wall.glb")
```

Show the result to the user. **Iterate the anchor until approved** — every other piece copies its style.

### 3. Lock the suffix and generate the remaining pieces

Once the user says "yes, that's the look", store the locked suffix and crank through the rest. Same model, same polycount, same `options`. Only the object description changes.

```
# Floor
summer_generate_3d(prompt="A 2 by 2 meter square stone dungeon floor tile, mossy granite blocks with iron reinforcements, weathered surface. Game asset, centered, stylized low-poly game art, warm torchlight palette, white background, isolated object.", model="hunyuan", options={ target_polycount: 800 })

# Pillar
summer_generate_3d(prompt="A 3 meter tall stone dungeon pillar, square base, fluted shaft, mossy granite blocks with iron reinforcements, weathered surface. Game asset, ...", model="hunyuan", options={ target_polycount: 1500 })

# Door, Corner, Arch — same pattern.
```

For each completed generation, capture the returned `assetId`, then import that
exact ID with `summer_import_asset_by_id`. Do not search for generated pieces by
name after creating them; exact IDs are the production path.

Polycount targets per kit piece: walls/floors 800–1500 tris (placed dozens of times), decorative (pillar, arch) 1500–3000, doors 2000–3000.

### 4. Import and stage in a kit scene

Don't dump the kit into the level scene. Make a `kit_dungeon.tscn` that holds one of every piece, labelled, positioned next to each other on the snap grid. The level designer instantiates from there.

```
summer_instantiate_scene(scenePath="res://assets/kits/dungeon/kit_dungeon.tscn", parent="./KitRoot", scene="res://assets/kits/dungeon/wall.glb", name="Wall")
summer_set_prop(scenePath="res://assets/kits/dungeon/kit_dungeon.tscn", path="./KitRoot/Wall", key="position", value="Vector3(0, 0, 0)")
# ...repeat for floor, pillar, door, corner, arch with positions Vector3(2,0,0), Vector3(4,0,0), ...
summer_save_scene(scenePath="res://assets/kits/dungeon/kit_dungeon.tscn")
```

Three things the shape of those calls encodes:

- **A `.glb` is instantiated, not assigned.** There is no `scene` property on `Node3D`, and an imported `.glb` is a scene, not a `Mesh` — `ResourceLoader.get_recognized_extensions_for_type("Mesh")` on the shipped 4.6.1 binary returns `["tres", "mesh", "res"]`, with no `glb`. Use `summer_instantiate_scene`, which adds the model as a child in one op.
- **Every scene-mutating tool takes an explicit `scenePath`**, and node paths are relative to that scene's root (`./`).
- **`summer_set_prop`'s property argument is named `key`**, not `property`.

### 5. Verify scale and pivots

```
summer_inspect_resource(path="res://assets/kits/dungeon/wall.glb")
```

Check the AABB. If the wall is 1.85m tall when you asked for 3m, scale it in the editor (or re-import with `Scale` in the import dock). Pivots should sit at the *bottom-back* corner for walls and *bottom-center* for floors — that makes snapping to a 2m grid trivial. If pivots are wrong, use Godot's "Center to Origin" import option.

## Anti-patterns

- **Drifting style suffix.** Each piece gets a slightly different suffix → the kit looks mismatched. Copy-paste the exact string.
- **Different polycount per piece.** A 5k-tri pillar next to a 500-tri wall reads as "the pillar is a hero piece" — wrong; they should feel like equal kit citizens. Match polycount within ~2× across the kit.
- **Skipping the anchor approval.** If you generate all six pieces in a batch, you bake in whatever the first call's interpretation of the style was — and the user may hate it after $3 of generation.
- **Generating walls / floors as individual meshes when you only need a tileable texture.** A flat wall section is cheaper as a textured `CSGBox3D`. Reserve the kit for pieces that need actual geometric detail (sconces, mouldings, doorways, arches).
- **No scale cue in the prompt.** Wall comes back 0.4m tall. Always include `2 meter wide by 3 meter tall` (or your chosen grid).
- **Forgetting the snap grid.** A 1.87m-tall wall with no scale fix → level looks crooked when tiled.

## Edge cases

- **Curved or organic kit (cave, alien hive).** Modular geometry resists snapping. Generate longer pieces (4m walls, transition tiles) and accept some overlap. Or switch to procedural — `design-level` can scatter cave pieces with rotation jitter.
- **Outdoor kit (cliffs, ruins, forest path).** Use the kit pattern but accept rotation/jitter at placement time. Mesh edges should fade naturally rather than snap cleanly. Pair with `organic-model` for foliage scatter.
- **Sci-fi kit (corridors, doors, terminals).** The style suffix becomes critical — `clean panels, soft cyan emissive trim, brushed metal, white background, isolated object`. Hard surfaces drift more than organic ones; review every piece.
- **The user wants to add a piece later.** The locked suffix lives in the kit's notes (drop it in `assets/kits/dungeon/STYLE.md` if the user wants persistence). Reuse it verbatim for any addition — never re-derive.

## Fallback (no MCP)

1. Run each prompt at the Summer dashboard (or Hunyuan / Trellis web UIs), keeping the locked suffix.
2. Download each `.glb`.
3. Drop into `res://assets/kits/<kit-name>/`.
4. Build the kit-display scene manually in Summer Engine, with one of each piece
   snapped to the grid.
5. Hand to the level designer.

## Handoff

After the kit is staged:

> Dungeon kit ready: `res://assets/kits/dungeon/` with wall, floor, pillar, door, corner, arch on a 2m snap grid. Display scene at `res://assets/kits/dungeon/kit_dungeon.tscn`.
>
> Next: hand off to the level-design step — instantiate kit pieces into `level_01.tscn`, snap to the 2m grid, dress with props (`prop-model`) and foliage (`organic-model`). For lighting, see `3d-lighting`.

## See also

- `prop-model` — for the chests, statues, and decorative props that dress the kit.
- `organic-model` — for foliage and rocks that break up modular repetition.
- `asset-strategy` — Pipeline 2 (textures + CSG) is the cheaper alternative when pieces are flat.
- `scene-composition` — how to organize the kit scene and the level scenes that consume it.
- `3d-lighting` — interior kit pieces typically need warm point lights at sconce positions.
