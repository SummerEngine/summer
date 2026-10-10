---
name: compatibility-renderer-traps
description: "Make a Forward+ Summer game also look right on the Compatibility renderer: instance-uniform budget, black MultiMesh colors, sRGB vertex colors."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: rendering-and-lighting
user-invocable: true
allowed-tools: Read Grep Glob Edit Write summer_project_setting summer_get_script_errors
paths: ["**/*.gdshader", "**/*.gdshaderinc", "**/*.gd", "project.godot"]
---

# Forward+ and Compatibility without surprises

Games built on Forward+ can end up on the Compatibility renderer (OpenGL): phones where Metal/Vulkan is
unavailable, weak GPUs, or a project that picks it for battery. The failures are silent: no error, just
black fruit, pale colors, or objects that stop animating after the first few hundred. Each trap below
comes with its fix and the reason.

## 1. Know which renderer you actually got

- Phones use `rendering/renderer/rendering_method.mobile`, which defaults to `mobile`, not Forward+.
  Set it explicitly.
- A device can fall back to another renderer when it lacks a capability. Trust the renderer name printed
  at startup (or `RenderingServer.get_current_rendering_method()`), not the project setting.
- Preview Compatibility on your computer:
  `<summer> --path . --rendering-method gl_compatibility`.

## 2. The traps

| Symptom on Compatibility | Cause | Fix |
|---|---|---|
| Objects past roughly the 250th stop growing, lose color or read as default | GLES3 reserves 16 `instance uniform` slots per instance out of 4096, so only about 256 instances in the whole scene can use them. Beyond that, values silently read 0. | Don't use `instance uniform` for anything numerous. Put per-instance state in a one-instance MultiMesh's `INSTANCE_CUSTOM` (a vec4), or bake it into mesh vertex colors. |
| Fruit/flowers render solid black | GLES3 multiplies `COLOR` by the MultiMesh instance color, which is 0 when `use_colors` is off. | Enable `use_colors` and set every instance color to white, or don't read `COLOR` in that path. |
| Everything looks pastel on Forward+ (saturated on Compatibility) | Forward+ shades in linear space, Compatibility in sRGB. Colors you bake into vertex `COLOR` or hard-code into `ALBEDO` are usually sRGB. | Convert once, only where needed: `if (!OUTPUT_IS_SRGB) col = to_linear(col);` with the helper below (the shading language has no built-in `srgb_to_linear`). Or pass colors as `uniform vec3 c : source_color`, which converts for you. |
| Whole scene pale/lime on Compatibility while Forward+ looks right | Tonemap, glow and ambient respond differently. | Keep a Compatibility branch of your lighting profile (lower ambient and exposure) and check both. |
| Foliage glows white | Glow threshold too low for bright leaves. | Raise the glow HDR threshold (~1.5) and keep bloom near 0. |

Everything the player must see (ripe crop, enemy, pickup) must stay readable without glow, SSR,
volumetric fog or other Forward+-only effects: use shape, color and icons too.

The helper (standard sRGB curve):

```glsl
vec3 to_linear(vec3 c) {
	return mix(pow((c + vec3(0.055)) * (1.0 / 1.055), vec3(2.4)), c * (1.0 / 12.92), lessThan(c, vec3(0.04045)));
}
```

## 3. Keep one shader path

Write shaders in plain spatial math: vertex-color ramps, simple rim terms, no custom `light()` unless
you test it on both renderers. One path for both renderers means one set of bugs and no drift.

## 4. Verify, don't assume

1. Render the same scene on Forward+ and `gl_compatibility` offscreen:
   `<summer> --audio-driver Dummy --summer-offscreen --path . --resolution 1600x900 -s res://tools/capture.gd -- --out=<dir>`
   (add `--rendering-method gl_compatibility` for the second run).
2. Read both images side by side, and include a stress shot with many instances (the 256 limit only shows
   at scale).
3. Grep the log for `SCRIPT ERROR`, `SHADER ERROR` and `ERROR:`. A shader that fails to compile still lets
   the capture exit 0 and draws the object untextured, so a missing grep hides the failure.
4. If later captures repeat the same frame, the offscreen run froze (it happens when another engine
   renders at the same time). Check with `md5 -r *.png` and rerun alone.

## Common mistakes

- Checking only the project setting and calling it "Forward+ on phones".
- Using `instance uniform` for per-plant or per-tile state.
- Reading `COLOR` from a MultiMesh without instance colors.
- Testing Compatibility with ten objects when the game shows five hundred.
- Budgeting one run per fix: every look change needs two captures (one per renderer). Plan runs in pairs.

## See also

- `web-compatibility-look` (a finished look when the game only runs on Compatibility, as on the web)
- `3d-lighting` (lighting profiles)
- `bounded-engine-runs` (safe offscreen capture runs)
