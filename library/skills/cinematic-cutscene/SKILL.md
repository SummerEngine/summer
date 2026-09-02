---
name: cinematic-cutscene
description: Use when generating a non-interactive cutscene clip — opening scene, story beat, character intro, ending. Locks the look with a reference image, image-to-videos a 5-10s shot, optionally adds TTS dialogue, and wires it as a VideoStreamPlayer that fades in/out. Trigger on "cutscene", "intro cinematic", "opening scene", "ending cinematic", "story beat video", "character intro video", "in-engine cinematic", "non-playable scene".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: video
user-invocable: true
allowed-tools: Read Grep Glob Write Edit summer_generate_video summer_check_job summer_generate_image summer_generate_audio summer_search_assets summer_import_from_url summer_add_node summer_set_prop
paths: ["assets/video/**", "cinematics/**", "trailers/**"]
---

# cinematic-cutscene — Locked-Look Story Beat in 5-10 Seconds

A cutscene is a non-interactive video clip the game plays back at a fixed moment — opening, story beat, character intro, ending. Quality is dominated by **two things**: continuity (the character on screen looks like the character in the game) and shot length (every clip past 10s drifts in identity, hands, and physics). This skill enforces both — generate a reference image first to lock the look, then image-to-video each shot, then chain shots in sequence rather than asking the model for one long take.

If the user wants 5 seconds of marketing footage, that's `video/trailer-shot`. If they want a 3-second seamless background loop, that's `video/animated-loop`. This skill is for narrative beats with a defined start, middle, and end — usually with dialogue or VO.

## When to use

- "Generate the opening cinematic for the game."
- "I need a cutscene where the witch turns to the player and warns them about the curse."
- "Make a 10-second character intro for the boss."
- "Add an ending sequence after the player defeats the dragon."
- "Cinematic where the village burns and the protagonist runs."
- The user has a defined moment with story content — not a vibe loop, not a marketing splash.

## When NOT to use

- "5-second slow-mo combat shot for the trailer" — `video/trailer-shot`.
- "Looping splash screen background" — `video/animated-loop`.
- "Animated logo backdrop on the title screen" — `video/animated-loop`.
- Real-time in-engine cinematic with the actual gameplay characters and camera — that's a Godot AnimationPlayer / Timeline job, not generated video. Route to `scene-composition`.
- Voice-only narration over a static image — generate the dialogue with `summer_generate_audio` and use a static `TextureRect`, no video needed.

## Steps

### 1. Read the soul file and any prior cutscenes

```
Read .summer/GameSoul.md
summer_search_assets(query="<character name> reference", assetType="2d_image", source="all")
```

`summer_search_assets` has no video filter — `assetType` is one of `2d_image`, `animation`, `3d_model`, `audio`, `music`, `all`, and there is no video member. To find prior cutscene clips, list your own assets with `summer_list_my_assets(query="cutscene")` and read the titles.

If a reference image of the character already exists from a prior `concept-art` or `character-portrait` run, **reuse it** as the `imageUrl` — that single decision is the difference between the character looking like themselves and looking like a stranger.

### 2. Plan the shot list

Cutscenes longer than 10 seconds are **multiple shots**, not one take. Ask the user to break it down:

> Want this as one 10s shot, or three shots (e.g. wide → close on face → reaction)? Each shot is 5-10s. I'll generate a reference image once, then image-to-video each shot off of it.

Default if the user is vague: **3 shots, 5s each, ~$1.50 total on kling**. Confirm before spending.

### 3. Lock the look — generate a reference image first

For any character or hero scene, generate a reference still with `summer_generate_image` *before* generating video. This still drives `imageUrl` on every subsequent shot, so the character is consistent across cuts.

```
summer_generate_image(
  prompt="<subject>, <setting>, cinematic lighting, film still, wide 16:9 framing, <art style from GameSoul.md>",
  model="nano-banana-2"
)
```

`summer_generate_image` has no size or aspect argument — `options.image_size` is dropped without an error and every MCP image comes back at the server's 1:1 default. Ask for the framing in the prompt, or generate the reference in the Summer dashboard (which exposes aspect ratio) and pass its URL. For image-to-video this matters more than usual: the clip's framing is inherited from the reference, so a square reference gives you a square cutscene.

Show the user the still and confirm it's the right look before video-ing it. Regenerating a $0.05 still beats regenerating a $0.50 video.

### 4. Pick the model

**This skill always passes `imageUrl`, which puts every call on the image-to-video route — and that route only accepts three models.** `kling-turbo` and `veo3` are text-to-video only; asking for either with an `imageUrl` set is a 400 `invalid_model`, not a silent downgrade.

| Model | i2v? | Cost | Speed | When |
|---|---|---|---|---|
| `ltx` | yes | $0.10 | ~30s | Iteration, blocking shots, B-roll, throwaway tests |
| `kling` | yes | $0.50 | 2-4 min | Hero shots, character cutscenes, anything the player will sit and watch |
| `minimax` | yes | $0.25 | 2-3 min | Stylized / anime-leaning content; better at non-photoreal looks than kling |
| `kling-turbo` | **no** | $0.30 | 1-2 min | Text-to-video only — usable only if you drop the reference image |
| `veo3` | **no** | $1.00 | 3-5 min | Text-to-video only — usable only if you drop the reference image |

Default policy: **`ltx` first** to validate the prompt and shot framing. If it lands the composition but quality is rough, escalate to `kling`. `veo3` is a real tradeoff, not an upgrade: reaching for it means giving up `imageUrl`, which is the one thing that holds character identity across shots. Take that trade only when on-camera lip-sync matters more than continuity, and only with the user's approval on cost.

### 5. Generate each shot

```
summer_generate_video(
  prompt="<subject does <action>, <camera move>, <lighting>, cinematic, 16mm film grain>",
  model="kling",
  imageUrl="<reference image fileUrl from step 3>",
  duration=5,
  aspectRatio="16:9"
)
```

`duration` accepts **only 5 or 10** — the server coerces anything else to 5. There is no 3s, 4s, 7s or 8s clip.

Video generation is **asynchronous**. The call returns immediately with `{ success, queued: true, jobId, model, resolvedModel, estimatedCost, duration }` and **no `fileUrl`** — the clip is rendered by a background worker. Poll for it:

```
summer_check_job(jobId="<jobId from the generate call>")
```

Only once the job reports `completed` do you have an asset and a URL. Do not tell the user a shot is done off the back of the generate call — at that moment nothing has rendered yet.

`aspectRatio` is applied on the text-to-video path only; on image-to-video the framing comes from the reference image, so a `9:16` cutscene needs a `9:16` reference, not a `9:16` argument.

When the job completes, show the user the URL and ask:

> Shot 1 of 3 done. Land or regenerate? If land, I'll move to shot 2.

### 6. Generate dialogue audio (if the scene has dialogue)

Cutscene dialogue is TTS, not in the video model. The video model can render mouth motion that *looks* like talking, but the audio comes from `summer_generate_audio`. Generate it separately and the editor (Godot's AnimationPlayer or your `cinematics/` controller scene) syncs them.

```
summer_generate_audio(
  capability="text_to_speech",
  text="They'll come for you at dawn. Run while you can.",
  voiceId="<from audio bible — see audio/voice-line>"
)
```

Lip-sync caveat: if the video shows the character clearly mouthing words and the audio is a different cadence, viewers notice. Either (a) keep the camera off the character's face during dialogue, (b) accept the asynchrony for a stylized look, or (c) use `veo3` and prompt the dialogue text directly into the video prompt for synced motion.

### 7. Import and wire as a VideoStreamPlayer

**Transcode to Ogg Theora first.** The generated clip is an `.mp4`, and Summer Engine cannot load `.mp4` — the only video container in the build is `.ogv`. Measured against the shipped binary (4.6.1):

```
$ Summer --headless --path <proj> -s res://probe.gd
VideoStream exts: ["ogv", "tres", "res"]
ERROR: No loader found for resource: res://clip.mp4 (expected type: unknown)
```

Nothing transcodes for you — `summer_import_from_url` downloads the bytes, runs Godot's import pipeline, and *fails the import* if the file never becomes a loadable resource. Convert with ffmpeg or DaVinci before importing:

```
ffmpeg -i intro_shot_01.mp4 -c:v libtheora -q:v 8 -an intro_shot_01.ogv
```

Then:

```
summer_import_from_url(url="<hosted .ogv url>", path="res://assets/video/cinematics/intro_shot_01.ogv")
```

Build a controller scene at `res://cinematics/Intro.tscn`. Every scene-mutating tool takes an explicit `scenePath`, and `summer_set_prop`'s property argument is named `key`, not `property`:

```
summer_create_scene(path="res://cinematics/Intro.tscn", rootName="Intro", allow_temporary_scene_mutation=true)
summer_add_node(scenePath="res://cinematics/Intro.tscn", parent=".", type="ColorRect", name="Fade")   # black, alpha 1.0 → 0.0
summer_add_node(scenePath="res://cinematics/Intro.tscn", parent=".", type="VideoStreamPlayer", name="Video")
summer_set_prop(scenePath="res://cinematics/Intro.tscn", path="./Video", key="stream", value="res://assets/video/cinematics/intro_shot_01.ogv")
summer_set_prop(scenePath="res://cinematics/Intro.tscn", path="./Video", key="autoplay", value=true)
summer_set_prop(scenePath="res://cinematics/Intro.tscn", path="./Video", key="expand", value=true)
summer_set_prop(scenePath="res://cinematics/Intro.tscn", path="./Fade", key="anchors_preset", value=15)
summer_save_scene(scenePath="res://cinematics/Intro.tscn")
```

Attach a `Tween` script that fades the `ColorRect` from black to clear over 0.5s on `_ready`, then back to black when `Video.finished` fires, then `queue_free()`s the scene. For multi-shot cutscenes, queue the next `VideoStreamPlayer` in the `finished` signal handler.

For dialogue, add an `AudioStreamPlayer` sibling with the TTS clip and call `play()` in `_ready` after a small delay matching where the line lands in the video.

## Reference card — prompts that work

Pattern: `<subject> + <action> + <camera move> + <lighting> + <stylistic anchor>`. Keep prompts under 50 words; over-prompting confuses the model. Always pair with `imageUrl` to lock the character.

| Goal | Model | Prompt | Cost | Duration |
|---|---|---|---|---|
| Opening establishing shot | `kling` | `wide shot of a fog-shrouded medieval village at dawn, slow dolly-in toward the church spire, warm low sun, cinematic, anamorphic lens flare` | $0.50 | 5s |
| Character intro (hero turns to camera) | `kling` | `young witch with raven on shoulder turns slowly toward camera, candlelit interior, shallow depth of field, cinematic film still` | $0.50 | 5s |
| Dialogue close-up (no synced lips) | `kling` | `close-up of a grizzled knight, eyes downcast then looking up, firelight on his face, dust motes, 16mm film grain` | $0.50 | 5s |
| Dialogue close-up (synced lips) | `veo3` — text-to-video only, drop `imageUrl` | `close-up of the witch saying "they will come for you at dawn", candlelight, cinematic, shallow DOF` | $1.00 | 5s |
| Action beat (village burns) | `kling` | `medium wide of a thatched village engulfed in flames at night, embers rising, silhouettes running through smoke, hand-held camera, cinematic` | $0.50 | 5s |
| Ending shot (hero walks away) | `kling` | `low wide shot of a cloaked figure walking away across a blasted plain at sunset, slow truck-back, golden hour, dust on the wind` | $0.50 | 5s |
| Throwaway iteration / blocking | `ltx` | same prompt as above | $0.10 | 5s |
| Anime / stylized cutscene | `minimax` | `anime-style young swordsman draws blade and steps forward, sakura petals, dramatic wind, Studio Ghibli soft painterly` | $0.25 | 5s |

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
- **Skipping the reference image.** Generating four character cutscenes from text prompts alone produces four different-looking people. Always lock the look with `summer_generate_image` first, then `imageUrl` every subsequent video call.
- **Asking the video model to render dialogue without `veo3`.** `kling` and `ltx` will animate mouths but the motion does not match any audio. Use `veo3` if dialogue is on-camera, or keep the camera off the speaker.
- **Using `kling` for blocking iterations.** Burn $0.10 on `ltx` to validate framing and prompt; only spend $0.50 once the composition lands.
- **Putting the cutscene on a `VideoStreamPlayer` without a fade.** Cuts straight from gameplay to video are jarring. Always wrap in a `ColorRect` fade in/out.
- **Treating `summer_generate_video` as synchronous.** It returns `{ queued: true, jobId }` and no URL. You must poll `summer_check_job` before there is anything to show or import.
- **Importing the `.mp4` as-is.** The engine has no MP4 or WebM loader — only Ogg Theora (`.ogv`). Transcode first; an un-transcoded import fails and is rolled back.
- **Asking for `duration=3` or `duration=8`.** Only 5 and 10 exist; anything else is silently coerced to 5.
- **Pairing `imageUrl` with `kling-turbo` or `veo3`.** Neither has an image-to-video endpoint — that combination is a 400.

## Edge cases

- **Vertical cutscene for a mobile target.** On the image-to-video path `aspectRatio` is not applied at all — the clip inherits the reference image's framing. So the reference *must* be 9:16, and MCP image generation cannot produce that: make it in the Summer dashboard, or crop a square generation to 9:16, then pass its URL as `imageUrl`.
- **Cutscene must match an in-engine character precisely.** No video model will hit pixel-perfect identity. Either (a) accept the artistic license, (b) render the cutscene in-engine with `AnimationPlayer` instead of generating it, or (c) generate a reference image *from* a screenshot of the in-engine character (image-to-image first, then image-to-video).
- **Dialogue is too long for a 5s shot.** Either trim the line, or split: 5s of speaker, 5s of listener reaction (cheaper because the listener doesn't need synced lips).
- **Cutscene needs to play and the player isn't looking.** Pause the gameplay timer, push a `Control` overlay with the `VideoStreamPlayer`, restore on finish.
- **Multi-shot continuity.** Use the same reference image as `imageUrl` across all shots. If lighting differs by shot, generate one reference per lighting setup, not one per shot.

## Fallback (no MCP)

If the Studio MCP server isn't running, the user can do all of this through the Studio web dashboard at the Summer Engine cloud console:

1. Generate a reference image in the Image tab.
2. Open the Video tab, paste the reference URL into the image-to-video field.
3. Set model, duration, aspect ratio, and prompt as listed above.
4. Download the `.mp4`, transcode it to Ogg Theora (`ffmpeg -i in.mp4 -c:v libtheora -q:v 8 -an out.ogv`), and drop the `.ogv` into `assets/video/cinematics/`. Summer Engine has no MP4 or WebM loader — `.ogv` is the only video container it can open.

Print the exact prompt + model + duration + aspect ratio so the user can paste it into the dashboard verbatim.

## Handoff

Once the cutscene is generated and wired:

> Cutscene `intro` wired at `cinematics/Intro.tscn` with fade in/out and `Video.finished` chained to scene change. Next:
> - Add the dialogue track with `audio/voice-line` if you haven't yet.
> - Score the moment with `audio/music-track` — a cutscene without music feels like a placeholder.
> - For the boss reveal cutscene, run this skill again with the same reference image to keep the witch identity stable.
> - If you want a 5s "money shot" version for marketing, run `video/trailer-shot` against the same reference.

## See also

- `video/trailer-shot` — marketing footage, 5-10s, maximum visual punch.
- `video/animated-loop` — seamless looping background clips.
- `audio/voice-line` — TTS dialogue used inside cutscenes.
- `audio/music-track` — score the cutscene.
- `2d-assets/concept-art` — generate the reference image axis if no character reference exists yet.
- `2d-assets/character-portrait` — produce a high-fidelity locked character portrait for use as `imageUrl`.
- `../../references/mcp-tools-reference/mcp-tools-reference.md` — `summer_generate_video` parameter schema and error codes.
