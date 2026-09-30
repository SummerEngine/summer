---
name: game-ui
description: "Build layered, shipped-quality game UI in Summer: shadow, outline, lip, gradient face, gloss; states, motion, generated icons, Compatibility-safe."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: ui
user-invocable: true
allowed-tools: Read Grep Glob Edit Write summer_get_script_errors
paths: ["**/*.gd", "**/*.gdshader", "**/*.tscn"]
---

# Layered game UI in Summer

Flat UI looks wrong in games because every real game element is a small stack of layers:
light comes from above, edges are inked, and pressable things have a visible side. A Godot
`StyleBoxFlat` gives you one fill and one border, so it can't draw that stack. Build the
stack yourself, once, and route every panel, button, chip and bar through it.

## 1. The layer stack (back to front)

| # | Layer | Why |
|---|---|---|
| 1 | Drop shadow (offset down, 20-30% black, optional second softer ring) | Lifts the element off the busy 3D world |
| 2 | Dark outline, 3-5 px, warm dark brown (not black) | Readable silhouette at phone size; cartoon inking |
| 3 | Lip: a darker copy of the face, visible 4-8 px under it | The "side" of the key: says *pressable* |
| 4 | Face: vertical gradient, top ~20% lighter than bottom | Top light; flat fills read as disabled |
| 5 | Texture grain at low alpha (wood, paper), optional | Material richness without losing crispness |
| 6 | Frame inset (big panels only): recessed inner panel + a dark gradient under its top edge | Panels feel like carved boards holding paper |
| 7 | Gloss band: white 25-40% → ~0% over the top 40-50% of the face | Candy shine; the Supercell signature |
| 8 | Top highlight line, 2 px white ~60% | Crisp bevel edge |
| 9 | Icon (painted), then text with a thick outline + hard drop shadow | Content sits on the plate and stays readable anywhere |

Pressed state = the same plate with the lip shrunk to ~35% and the face moved down by the
difference (`sink`), plus a 0.93 squash tween. Disabled = the grey plate with less gloss.
Hover = the face tinted +8%. Focus (gamepad) = a separate thick white/gold ring *outside* the
plate. Never show focus with color alone.

## 2. Minimal layered button (drop-in)

A GDScript `StyleBox` can draw anything in `_draw`. Rounded polygons with per-vertex colors
give real gradients, stay vector-crisp at every resolution, and need no shader, so they work on
the Compatibility renderer and on phones.

```gdscript
# layered_plate.gd
extends StyleBox
@export var radius := 20.0
@export var face := Color("5fd04a")
@export var lip := Color("2c8a25")
@export var outline := Color("1f3d14")
@export var depth := 6.0
@export var sink := 0.0

func _draw(ci: RID, r: Rect2) -> void:
	_poly(ci, _rr(Rect2(r.position + Vector2(0, depth), r.size), radius), [Color(0, 0, 0, 0.25)])  # shadow
	_poly(ci, _rr(r, radius), [outline])                                                        # outline
	var inner := r.grow(-3.0)
	_poly(ci, _rr(inner, radius - 3.0), [lip])                                                  # lip
	var f := Rect2(inner.position + Vector2(0, sink), inner.size - Vector2(0, depth + sink))
	var pts := _rr(f, radius - 3.0)
	var cols := PackedColorArray()
	for p in pts:                                                                               # gradient face
		cols.append(face.lightened(0.22).lerp(face, (p.y - f.position.y) / f.size.y))
	RenderingServer.canvas_item_add_polygon(ci, pts, cols)
	var g := Rect2(f.position + Vector2(5, 3), Vector2(f.size.x - 10, f.size.y * 0.45))
	var gp := _rr(g, radius - 6.0)                                                              # gloss
	var gc := PackedColorArray()
	for p in gp:
		gc.append(Color(1, 1, 1, lerpf(0.35, 0.04, (p.y - g.position.y) / g.size.y)))
	RenderingServer.canvas_item_add_polygon(ci, gp, gc)

func _poly(ci: RID, pts: PackedVector2Array, c: Array) -> void:
	RenderingServer.canvas_item_add_polygon(ci, pts, PackedColorArray(c))

static func _rr(r: Rect2, rad: float) -> PackedVector2Array:
	rad = clampf(rad, 0.0, minf(r.size.x, r.size.y) * 0.5)
	var out := PackedVector2Array()
	var cs := [Vector2(r.end.x - rad, r.position.y + rad), Vector2(r.end.x - rad, r.end.y - rad),
		Vector2(r.position.x + rad, r.end.y - rad), Vector2(r.position.x + rad, r.position.y + rad)]
	for i in 4:
		for k in 7:
			var a := -PI / 2 + PI / 2 * i + PI / 2 * k / 6.0
			var p: Vector2 = cs[i] + Vector2(cos(a), sin(a)) * rad
			if out.is_empty() or p.distance_squared_to(out[-1]) > 0.01:  # pills repeat points
				out.append(p)
	return out
```

```gdscript
var normal := preload("res://ui/layered_plate.gd").new()
normal.content_margin_left = 18; normal.content_margin_right = 18
normal.content_margin_top = 10; normal.content_margin_bottom = 16  # + depth
var pressed := normal.duplicate()          # works because the fields are @export
pressed.depth = 2.0; pressed.sink = 4.0; pressed.content_margin_top = 14; pressed.content_margin_bottom = 12
button.add_theme_stylebox_override("normal", normal)
button.add_theme_stylebox_override("pressed", pressed)
button.add_theme_constant_override("outline_size", 8)          # text outline
button.add_theme_color_override("font_outline_color", normal.lip.darkened(0.45))
```

A production version adds texture grain, a frame inset for big panels, glow and a highlight line. Keep the
presets (buttons, chips, bars, wood frame, banner, glass disc) in one theme script so every panel shares them.

## 3. Rules that make it read as a game

- **Type:** a chunky sans at weight 800 for numbers and labels, and a display face for titles.
  Anything placed over the world gets an outline of about 25% of the font size plus a hard
  shadow of 2-4 px straight down. Use abbreviated numbers (1.2K, 3.4M) and show the exact value
  on hover, focus or long-press, never on hover only.
- **Color roles** (keep them consistent everywhere): green = confirm/primary, gold = currency
  and rewards, blue = secondary/info, red = close/danger, white = neutral toggles,
  grey = locked/disabled. Rarity is always a color plus a written word (plus a gem shape),
  never color alone.
- **Hierarchy:** one loud thing per panel (the primary button or the reward). Everything else
  uses light plates with ink text.
- **Spacing and targets:** touch targets are at least 64 px on a 1600x900 canvas. Keep 12-18 px
  between plates. Apply the display safe area on mobile, and use it only there, because desktop
  "safe area" means the screen, not the window.
- **Resource bars:** use a dark glass pill with white outlined numbers and the currency icon
  hanging over its left end. It reads on any sky or grass.
- **Motion:** pop panels in (scale 0.86 → 1 with TRANS_BACK, about 0.3 s). Squash buttons on
  press. Roll number counters toward their target instead of snapping. Fly coins from the
  source to the counter, then pop the counter. Show a sunburst behind rewards. Add a reduce-motion
  toggle that turns all of this off.
- **Icons:** painted, and keyed by content id so content additions light up automatically.
  Keep a vector fallback so nothing is ever blank.

## 4. Asset pipeline (generated art)

1. Put the npm cache on the external drive:
   `export npm_config_cache=<external>/npm`.
2. Generate one sheet per family, not one image per icon:
   `npx -y summer-engine@latest tool generate-image --args '{"prompt": "...", "style": "cartoon", "removeBackground": true}'`.
   - Name every cell explicitly: "A strict 3 by 3 grid ... Row 1 left to right: ...".
   - Repeat the same style sentence in every prompt: glossy cartoon mobile-game icon, thick dark
     brown outline, top highlight, no text, plain white background.
   - A 3x3 or 4x3 grid at about 900 px gives 200-250 px per icon, which is enough for a 40-120 px
     UI. That covers about 100 icons for 13 generations (about $1.20).
3. Slice locally: take the connected components of the alpha, group them by the grid cell of
   each centroid (so glows and sparkles stay with their icon), trim, and pad to a square. Name
   each file by its content id.
4. Tileable textures (wood, paper) go without background removal and are drawn tiled at 50-60%
   alpha under the gradient, not as the whole look.
5. Import once headless (`--headless --import`). Then set `mipmaps/generate=true` in the
   `.import` files and import again. Use `TEXTURE_FILTER_LINEAR_WITH_MIPMAPS` on icon nodes,
   because a 256 px icon shown at 48 px shimmers without mipmaps.
6. Write `SOURCES.md` next to the art: tool, date, exact prompt, model, asset id, cost and output files per generation. Save the request JSON at generation time; the service response does not echo the prompt.

Stop and report if the CLI needs a login. Don't go looking for keys.

## 5. Don'ts

- Don't cast theme styles to `StyleBoxFlat` in call sites. Tint or press styles through
  helpers (`tint()`, `pressed_of()`), so swapping the renderer of a plate never breaks a panel.
- Don't use `var` (non-exported) fields in a custom StyleBox: `duplicate()` silently drops them.
- Don't put decoration nodes directly in containers. A `PanelContainer` lays out every child.
  Hang ornaments off a zero-size holder `Control`, and use `show_behind_parent` for glows.
- Don't generate 9-slice frames. AI frames rarely slice cleanly; draw frames procedurally and
  generate only textures, icons and ornaments.
- Don't shrink icons into flat vector circles because generation feels slow. A sheet takes
  about 10 s.

## 6. Compatibility and headless checks

- Plates use only `canvas_item_add_polygon` / `add_polyline`: no shaders or SDF, so they
  render the same on Forward+, Mobile and Compatibility.
- Degenerate polygons (pill radius = half the height, zero corners) log "triangulation failed".
  Dedupe consecutive points.
- Headless clients: guard `DisplayServer` calls (`DisplayServer.get_name() == "headless"`) and
  cache per-frame lookups such as key labels.
- Prove the look in the running game. Capture with `--summer-offscreen`, one engine at a time,
  and read every PNG. Also check the log for `SCRIPT ERROR` and `ERROR:`, because exit 0 is not
  proof.
