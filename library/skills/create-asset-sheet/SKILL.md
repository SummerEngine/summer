---
name: create-asset-sheet
description: Use when the user wants to generate a pack of 2D game assets from a single prompt — a tile sheet, UI kit, menu screen, character pack, or biome set. The skill plans the prompt, generates a coherent sheet, removes the background, vision-detects each item, classifies it, and saves as a single pack ArtAsset. Trigger on "asset sheet", "asset pack", "tile sheet", "tileset", "UI kit", "asset pack for", "make me a sheet of", "generate a bunch of <category> assets".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: 2d-assets
user-invocable: true
allowed-tools: Read Grep Glob Write Edit summer_get_studio_workflow summer_generate_image summer_slice_asset_sheet summer_search_assets summer_import_asset_by_id summer_import_from_url
paths: ["assets/**", "art/**", "sprites/**"]
---

# create-asset-sheet — Generate a coherent pack of 2D assets

This skill turns a single prompt into a categorized pack of isolated, named 2D assets ready to drop into a game. It exists because the alternative — generating each asset one-by-one, then losing visual coherence between them, then manually matting backgrounds in Photoshop — is the most-cited pain point from indie devs working with image models in 2026.

**Pipeline:**

1. **Generate a sheet** of N isolated assets in one image-gen call.
2. **Remove background** (fal/bria) so each asset can stand on its own.
3. **Detect + name + classify** each asset in one vision call (Gemini 3 Pro outputs bbox + snake_case name + category per region).
4. **Crop** each region with sharp.
5. **Optionally upscale** any small slice via fal flux-2/edit i2i, preserving aspect.
6. **Save** as a single pack ArtAsset with `packFiles: [{url, name, type}]` and `metadata.sliceBboxes`.

Categories the classifier outputs (used to route into downstream pipelines):
`character | terrain | nature | lighting | water | decorative | buildings | ui | vfx`

## When to use

- "Make me a Japanese village tileset."
- "Generate a sci-fi UI kit — buttons, panels, icons."
- "I need 12 fantasy props for a dungeon — chest, torch, skeleton, gold, etc."
- "Give me a character pack: 6 cute monsters."
- "Build a forest biome — trees, rocks, plants, ground tiles."

## When NOT to use

- The user wants a **single** asset → `pixel-art` or `character-portrait`.
- The user wants character **animation** (walk cycle, attack frames) → `sprite-sheet`.
- The user wants **3D models** of a planned pack → not yet supported in one shot; loop `concept-art` → image-to-3D per item, or use `asset-strategy` to pick the right path.
- The user wants **terrain tiles that connect seamlessly** (auto-tiling / Wang tiles) → `tileable-texture` is the right home for edge logic; this skill produces standalone tiles, not edge variants.

## The cleanest path: the studio wizard

The fastest, most reliable way to invoke this flow today is the **Create Asset Sheet** wizard in the Summer studio:

```
https://summerengine.com/studio/create-tileset
```

Direct the user there if they're working in the browser. The wizard:

- Offers a 2D / 3D mode toggle (2D is the slice flow described here; 3D is a soft pointer to `concept-art` + per-asset image-to-3D for now)
- Surfaces six prompt templates (tile sheet, UI kit, menu, character pack, biome, freeform)
- Lets the user upload an existing sheet if they have one (skip generation)
- Shows variants in a grid with full-screen lightbox + arrow-key toggling
- Runs the full slice pipeline on click
- Has per-slice HD upscale + bulk "Upscale all"
- Saves as a pack ArtAsset visible in the user's library

If the user is in a chat / agent context, use the programmatic path below. It
now calls the same server-side slicer as the Studio wizard.

## Programmatic path (chat / agent driving the engine)

1. **Load the exact current recipe.** Call
   `summer_get_studio_workflow({workflowId: "asset-pack"})`. Follow its ordered
   steps and report any `manual` handoff instead of pretending it ran.

2. **Generate the sheet.** Call `summer_generate_image` with a prompt like:

   ```
   <theme> asset sheet: <comma-separated list of items>. Each item isolated with empty space around it, transparent or neutral background.
   ```

   - Pick model by style: pixel art → `grok-imagine`, painterly / illustrative / structured grids → `gpt-image-2`.
   - 1024x1024 is the sweet spot. Larger sheets fragment in the slicer when individual assets get below ~64px.
   - Keep the asset list to 6–20 items per sheet. Past 20, model attention degrades and slices get muddy.

3. **Slice, remove background, detect, name, classify, crop, and save.** Pass
   the returned image asset id to:

   ```
   summer_slice_asset_sheet({ assetId: "<generated asset id>" })
   ```

   This is the same cloud slicing pipeline used by the Studio flow. Keep the
   returned slice ids/names/categories; do not reimplement the vision boxes
   locally.

4. **Optional upscale.** For any crop where longest side < 256px, send through fal flux-2/edit i2i with prompt:

   ```
   Recreate this exact <name> at high resolution. Preserve every detail, the exact pose, the exact style. Sharper edges, more detail. Transparent background. Single isolated asset, no scene.
   ```

   - Scale longest side to 1024, preserve aspect ratio (FLUX requires multiples of 32).
   - Don't blindly upscale everything — high-res slices get diminishing returns and you spend $0.04/slice.

5. **Import what the game needs.** Use the returned asset ids with
   `summer_import_asset_by_id`. Keep the source pack in My Assets so the agent
   and the human Studio session see the same result.

## Prompt patterns that work

**Tile sheet (terrain + props + buildings):**

```
<setting> tile sheet: <terrain tiles>, <props>, <buildings>. Each item isolated with empty space around it.
```

**UI kit:**

```
<theme> game UI kit: round button, square button, panel background, slider, toggle switch, progress bar, icon set, banner header.
```

**Menu screen:**

```
<theme> main menu UI: title banner, Start Game button, Settings button, Quit button, <background style>, ornate frame, decorative element.
```

**Character pack:**

```
<theme> character pack, single front-facing frame each: <character 1>, <character 2>, ... <character N>. Each isolated.
```

**Biome:**

```
<biome name> biome assets: <flora>, <terrain features>, <rocks/water/sky elements>. Each item isolated.
```

## Common failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Slicer returns 1 giant bbox covering the whole sheet | Items overlap / no gaps in the source | Re-prompt with "each item fully isolated, empty space around each item". Re-generate. |
| Slicer misses items | Items too small in the source, classifier dropped them as noise | Generate at higher resolution (2048) or with fewer items per sheet |
| Two items merge into one slice | Items touching in the source | Re-prompt with more isolation. Or accept and let the user split manually in step 2's review. |
| Slice has a sliver of neighbor in it | Vision bbox is off by 5–15px | Expected. The slicer pads but doesn't snap-to-content yet. Live with it or upscale the slice (FLUX often cleans the edge) |
| Upscaled slice looks invented | Source was too small / too ambiguous | Don't upscale slices below ~32×32. Or accept the hallucination and edit |
| Detection returns wrong category | Model misjudged context | User can override in the review step; not a blocker |

## What this skill does NOT do (yet)

- Per-asset planning + individual generation (the Codex-style flow where each asset is generated separately at full resolution). The planner endpoint exists (`POST /api/art/plan-asset-pack`) but the per-asset gen loop is not wired into the wizard yet.
- 3D pack assembly. The 3D mode in the wizard is a placeholder pointer to `concept-art` + image-to-3D for now.
- Character animation routing. Once a slice is classified as `character`, the next step (sprite-sheet generation) is a separate skill that the user has to invoke manually. Auto-routing is on the roadmap.
- Terrain auto-tiling / Wang-tile generation. Use `tileable-texture` for that.
- Level composition / scene assembly. Use `design-level`.

## Honest cost estimate

Per 12-asset sheet, end to end through the wizard:

- Generate sheet: $0.04–0.10 (varies by model)
- Background removal: $0.05
- Vision detect + classify: $0.02–0.03
- Save pack: free
- Optional bulk upscale: ~$0.04 per slice ($0.48 for 12)

**Without upscale:** ~$0.12. **With full upscale:** ~$0.60. About a third of what a Photoshop hour would cost.
