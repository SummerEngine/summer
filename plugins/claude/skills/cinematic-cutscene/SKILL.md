---
name: cinematic-cutscene
description: "Generate a non-interactive cutscene: a reference-locked 5-10s video shot with optional voiced dialogue."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: video
user-invocable: true
allowed-tools: Read Grep Glob Write Edit summer_assets_generate_video summer_jobs_wait summer_assets_generate_image summer_assets_generate_audio summer_assets_search summer_import_from_url summer_add_node summer_set_prop summer_call
paths: ["assets/video/**", "cinematics/**", "trailers/**"]
---

# cinematic-cutscene — Locked-Look Story Beat in 5-10 Seconds

A cutscene is a non-interactive video clip the game plays back at a fixed moment — opening, story beat, character intro, ending. Quality is dominated by **two things**: continuity (the character on screen looks like the character in the game) and shot length (every clip past 10s drifts in identity, hands, and physics). This skill enforces both — generate a reference image first to lock the look, then image-to-video each shot, then chain shots in sequence rather than asking the model for one long take.

If the user wants 5 seconds of marketing footage, that's `trailer-shot`. If they want a seamless background loop, that's `animated-loop`. This skill is for narrative beats with a defined start, middle, and end — usually with dialogue or VO.

## When to use

- "Generate the opening cinematic for the game."
- "I need a cutscene where the witch turns to the player and warns them about the curse."
- "Make a 10-second character intro for the boss."
- "Add an ending sequence after the player defeats the dragon."
- "Cinematic where the village burns and the protagonist runs."
- The user has a defined moment with story content — not a vibe loop, not a marketing splash.

## When NOT to use

- "5-second slow-mo combat shot for the trailer" — `trailer-shot`.
- "Looping splash screen background" — `animated-loop`.
- "Animated logo backdrop on the title screen" — `animated-loop`.
- Real-time in-engine cinematic with the actual gameplay characters and camera — that's an AnimationPlayer job, not generated video. Route to `scene-composition`.
- Voice-only narration over a static image — generate the dialogue with `assets.generate_audio` and use a static `TextureRect`, no video needed.

## Steps

### 1. Read the soul file and any prior cutscenes

```
Read .summer/GameSoul.md
assets.search({ query: "<character name> reference", assetType: "2d_image", scope: "all" })
```

`assets.search` has no video filter — `assetType` is one of `2d_image`, `animation`, `3d_model`, `audio`, `music`, `all`, and there is no video member. To find prior cutscene clips, search your own assets with `assets.search({ query: "cutscene", scope: "mine" })` and read the titles.

If a reference image of the character already exists from a prior `concept-art` or `character-portrait` run, **reuse it** as the `imageUrl` — that single decision is the difference between the character looking like themselves and looking like a stranger.

### 2. Plan the shot list

Cutscenes longer than 10 seconds are **multiple shots**, not one take. Ask the user to break it down:

> Want this as one 10s shot, or three shots (e.g. wide → close on face → reaction)? Each shot is 5-10s. I'll generate a reference image once, then image-to-video each shot off of it.

Default if the user is vague: **3 shots, 5s each, on kling**. Confirm before spending credits: `dryRun: true` on a shot's call returns its `estimate` (credits, balance, enough) and renders nothing.

### 3. Lock the look — generate a reference image first

For any character or hero scene, generate a reference still with `assets.generate_image` *before* generating video. This still drives `imageUrl` on every subsequent shot, so the character is consistent across cuts.

```
assets.generate_image({
  prompt: "<subject>, <setting>, cinematic lighting, film still, wide framing, <art style from GameSoul.md>",
  model: "nano-banana-2",
  aspectRatio: "16:9"
})
```

Set `aspectRatio` to the cutscene's framing (`16:9`, or `9:16` for mobile); `width` and `height` ask for a minimum size. For image-to-video this matters more than usual: the clip's framing is inherited from the reference, so a square reference gives you a square cutscene.

Show the user the still and confirm it's the right look before video-ing it. Regenerating a still costs far less than regenerating a video.

### 4. Pick the model

**This skill always passes `imageUrl`, which puts every call on the image-to-video route.** `kling-turbo` and `veo3` are text-to-video only; asking for either with an `imageUrl` set is a 400 `invalid_model`, not a silent downgrade.

| Model | i2v? | Speed | When |
|---|---|---|---|
| `ltx` | yes | ~30s | Iteration, blocking shots, B-roll, throwaway tests |
| `kling` | yes | 2-4 min | Hero shots, character cutscenes, anything the player will sit and watch |
| `kling-turbo` | **no** | 1-2 min | Text-to-video only — usable only if you drop the reference image |
| `veo3` | **no** | 3-5 min | Text-to-video only — usable only if you drop the reference image |

Default policy: **`ltx` first** to validate the prompt and shot framing. If it lands the composition but quality is rough, escalate to `kling`. `veo3` is a real tradeoff, not an upgrade: reaching for it means giving up `imageUrl`, which is the one thing that holds character identity across shots. Take that trade only when on-camera lip-sync matters more than continuity, and only with the user's approval on cost.

### 5. Generate each shot

```
assets.generate_video({
  prompt: "<subject does <action>, <camera move>, <lighting>, cinematic, 16mm film grain>",
  model: "kling",
  imageUrl: "<reference image fileUrl from step 3>",
  duration: 5,
  aspectRatio: "16:9"
})
```

On `ltx` and `kling`, `duration` is 5 or 10 — anything else renders 5. The newer models in the `model` list render their nearest supported length.

`assets.generate_video` always answers at once with a job — `{ status: "running", job: { id } }` and **no `fileUrl`**; the clip is rendered by a background worker. Wait for it:

```
jobs.wait({ jobId: "<job.id from the generate call>", timeoutSeconds: 50 })
```

Call `jobs.wait` again until `finished` is true. Only a finished job with state `done` has the asset and URL in its `result`. Do not tell the user a shot is done off the back of the generate call — at that moment nothing has rendered yet.

`aspectRatio` is applied on the text-to-video path only; on image-to-video the framing comes from the reference image, so a `9:16` cutscene needs a `9:16` reference, not a `9:16` argument.

When the job completes, show the user the URL and ask:

> Shot 1 of 3 done. Land or regenerate? If land, I'll move to shot 2.

### 6. Generate dialogue audio (if the scene has dialogue)

Cutscene dialogue is TTS, not in the video model. The video model can render mouth motion that *looks* like talking, but the audio comes from `assets.generate_audio`. Generate it separately and an AnimationPlayer or your `cinematics/` controller scene syncs them.

```
assets.generate_audio({
  capability: "text_to_speech",
  text: "They'll come for you at dawn. Run while you can.",
  voiceId: "<from audio bible — see voice-line>"
})
```

Lip-sync caveat: if the video shows the character clearly mouthing words and the audio is a different cadence, viewers notice. Either (a) keep the camera off the character's face during dialogue, (b) accept the asynchrony for a stylized look, or (c) use `veo3` and prompt the dialogue text directly into the video prompt for synced motion.

### 7. Import and wire as a VideoStreamPlayer

**Import the `.mp4` as it is; the import converts it.** Summer Engine plays video only as Ogg Theora (`.ogv`), so every Summer import tool (`summer_import_from_url`, its batch, `summer_import_asset_by_id`, `summer_import_asset`) converts a video on the way in and saves it at the path you asked for with `.ogv`. The answer names the file in `videoConversions` and `note`:

```
summer_import_asset_by_id(assetId="<the shot's asset id>", path="res://assets/video/cinematics/intro_shot_01.mp4")
→ importedTo: res://assets/video/cinematics/intro_shot_01.ogv
```

Build a controller scene at `res://cinematics/Intro.tscn`: create it, then build its nodes in one script (`scenePath` names the new scene; the editor's open tab comes back afterwards):

```
summer_create_scene(path="res://cinematics/Intro.tscn", rootName="Intro", rootType="Control")
summer_run_script(scenePath="res://cinematics/Intro.tscn", source="""
func run(ctx):
    var video = ctx.add_node("VideoStreamPlayer", "Video", null, {
        "stream": load("res://assets/video/cinematics/intro_shot_01.ogv"),
        "autoplay": true,
        "expand": true,
    })
    video.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
    var fade = ctx.add_node("ColorRect", "Fade", null, {"color": Color(0, 0, 0, 1)})   # black, alpha 1.0 -> 0.0
    fade.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
    fade.mouse_filter = Control.MOUSE_FILTER_IGNORE
    ctx.save_scene()
""")
```

`Fade` comes after `Video` in the tree, so it draws on top of it.

Attach a `Tween` script that fades the `ColorRect` from black to clear over 0.5s on `_ready`, then back to black when `Video.finished` fires, then `queue_free()`s the scene. For multi-shot cutscenes, queue the next `VideoStreamPlayer` in the `finished` signal handler.

For dialogue, add an `AudioStreamPlayer` sibling with the TTS clip and call `play()` in `_ready` after a small delay matching where the line lands in the video.

## Reference card — prompts that work

Pattern: `<subject> + <action> + <camera move> + <lighting> + <stylistic anchor>`. Keep prompts under 50 words; over-prompting confuses the model. Always pair with `imageUrl` to lock the character.

| Goal | Model | Prompt | Duration |
|---|---|---|---|
| Opening establishing shot | `kling` | `wide shot of a fog-shrouded medieval village at dawn, slow dolly-in toward the church spire, warm low sun, cinematic, anamorphic lens flare` | 5s |
| Character intro (hero turns to camera) | `kling` | `young witch with raven on shoulder turns slowly toward camera, candlelit interior, shallow depth of field, cinematic film still` | 5s |
| Dialogue close-up (no synced lips) | `kling` | `close-up of a grizzled knight, eyes downcast then looking up, firelight on his face, dust motes, 16mm film grain` | 5s |
| Dialogue close-up (synced lips) | `veo3` — text-to-video only, drop `imageUrl` | `close-up of the witch saying "they will come for you at dawn", candlelight, cinematic, shallow DOF` | 5s |
| Action beat (village burns) | `kling` | `medium wide of a thatched village engulfed in flames at night, embers rising, silhouettes running through smoke, hand-held camera, cinematic` | 5s |
| Ending shot (hero walks away) | `kling` | `low wide shot of a cloaked figure walking away across a blasted plain at sunset, slow truck-back, golden hour, dust on the wind` | 5s |
| Throwaway iteration / blocking | `ltx` | same prompt as above | 5s |
| Anime / stylized cutscene | `kling` | `anime-style young swordsman draws blade and steps forward, sakura petals, dramatic wind, Studio Ghibli soft painterly` | 5s |

### Bad prompts and why

| Bad | Why it fails |
|---|---|
| `epic cutscene of the hero defeating the boss` | No subject, no shot, no camera. Returns a generic action montage. |
| `the hero walks into the throne room, kneels before the king, draws his sword and says I refuse to serve, then walks out` | Five events in one prompt. Model picks one (badly) or tries all and renders mush. Split into three shots. |
| `cinematic 4k masterpiece trending on artstation` | Adjective slop. The model already knows "cinematic"; the rest is dead weight. |
| `make the character look exactly like in the game` | Words can't anchor identity. Use `imageUrl`. |
| `the camera does a complex handheld weaving move through the crowd` | Video models render simple camera moves (pan, tilt, dolly, truck) reliably and complex moves badly. Pick one verb. |

## Anti-patterns

- **Generating a 10s shot when you should chain two 5s shots.** Identity, hand consistency, and physics drift every additional second past ~6s. Two 5s shots cut together look better and cost the same.
- **Skipping the reference image.** Generating four character cutscenes from text prompts alone produces four different-looking people. Always lock the look with `assets.generate_image` first, then `imageUrl` every subsequent video call.
- **Asking the video model to render dialogue without `veo3`.** `kling` and `ltx` will animate mouths but the motion does not match any audio. Use `veo3` if dialogue is on-camera, or keep the camera off the speaker.
- **Using `kling` for blocking iterations.** Validate framing and prompt on the cheaper `ltx` first; move to `kling` once the composition lands.
- **Putting the cutscene on a `VideoStreamPlayer` without a fade.** Cuts straight from gameplay to video are jarring. Always wrap in a `ColorRect` fade in/out.
- **Treating `assets.generate_video` as finished.** It answers `{ status: "running", job }` and no URL. Wait with `jobs.wait` until the job is done before there is anything to show or import.
- **Loading the `.mp4` path after an import.** The engine has no MP4 or WebM loader; the import saved the shot as `.ogv`. `load()` the `.ogv` path the answer names.
- **Asking `ltx` or `kling` for `duration: 3` or `duration: 8`.** On those two only 5 and 10 exist; anything else renders 5.
- **Pairing `imageUrl` with `kling-turbo` or `veo3`.** Neither has an image-to-video endpoint — that combination is a 400.

## Edge cases

- **Vertical cutscene for a mobile target.** On the image-to-video path `aspectRatio` is not applied at all — the clip inherits the reference image's framing. So the reference *must* be 9:16: generate it with `aspectRatio: "9:16"`, then pass its URL as `imageUrl`.
- **Cutscene must match an in-engine character precisely.** No video model will hit pixel-perfect identity. Either (a) accept the artistic license, (b) render the cutscene in-engine with `AnimationPlayer` instead of generating it, or (c) generate a reference image *from* a screenshot of the in-engine character (image-to-image first, then image-to-video).
- **Dialogue is too long for a 5s shot.** Either trim the line, or split: 5s of speaker, 5s of listener reaction (cheaper because the listener doesn't need synced lips).
- **Cutscene needs to play and the player isn't looking.** Pause the gameplay timer, push a `Control` overlay with the `VideoStreamPlayer`, restore on finish.
- **Multi-shot continuity.** Use the same reference image as `imageUrl` across all shots. If lighting differs by shot, generate one reference per lighting setup, not one per shot.

## Without Summer Engine

In a session without Summer Engine tools (the assets profile; the `summer-assets` skill has the whole loop), do steps 1-6 and skip step 7 (`VideoStreamPlayer`). Skip the soul-file read in step 1 when the project has no `.summer/` folder. Save the file where the person asked with `out` (the `summer-assets` skill says how), and tell them the path and format. Each shot is an MP4 and each dialogue line an audio file; the person cuts them together in their own editor.

## Fallback (no MCP)

If the MCP server isn't running, the user can do all of this in the Summer dashboard:

1. Generate a reference image in the Image tab.
2. Open the Video tab, paste the reference URL into the image-to-video field.
3. Set model, duration, aspect ratio, and prompt as listed above.
4. Import the shot's URL from a shell while Summer Engine runs: `summer tool import-from-url --args '{"url":"<shot url>","path":"res://assets/video/cinematics/<name>.ogv"}'`. It converts the `.mp4` to Ogg Theora (`.ogv`), the only video container Summer Engine can open.

Print the exact prompt + model + duration + aspect ratio so the user can paste it into the dashboard verbatim.

## Handoff

Once the cutscene is generated and wired:

> Cutscene `intro` wired at `cinematics/Intro.tscn` with fade in/out and `Video.finished` chained to scene change. Next:
> - Add the dialogue track with `voice-line` if you haven't yet.
> - Score the moment with `music-track` — a cutscene without music feels like a placeholder.
> - For the boss reveal cutscene, run this skill again with the same reference image to keep the witch identity stable.
> - If you want a 5s "money shot" version for marketing, run `trailer-shot` against the same reference.

## See also

- `trailer-shot` — marketing footage, 5-10s, maximum visual punch.
- `animated-loop` — seamless looping background clips.
- `voice-line` — TTS dialogue used inside cutscenes.
- `music-track` — score the cutscene.
- `concept-art` — generate the reference image axis if no character reference exists yet.
- `character-portrait` — produce a high-fidelity locked character portrait for use as `imageUrl`.
- `summer_docs_read` id `reference/mcp-tools-reference` — how to call `assets.generate_video`; `summer_search` returns its exact input.

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@4.9.0` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `assets.generate_audio`, `summer_assets_generate_audio` | `summer assets generate-audio` |
| `assets.generate_image`, `summer_assets_generate_image` | `summer assets generate-image` |
| `assets.generate_video`, `summer_assets_generate_video` | `summer assets generate-video` |
| `assets.search`, `summer_assets_search` | `summer assets search` |
| `summer_docs_read` | `summer docs read` |
| `summer_add_node` | `summer engine add-node` |
| `summer_create_scene` | `summer engine create-scene` |
| `summer_import_asset` | `summer engine import-asset` |
| `summer_import_asset_by_id` | `summer engine import-asset-by-id` |
| `summer_import_from_url` | `summer engine import-from-url` |
| `summer_run_script` | `summer engine run-script` |
| `summer_set_prop` | `summer engine set-prop` |
| `jobs.wait`, `summer_jobs_wait` | `summer jobs wait` |
| `summer_search` | `summer ops search "<what you want>"` |
<!-- /shell-commands -->
