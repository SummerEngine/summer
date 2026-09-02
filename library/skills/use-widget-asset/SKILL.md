---
name: use-widget-asset
description: Use when consuming a widget slice (panel, button, slider, progress bar, or toggle pair) from a `create-asset-sheet` pack in a Summer Engine scene. The pack's metadata.sliceMeta carries 9-slice margins, fill rects, and on/off pair links per slice. This skill explains how to wire those into NinePatchRect, TextureProgressBar, or TextureRect so the asset behaves like a real UI control instead of a static texture.
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: 2d-assets
user-invocable: true
allowed-tools: Read Grep Glob Write Edit summer_add_node summer_set_prop summer_set_resource_property summer_inspect_node summer_get_scene_tree
paths: ["assets/**", "art/**", "ui/**", "scenes/**"]
---

# use-widget-asset — Wire a sliced widget into a Summer Engine control

When the `create-asset-sheet` wizard sees a stretchable UI element (a panel, a slider, a progress bar, a toggle), it returns more than a flat PNG. It returns geometry: **9-slice frame margins** for stretchable rectangles, and a **fill rect** for value-driven widgets. It also pairs ON/OFF toggle slices via `pairWith`. This skill is the runtime side: how to read that metadata and wire the asset into the right Summer Engine node.

If a slice has no widget metadata, treat it as a static texture (`TextureRect`) and skip this skill.

## Shape support (read first)

The single rule that governs everything below:

> **9-slice for any AABB-fitting stretchable widget. Static texture for everything else.**

Concrete:

| Shape | Approach | Why |
|---|---|---|
| Rectangle (panel, button, bar, frame) | `NinePatchRect` with `frameMargins` | 4 corners stay fixed, 4 edges stretch on one axis, center stretches both. Standard 9-slice. |
| Rounded rectangle | `NinePatchRect` with `frameMargins` | Corner radii live inside the fixed corner cells. Identical to plain rectangle. |
| Circle / ellipse (round button, gem) | Static `TextureRect`, scale uniformly | No edge to stretch — the shape has no "interior to grow." |
| Diamond / hexagon (badge) | Either ship at multiple sizes OR static texture, scale uniformly | 9-slice would distort the angled corners. SDF would solve it but is overkill for this pipeline. |
| Diagonal banner | `NinePatchRect`, accept some distortion | Slopes sit in the fixed corner cells; horizontal middle stretches. Looks fine if not stretched aggressively. |
| Organic shape (scroll, ribbon, painted sash) | Static `TextureRect` | Not stretchable in any direction. Regenerate at the target size if you need a different one. |

The wizard's vision detector only emits `widget` metadata for the 5 kinds it knows how to slice (slider, progress_bar, toggle, panel, button). Anything else lands as a static `category: ui` slice with no `widget` field — fall through to "render as TextureRect" and skip the rest of this skill.

## What the pack hands you

The wizard saves the pack as a single ArtAsset with:

```
isPack: true
packFiles: [{ url, name, type: "image/png" }, ...]
metadata.sliceBboxes: { "0": {x,y,w,h}, "1": ... }  // source-sheet coords
metadata.sliceMeta:   { "0": { category, widget?, pairWith?, parentSliceIndex? }, ... }
```

`widget` looks like:

```
{
  kind: "slider" | "progress_bar" | "toggle" | "panel" | "button",
  frameMargins: [leftPct, topPct, rightPct, bottomPct],   // optional
  fillRect:    [xPct, yPct, wPct, hPct],                  // optional
  orientation: "horizontal" | "vertical",                 // optional
  pairCandidate: boolean                                  // optional
}
```

Margins and rect are **percentages of the SLICE's own pixel dimensions** (not the source sheet). Convert to pixels with `Math.round(pct * sliceWidth / 100)` before applying to a Summer Engine node.

## Decision tree

```
kind?
  ├─ "panel" or "button"
  │     └─ NinePatchRect, set patch_margin_* from frameMargins
  ├─ "slider"
  │     └─ HSlider/VSlider with two TextureRects underneath: track + fill
  ├─ "progress_bar"
  │     └─ TextureProgressBar with texture_under = 9-slice frame,
  │        texture_progress = cropped fill region
  └─ "toggle"
        └─ TextureRect that swaps texture between on/off via pairWith
```

## Recipes

### 1. Panel — NinePatchRect

```gdscript
extends NinePatchRect

@export var slice_url: String
@export var frame_margins: Array  # [L, T, R, B] in percentage
@export var slice_size: Vector2   # the slice's pixel dimensions

func _ready():
    texture = load(slice_url)
    var w = slice_size.x
    var h = slice_size.y
    patch_margin_left   = int(round(frame_margins[0] * w / 100.0))
    patch_margin_top    = int(round(frame_margins[1] * h / 100.0))
    patch_margin_right  = int(round(frame_margins[2] * w / 100.0))
    patch_margin_bottom = int(round(frame_margins[3] * h / 100.0))
```

When the NinePatchRect is sized larger than the source, corners stay fixed, edges stretch on one axis, center stretches both. This is exactly the behavior the wizard's widget detection assumes.

### 2. Progress bar — TextureProgressBar (fill_mode = FILL_LEFT_TO_RIGHT)

```gdscript
extends TextureProgressBar

@export var slice_url: String          # The full bar (frame + fill at 100%)
@export var fill_rect: Array           # [x, y, w, h] in percentage
@export var orientation: String = "horizontal"

func _ready():
    var tex = load(slice_url)
    # The base / "under" texture is the same image — Godot will mask it
    # to whatever value 0-100 we set.
    texture_under  = tex
    texture_progress = tex
    fill_mode = TextureProgressBar.FILL_LEFT_TO_RIGHT if orientation == "horizontal" else TextureProgressBar.FILL_TOP_TO_BOTTOM
    # The fill rect tells Godot which sub-region of the texture is the
    # bar fill (vs the frame). Texture_progress_offset + stretch_margin_*
    # form the inset.
    var sw = tex.get_width()
    var sh = tex.get_height()
    var fx = int(round(fill_rect[0] * sw / 100.0))
    var fy = int(round(fill_rect[1] * sh / 100.0))
    var fw = int(round(fill_rect[2] * sw / 100.0))
    var fh = int(round(fill_rect[3] * sh / 100.0))
    stretch_margin_left   = fx
    stretch_margin_top    = fy
    stretch_margin_right  = sw - (fx + fw)
    stretch_margin_bottom = sh - (fy + fh)
```

Set `value` from 0 to 100 to drive the bar.

### 3. Slider — HSlider with TextureRect overlays

`Slider` in Summer Engine is a behavioral node (drag input + value range); it
does not ship visuals on its own. Combine it with two `TextureRect`s underneath:
one for the track and one for the knob.

Simplest wiring: NinePatchRect for the track using `frameMargins`, an HSlider on top with `flat = true` and `theme_override_styles/grabber_area = null`, and a child `TextureRect` for the knob positioned via `slider.ratio`.

### 4. Toggle — TextureRect that swaps texture via pairWith

```gdscript
extends TextureRect

@export var on_url: String   # The slice with name ending in "_on"
@export var off_url: String  # The pair's URL (sliceMeta.pairWith)

var _state := false

func set_state(on: bool) -> void:
    _state = on
    texture = load(on_url if on else off_url)

func _ready():
    texture = load(off_url)
```

In the pack, find the pair: `sliceMeta[currentIndex].pairWith` gives the other slice's index; look it up in `packFiles[pairIndex].url`.

## Cut-offs and re-renders

If the detected `frameMargins` are obviously wrong (the dashed overlay in the wizard's lightbox shows the center area clipping into a corner ornament), the user should hit **Recreate (HD)** on that slice. FLUX will regenerate it cleanly — but the *margins themselves* don't get re-detected after upscale. Margins live on the original detection. The user can also manually edit them in code via the `patch_margin_*` properties after instantiating.

## Composite panels with sub-elements

When a slice has `parentSliceIndex` set, it came from a **Break-down** pass — the parent is a composite (settings panel, card frame) and this slice is one of its sub-elements (Apply button, slider, toggle). Use either:

- The whole parent as a single `NinePatchRect` for the frame, OR
- Instantiate each sub-element individually positioned where the original panel had them (the parent's `sliceBboxes[parentSliceIndex]` gives the source-sheet rect; each sub-slice's relative position within it is recoverable from its own bbox).

Pick based on whether your game needs the panel to stretch as one unit or whether each control needs independent interaction.

See **Composite Panels (Sliced Further)** below for the canonical fields the wizard now emits (`isComposite`, `zOrder`) and the consume recipe.

## Composite Panels (Sliced Further)

The wizard's Break-down pass produces two new per-slice fields the runtime must understand:

| Field | Type | Meaning |
|---|---|---|
| `isComposite` | boolean | True on the **parent** slice — the flat preview image of the assembled panel. NOT a runtime asset. Filter it out on import unless the caller explicitly wants the preview thumbnail. |
| `zOrder` | number | Back-to-front paint order on children. Lower = behind. Matches Godot `z_index`, Unity `sortingOrder`, CSS `z-index`. |
| `parentSliceIndex` | number | Set on each child, points at the composite parent. Used to group children. |

The table above lists every field this skill reads; treat any other field in the pack manifest as opaque.

### Consume recipe

1. **Filter out composite parents.** Drop any slice with `isComposite: true` unless the caller specifically asked for the flat preview.
2. **Group by `parentSliceIndex`.** Slices that share a `parentSliceIndex` belong to the same composite group. Slices without it are standalone.
3. **Sort each group by `zOrder` ascending.** Lower values render behind higher values. This determines paint order.
4. **Spawn `Node2D` parent + `Sprite2D` children.** Name the parent after the original composite parent's slice name. For each child:
   - `name = child.name`
   - `texture = imported res:// path`
   - `z_index = child.zOrder`
   - `position = Vector2(child.bbox.x - parent.bbox.x, child.bbox.y - parent.bbox.y)` — offset relative to the parent's source-sheet rect.
5. **Apply widget post-processing.** If any child has a `widget` field, wrap or replace its `Sprite2D` with the appropriate Control node per the recipes above (panel → `NinePatchRect`, progress_bar → `TextureProgressBar`, etc.).

For the full instantiation flow (op JSON, examples), use `instantiate-asset-pack`.

### Legacy compatibility

Older packs (saved before the rename) used different field names. Always fall back:

```
const zOrder      = slice.zOrder      ?? slice.layerIndex   ?? packFileIndex;
const isComposite = slice.isComposite ?? slice.isReference  ?? false;
```

`packFileIndex` is the slice's iteration position in `packFiles[]` (the loop counter, not a persisted field). On packs with no `zOrder` and no `layerIndex` at all, iteration order is the only signal you get — accept it and move on.

Check `metadata.schemaVersion` on the pack: `null` (or absent) = legacy, `1` = current. New packs from the wizard always set it.

## What this skill does NOT cover

- Auto-tiling terrain (Wang / 47-tile). Different format entirely — see `tileable-texture`.
- Animated UI (button press-down sprites, hover glow). The wizard captures static frames; for animation see `sprite-sheet`.
- Non-AABB widgets in the 9-slice path. See the **Shape support** table at the top — for circles, hexagons, organic shapes, fall through to `TextureRect` and skip 9-slice entirely.
