---
name: create-asset-sheet
description: "Generate a pack of 2D assets from one prompt (tile sheet, UI kit, character pack, biome), sliced."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: 2d-assets
user-invocable: true
allowed-tools: Read Grep Glob Write Edit summer_assets_generate_image summer_assets_slice_sheet summer_assets_search summer_import_asset_by_id summer_import_from_url summer_import_from_url_batch summer_call
paths: ["assets/**", "art/**", "sprites/**"]
---

# create-asset-sheet — Generate a coherent pack of 2D assets

This skill turns a single prompt into a categorized pack of isolated, named 2D assets ready to drop into a game. Generating assets one by one loses visual coherence between them and leaves you matting backgrounds by hand; one sheet keeps the pack consistent.

**Pipeline:**

1. **Generate a sheet** of N isolated assets in one image-gen call.
2. **Remove the background** so each asset can stand on its own.
3. **Detect, name and classify** each asset in one vision pass (bounding box + snake_case name + category per region).
4. **Crop** each region.
5. **Optionally upscale** any small slice, preserving aspect.
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

The most reliable way to run this flow is the **Create Asset Sheet** wizard in Summer Studio's guided workflows. Open it for the user with `summer open workflows` (or `studio.open`) if they're working in the browser. The wizard:

- Offers a 2D / 3D mode toggle (2D is the slice flow described here; 3D is a soft pointer to `concept-art` + per-asset image-to-3D for now)
- Surfaces six prompt templates (tile sheet, UI kit, menu, character pack, biome, freeform)
- Lets the user upload an existing sheet if they have one (skip generation)
- Shows variants in a grid with full-screen lightbox + arrow-key toggling
- Runs the full slice pipeline on click
- Has per-slice HD upscale + bulk "Upscale all"
- Saves as a pack ArtAsset visible in the user's library

If the user is in a chat / agent context, use the programmatic path below. It
calls the same server-side slicer as the Studio wizard.

## Programmatic path (chat / agent driving the engine)

1. **Load the exact current recipe.** Call
   `summer_call({op: "docs.workflows", input: {workflowId: "asset-pack"}})`. Follow its ordered
   steps and report any `manual` handoff instead of pretending it ran.

2. **Generate the sheet.** Call `assets.generate_image` with a prompt like:

   ```
   <theme> asset sheet: <comma-separated list of items>. Each item isolated with empty space around it, transparent or neutral background.
   ```

   - Pick model by style: pixel art → `grok-imagine`, painterly / illustrative / structured grids → `gpt-image-2`.
   - Square (`aspectRatio: "1:1"`, the default, about 1024x1024) is the sweet spot. Larger sheets fragment in the slicer when individual assets get below ~64px.
   - Keep the asset list to 6–20 items per sheet. Past 20, model attention degrades and slices get muddy.

3. **Slice, remove background, detect, name, classify, crop, and save.** Pass
   the returned image asset id to:

   ```
   assets.slice_sheet({ assetId: "<generated asset id>" })
   ```

   This is the same cloud slicing pipeline used by the Studio flow. It answers
   `slices` (each with `url`, `name`, `category`, `bbox`) and `source`; keep the
   names and categories, and do not reimplement the vision boxes locally. Slicing
   spends credits: `dryRun: true` shows how many.

4. **Optional upscale.** The Studio wizard has per-slice HD upscale. Over MCP, for any crop where the longest side is under 256px, call `assets.generate_image` with the slice `url` as `referenceImageUrl` and this prompt:

   ```
   Recreate this exact <name> at high resolution. Preserve every detail, the exact pose, the exact style. Sharper edges, more detail. Transparent background. Single isolated asset, no scene.
   ```

   - Don't upscale everything: each upscale is a paid generation, and large slices gain little.

5. **Import what the game needs.** The slices are image URLs, not assets: import
   them with `summer_import_from_url_batch` (upscaled ones by their `assetId` with
   `summer_import_asset_by_id`). Keep the source pack in My Assets so the agent
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
| Slice has a sliver of neighbor in it | Vision bbox is off by 5–15px | Expected. The slicer pads but doesn't snap-to-content yet. Live with it or upscale the slice (upscaling often cleans the edge) |
| Upscaled slice looks invented | Source was too small / too ambiguous | Don't upscale slices below ~32×32. Or accept the hallucination and edit |
| Detection returns wrong category | Model misjudged context | User can override in the review step; not a blocker |

## Without Summer Engine

In a session without Summer Engine tools (the assets profile; the `summer-assets` skill has the whole loop), the studio wizard path works as written. On the programmatic path, stop after `assets.slice_sheet` and skip `summer_import_asset_by_id`: save each piece where the person asked with `assets.get` and `out` (the `summer-assets` skill says how), and tell them the paths.

## What this skill does NOT do (yet)

- Per-asset planning and individual generation, where each asset is generated separately at full resolution.
- 3D pack assembly. The 3D mode in the wizard is a placeholder pointer to `concept-art` + image-to-3D for now.
- Character animation routing. Once a slice is classified as `character`, the next step (sprite-sheet generation) is a separate skill that the user has to invoke manually.
- Terrain auto-tiling / Wang-tile generation. Use `tileable-texture` for that.
- Level composition / scene assembly. Use `design-level`.

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@latest` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `assets.generate_image`, `summer_assets_generate_image` | `summer assets generate-image` |
| `assets.get` | `summer assets get` |
| `summer_assets_search` | `summer assets search` |
| `assets.slice_sheet`, `summer_assets_slice_sheet` | `summer assets slice-sheet` |
| `docs.workflows` | `summer docs workflows` |
| `summer_import_asset_by_id` | `summer engine import-asset-by-id` |
| `summer_import_from_url` | `summer engine import-from-url` |
| `summer_import_from_url_batch` | `summer engine import-from-url-batch` |
| `studio.open` | `summer studio open` |
<!-- /shell-commands -->
