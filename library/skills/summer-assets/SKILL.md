---
name: summer-assets
description: "Game assets for any engine, no Summer Engine: find, generate and download them."
license: MIT
compatibility: [Cursor, Claude Code, Codex, Windsurf, Gemini, OpenCode, Factory, Copilot]
category: _meta
user-invocable: false
---

# Summer assets without the engine

Use this skill when the session has the Summer **assets profile**: the generation and asset library tools are there, the Summer Engine tools are not (no `summer_get_project_context`, `summer_add_node`, `summer_play` or `summer_screenshot`). The person wants files for their own engine or web app. You deliver files, not scenes.

A call written `area.action({...})` is one operation: use the tool `summer_area_action` when your client lists it, else `summer_call({ op: "area.action", input: {...} })`. `summer_search` finds any operation and its exact input.

## What this session has

| Job | Operations |
|---|---|
| Find how to do it | `summer_docs_search`, then `summer_docs_read` the skill |
| Find an existing asset | `assets.search({ query, scope })` (`scope`: `library` (default), `mine` for the person's own, `all`), then `assets.get({ assetId })` |
| Make a new asset | `assets.generate_image`, `assets.generate_3d`, `assets.generate_audio`, `assets.generate_sfx_choices` with `assets.choices`, `assets.generate_video`, `assets.generate_motion`, `assets.slice_sheet` |
| Wait for a job | `jobs.wait({ jobId, timeoutSeconds: 50 })` with the `job.id` a generation returned |
| Get the file | `out` on the generate call, `jobs.wait` or `assets.get`: the file is saved there and the answer gives `localPath` |
| More generators | `makers.<tool>` (for example `makers.npc_voice`, `makers.trailer_forge`); `summer_search` lists them |

## The loop

1. **Ask what the asset is for**, once, in one message: the engine or app, the file format, the size or scale, the style, how many.
2. **Reuse first.** `assets.search({ scope: "mine" })`, then `assets.search({ query, scope: "all" })`. Generate only when nothing fits.
3. **Read the asset's skill**: sound effect `sound-effect`, music `music-track`, ambience `ambient-bed`, voice `voice-line`, image or style `concept-art`, UI `ui-graphics`, texture `tileable-texture`, sprites `sprite-sheet` or `pixel-art`, sky `skybox-panorama`, 3D prop `prop-model`, character `character-model`, creature or plant `organic-model`, vehicle `vehicle-model`, modular kit `environment-kit`, animation `generate-motion`, video `trailer-shot`. Follow it up to the point where the asset exists. Its **Without Summer Engine** section says where to stop: skip every step that imports the asset into a project or adds nodes to a scene.
4. **Confirm before you spend.** Generation uses the person's Summer credits. `dryRun: true` on the generate call returns the estimate (`credits`, `balance`, `enough`) and makes nothing. Say what you will make and how many versions, and wait for a yes.
5. **Generate, then wait.** 3D, video and animation answer at once with `{ status: "running", job }`: call `jobs.wait` until `finished` is true. Never continue on a running job.
6. **Use the returned id.** `assets.get` with the asset id the finished job's `result` holds. Do not search by name right after a generation.
7. **Check it.** Look at the preview image or thumbnail you received. For audio, the person listens. Describe only what you actually received.
8. **Hand it over.** Pass `out` with the folder the person named (or a file path): on the generate call, on `jobs.wait` for 3D, video and animation, or on `assets.get` for an asset you already have. The file is saved there and the answer gives `localPath`. Without `out`, a file made in a game project lands in its asset folder (Godot `assets/`, Unity `Assets/Summer`, Unreal `Content/Summer`, three.js `public/assets`). Tell the person the path and format. Connected only to Summer's hosted server, there is no `out`: download `downloadUrl` from `assets.get` with your own shell.

## Formats

Each asset is a normal file in the person's Summer library: GLB for 3D models, PNG, JPG or WebP for images, MP3 or WAV for audio, MP4 for video. GLB is Y up. Generated models are not at real-world size: give the person the target size (a door about 2 m, a person about 1.7 m). Tell them if their engine needs a conversion step, and let them choose the tool for it.

## Done means

- The job finished without an error.
- You saw the preview, or the person heard the sound.
- The file is where the person asked, and you told them the path and format.

## Pitfalls

| Pitfall | Do this instead |
|---|---|
| Following an asset skill into its scene steps (`summer_import_asset_by_id`, `summer_add_node`, `AudioStreamPlayer`, `MeshInstance3D`) | Stop at the file. Those tools are not in this session. |
| Generating before you checked the person's own assets | `assets.search({ scope: "mine" })` first |
| Generating the same asset again to get the file | `assets.get` with `out` on the asset you already have |
| Telling the person the asset looks right without a preview | Say what you received, or that no preview came back |
| The person wants a whole game, not assets | Say that this needs Summer Engine and the full setup: `npx -y summer-engine@latest setup <agent> --yes` |

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@latest` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `assets.choices` | `summer assets choices` |
| `assets.generate_3d` | `summer assets generate-3d` |
| `assets.generate_audio` | `summer assets generate-audio` |
| `assets.generate_image` | `summer assets generate-image` |
| `assets.generate_motion` | `summer assets generate-motion` |
| `assets.generate_sfx_choices` | `summer assets generate-sfx-choices` |
| `assets.generate_video` | `summer assets generate-video` |
| `assets.get` | `summer assets get` |
| `assets.search` | `summer assets search` |
| `assets.slice_sheet` | `summer assets slice-sheet` |
| `summer_docs_read` | `summer docs read` |
| `summer_docs_search` | `summer docs search` |
| `summer_add_node` | `summer engine add-node` |
| `summer_get_project_context` | `summer engine get-project-context` |
| `summer_import_asset_by_id` | `summer engine import-asset-by-id` |
| `summer_play` | `summer engine play` |
| `summer_screenshot` | `summer engine screenshot` |
| `jobs.wait` | `summer jobs wait` |
| `makers.npc_voice` | `summer makers npc-voice` |
| `makers.trailer_forge` | `summer makers trailer-forge` |
| `summer_search` | `summer ops search "<what you want>"` |
<!-- /shell-commands -->
