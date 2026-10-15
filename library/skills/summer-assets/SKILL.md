---
name: summer-assets
description: "Make game assets with Summer without Summer Engine: find, generate and download 3D models, images, audio and video for any engine or web app."
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
| Find how to do it | `summer_search_library`, then `summer_read_library` the skill |
| Find an existing asset | `assets.search({ query, scope })` (`scope`: `library` (default), `mine` for the person's own, `all`), then `assets.get({ assetId })` |
| Make a new asset | `assets.generate_image`, `assets.generate_3d`, `assets.generate_audio`, `assets.generate_sfx_choices` with `assets.choices`, `assets.generate_video`, `assets.generate_motion`, `assets.slice_sheet` |
| Wait for a job | `jobs.wait({ jobId, timeoutSeconds: 50 })` with the `job.id` a generation returned |
| Get the file | `assets.get({ assetId })`: `downloadUrl` is the file, `thumbnailUrl` the preview |
| More generators | `makers.<tool>` (for example `makers.npc_voice`, `makers.trailer_forge`); `summer_search` lists them |

## The loop

1. **Ask what the asset is for**, once, in one message: the engine or app, the file format, the size or scale, the style, how many.
2. **Reuse first.** `assets.search({ scope: "mine" })`, then `assets.search({ query, scope: "all" })`. Generate only when nothing fits.
3. **Read the asset's skill**: sound effect `sound-effect`, music `music-track`, ambience `ambient-bed`, voice `voice-line`, image or style `concept-art`, UI `ui-graphics`, texture `tileable-texture`, sprites `sprite-sheet` or `pixel-art`, sky `skybox-panorama`, 3D prop `prop-model`, character `character-model`, creature or plant `organic-model`, vehicle `vehicle-model`, modular kit `environment-kit`, animation `generate-motion`, video `trailer-shot`. Follow it up to the point where the asset exists. Its **Without Summer Engine** section says where to stop: skip every step that imports the asset into a project or adds nodes to a scene.
4. **Confirm before you spend.** Generation uses the person's Summer credits. `dryRun: true` on the generate call returns the estimate (`credits`, `balance`, `enough`) and makes nothing. Say what you will make and how many versions, and wait for a yes.
5. **Generate, then wait.** 3D, video and animation answer at once with `{ status: "running", job }`: call `jobs.wait` until `finished` is true. Never continue on a running job.
6. **Use the returned id.** `assets.get` with the asset id the finished job's `result` holds. Do not search by name right after a generation.
7. **Check it.** Look at the preview image or thumbnail you received. For audio, the person listens. Describe only what you actually received.
8. **Hand it over.** Download `downloadUrl` from `assets.get` with your own shell into the folder the person named, keep a clear file name, and tell them the path and format.

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
| Generating the same asset again to get the file | `assets.get` on the asset you already have; its `downloadUrl` is the file |
| Telling the person the asset looks right without a preview | Say what you received, or that no preview came back |
| The person wants a whole game, not assets | Say that this needs Summer Engine and the full setup: `npx -y summer-engine@latest setup <agent> --yes` |
