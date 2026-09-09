---
name: instantiate-asset-pack
description: Use when the user wants to import or spawn an entire asset pack (the multi-slice ArtAsset produced by `create-asset-sheet`) into the current scene — not a single slice, the whole pack. Reads the pack's per-slice metadata (zOrder, isComposite, parentSliceIndex, widget, bbox), groups composites, sorts children by paint order, and emits the Sprite2D / Node2D / NinePatchRect ops to lay it out correctly. Trigger on "import the X pack", "spawn the UI from pack Y", "bring in that asset sheet", "add the panel from the pack".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: 2d-assets
user-invocable: true
allowed-tools: Read Grep Glob Write Edit summer_add_node summer_set_prop summer_set_resource_property summer_inspect_node summer_get_scene_tree summer_import_from_url
paths: ["assets/**", "art/**", "ui/**", "scenes/**"]
---

# instantiate-asset-pack — Instantiate Asset Pack into Scene

A pack ArtAsset (produced by `create-asset-sheet`) is a bundle of cropped slice PNGs with per-slice metadata. This skill is the runtime side: given a pack, lay its slices into the current scene as a correctly-grouped, correctly-layered set of nodes.

For wiring individual widget slices (9-slice panels, progress bars, toggles), this skill delegates to `use-widget-asset`. This skill handles the pack-level layout: grouping composites, paint order, spatial offset, naming.

## When to use

- "Import the dungeon UI pack."
- "Spawn the settings panel from that asset sheet I just made."
- "Bring the whole biome pack into this scene."
- "Add the card frame composite from pack X."
- User has a pack ArtAsset in their library and wants it placed in the scene, not just imported as files.

## When NOT to use

- User wants a single slice → import it directly as a `Sprite2D` (or `use-widget-asset` if it's a UI widget).
- User wants to **generate** a new pack → `create-asset-sheet`.
- User wants to apply a slice as a material/texture on a 3D mesh → not the pack flow; see `asset_pipeline.json`.

## Pack JSON shape

The per-slice fields this skill cares about:

| Field | Used for |
|---|---|
| `name` | Node name |
| `url` | Texture path (after `summer_import_from_url`) |
| `bbox` | Spatial offset of composite children relative to parent |
| `zOrder` | `z_index` on the Sprite2D; sort children by this ascending |
| `isComposite` | Filter out parent slices (flat previews, not runtime assets) |
| `parentSliceIndex` | Group children to their composite parent |
| `pairWith` | Toggle ON/OFF pair link |
| `widget` | Wrap in NinePatchRect / TextureProgressBar via `use-widget-asset` |
| `category` | Decide wrapper type — `ui` → Control tree, else Node2D/Sprite2D |

Legacy fallback: `slice.zOrder ?? slice.layerIndex ?? packFileIndex`, `slice.isComposite ?? slice.isReference ?? false`. `packFileIndex` is the iteration counter when looping `packFiles[]`, not a stored field.

## Standalone child slice

A standalone slice has no `parentSliceIndex` and isn't a composite parent. Spawn as a single `Sprite2D`:

1. Import the slice URL via `summer_import_from_url` to get a `res://` path.
2. `summer_add_node` — type `Sprite2D`, name `slice.name`.
3. `summer_set_prop` — `texture = res://...`.
4. If `slice.zOrder` is set, `summer_set_prop` — `z_index = slice.zOrder`.

If the slice has a `widget` field, hand off to `use-widget-asset` after step 1.

## Composite parent + children

A composite parent (`isComposite: true`) is the flat preview the wizard made of the assembled panel. **Do not spawn it.** Its children — slices whose `parentSliceIndex` points back at it — are the real runtime assets.

Recipe:

1. **Skip the parent.** Filter out `isComposite: true` slices unless the user asked for the flat preview.
2. **Group children.** Collect every slice whose `parentSliceIndex` matches this parent's index.
3. **Sort children by `zOrder` ascending.** Lower zOrder renders behind. Use the legacy fallback chain.
4. **Spawn a `Node2D` parent** named after the composite parent's `name` (e.g. `settings_panel`).
5. **For each child, in sorted order:**
   - Import `child.url` → `res://` path.
   - `summer_add_node` `Sprite2D` under the Node2D, name = `child.name`.
   - `summer_set_prop` — `texture = res://...`.
   - `summer_set_prop` — `z_index = child.zOrder`.
   - `summer_set_prop` — `position = Vector2(child.bbox.x - parent.bbox.x, child.bbox.y - parent.bbox.y)`.
6. **Apply widget post-processing** to any child with a `widget` field — see next section.

## Widget post-processing

When a child slice has `widget.kind` set, the bare Sprite2D is not the right node. Replace or wrap it per the widget mapping:

| widget.kind | Node | Mapping |
|---|---|---|
| `panel`, `button` | `NinePatchRect` | `frameMargins[0..3]` → `patch_margin_left/top/right/bottom` |
| `progress_bar` | `TextureProgressBar` | `fillRect` → `stretch_margin_*`; `orientation` → `fill_mode` |
| `slider` | `HSlider`/`VSlider` + `NinePatchRect` track | track uses `frameMargins`; slider sits on top |
| `toggle` | `TextureRect` | Swap `texture` between this slice and `packFiles[pairWith].url` |

Delegate the actual wiring (percentage-to-pixel conversion, node-specific props) to `use-widget-asset`. This skill places the node; that skill configures the geometry.

## Naming convention

- `slice.name` is canonical. The wizard's classifier produces snake_case names (`play_button`, `health_bar_fill`, `settings_panel`). Use as the node name verbatim.
- If the user said "name them with prefix X" (e.g. "prefix everything with `hud_`"), prepend: `hud_play_button`.
- Composite parent's `name` becomes the `Node2D` wrapper name.
- If a name collides with an existing node in the scene, suffix `_1`, `_2`, etc. Do not silently overwrite.

## Examples

### Example 1 — Standalone slice import

Pack has one non-composite slice, `crate_wooden`, no widget metadata. Place it at scene origin:

```json
{
  "ops": [
    {
      "op": "AddNode",
      "parent": ".",
      "type": "Sprite2D",
      "name": "crate_wooden"
    },
    {
      "op": "SetProp",
      "path": "./crate_wooden",
      "key": "texture",
      "value": "res://assets/images/crate_wooden.png"
    },
    {
      "op": "SetProp",
      "path": "./crate_wooden",
      "key": "position",
      "value": "Vector2(0, 0)"
    },
    { "op": "SaveScene" }
  ]
}
```

### Example 2 — Composite panel with three children

Pack has a composite parent `settings_panel` (filtered out) plus three children:

- `panel_bg` — zOrder 0, bbox offset (0, 0), widget.kind = `panel`, frameMargins present
- `apply_button` — zOrder 1, bbox offset (40, 120), widget.kind = `button`, frameMargins present
- `close_icon` — zOrder 2, bbox offset (220, 8), no widget

```json
{
  "ops": [
    {
      "op": "AddNode",
      "parent": ".",
      "type": "Node2D",
      "name": "settings_panel"
    },
    {
      "op": "AddNode",
      "parent": "./settings_panel",
      "type": "NinePatchRect",
      "name": "panel_bg"
    },
    {
      "op": "SetProp",
      "path": "./settings_panel/panel_bg",
      "key": "texture",
      "value": "res://assets/images/panel_bg.png"
    },
    {
      "op": "SetProp",
      "path": "./settings_panel/panel_bg",
      "key": "z_index",
      "value": 0
    },
    {
      "op": "SetProp",
      "path": "./settings_panel/panel_bg",
      "key": "position",
      "value": "Vector2(0, 0)"
    },
    {
      "op": "AddNode",
      "parent": "./settings_panel",
      "type": "NinePatchRect",
      "name": "apply_button"
    },
    {
      "op": "SetProp",
      "path": "./settings_panel/apply_button",
      "key": "texture",
      "value": "res://assets/images/apply_button.png"
    },
    {
      "op": "SetProp",
      "path": "./settings_panel/apply_button",
      "key": "z_index",
      "value": 1
    },
    {
      "op": "SetProp",
      "path": "./settings_panel/apply_button",
      "key": "position",
      "value": "Vector2(40, 120)"
    },
    {
      "op": "AddNode",
      "parent": "./settings_panel",
      "type": "Sprite2D",
      "name": "close_icon"
    },
    {
      "op": "SetProp",
      "path": "./settings_panel/close_icon",
      "key": "texture",
      "value": "res://assets/images/close_icon.png"
    },
    {
      "op": "SetProp",
      "path": "./settings_panel/close_icon",
      "key": "z_index",
      "value": 2
    },
    {
      "op": "SetProp",
      "path": "./settings_panel/close_icon",
      "key": "position",
      "value": "Vector2(220, 8)"
    },
    { "op": "SaveScene" }
  ]
}
```

After this, hand `panel_bg` and `apply_button` to `use-widget-asset` to set `patch_margin_*` from their `widget.frameMargins`.

Note the ops format: `position` is the **Godot string** `"Vector2(0, 0)"`, not a JSON object. `z_index` is a bare integer. This is the format Summer Engine expects — see `../../references/mcp-tools-reference/mcp-tools-reference.md`.

## Failure modes

- **Old pack with no `zOrder`.** Fall back to `slice.zOrder ?? slice.layerIndex ?? packFileIndex`. `packFileIndex` is the iteration counter when looping `packFiles[]` (not a persisted field). If even `layerIndex` is missing (very old pack), iteration order is the only signal — accept it.
- **Old pack with no `isComposite`.** Fall back to `slice.isComposite ?? slice.isReference ?? false`. If both are missing on every slice, treat the whole pack as standalone — no compositing, every slice spawns at origin as its own Sprite2D.
- **Composite parent with no children in the pack.** The composite preview is the only thing the user has — render the parent as a regular Sprite2D (do not filter it out in this case).
- **Child references a parent that's missing.** Treat the child as standalone. Spawn at `Vector2(0, 0)` with its own `zOrder`.
- **Widget with no `frameMargins`.** The vision detector said `kind: 'panel'` but didn't emit margins. Render as `TextureRect` (or `Sprite2D` if outside a Control tree) and skip 9-slice. Do not invent margins.
- **Name collision in scene.** Suffix `_1`, `_2`, etc. Never overwrite an existing node.
- **Slice URL fails to import.** `summer_import_from_url` returns an error — skip that slice, log a warning, continue with the rest. Do not abort the whole pack.

## Related skills

- `create-asset-sheet` — production side; how the pack was made.
- `use-widget-asset` — wiring an individual widget slice (NinePatchRect, TextureProgressBar geometry).
- `asset_pipeline.json` — broader find-or-generate -> import -> apply flow.
