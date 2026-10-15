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

## What this session has

| Job | Tools |
|---|---|
| Find how to do it | `summer_search_library`, then `summer_read_library` the skill |
| Find an existing asset | `summer_list_my_assets` (the person's own), `summer_search_assets` (`source`: `library`, `my_assets` or `all`), `summer_get_asset` |
| Make a new asset | `summer_generate_image`, `summer_generate_3d`, `summer_generate_audio`, `summer_generate_sfx_choices` with `summer_get_choices`, `summer_generate_video`, `summer_generate_motion`, `summer_slice_asset_sheet` |
| Wait for a job | `summer_check_job` with the `jobId` a generation returned |
| Get the file | `summer_get_asset_download_url` (`role`: `primary` or `thumbnail`) |
| More generators | the `summer_tool_*` tools; they load after `summer login`. If they are missing, call `summer_store_tools` to see why |

## The loop

1. **Ask what the asset is for**, once, in one message: the engine or app, the file format, the size or scale, the style, how many.
2. **Reuse first.** `summer_list_my_assets`, then `summer_search_assets`. Generate only when nothing fits.
3. **Read the asset's skill**: sound effect `sound-effect`, music `music-track`, ambience `ambient-bed`, voice `voice-line`, image or style `concept-art`, UI `ui-graphics`, texture `tileable-texture`, sprites `sprite-sheet` or `pixel-art`, sky `skybox-panorama`, 3D prop `prop-model`, character `character-model`, creature or plant `organic-model`, vehicle `vehicle-model`, modular kit `environment-kit`, animation `generate-motion`, video `trailer-shot`. Follow it up to the point where the asset exists. Its **Without Summer Engine** section says where to stop: skip every step that imports the asset into a project or adds nodes to a scene.
4. **Confirm before you spend.** Generation uses the person's Summer credits. Say what you will make and how many versions, and wait for a yes.
5. **Generate, then wait.** A long job returns a `jobId`: call `summer_check_job` until the state is terminal. Never continue on a pending job.
6. **Use the returned id.** `summer_get_asset` with the asset id the job returned. Do not search by name right after a generation.
7. **Check it.** Look at the preview image or thumbnail you received. For audio, the person listens. Describe only what you actually received.
8. **Hand it over.** `summer_generate_image` saves the file itself when you pass `out` (a folder or a file path). For everything else, `summer_get_asset_download_url` returns a link to the file: download it with your own shell into the folder the person named, keep a clear file name, and tell them the path and format.

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
| Generating before you checked the person's own assets | `summer_list_my_assets` first |
| Generating the same asset again to get the file | `summer_get_asset_download_url` on the asset you already have |
| Telling the person the asset looks right without a preview | Say what you received, or that no preview came back |
| The person wants a whole game, not assets | Say that this needs Summer Engine and the full setup: `npx -y summer-engine@latest setup <agent> --yes` |
