---
name: animated-loop
description: Use when generating a short looping video clip — splash screen background, animated logo backdrop, idle title-screen footage, looping environment ambience. Output must loop seamlessly and is wired as a VideoStreamPlayer with autoplay and loop set true. Trigger on "looping background", "splash loop", "title screen video", "animated backdrop", "menu background loop", "ambient loop video", "looping clip", "seamless loop".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: video
user-invocable: true
allowed-tools: Read Grep Glob Write Edit summer_generate_video summer_check_job summer_generate_image summer_search_assets summer_import_from_url summer_add_node summer_set_prop
paths: ["assets/video/**", "menus/**", "ui/**"]
---

# animated-loop — 5 Second Seamless Background Loop

A loop is the only video format that has to *not have* a beginning or end. The viewer sees it on the title screen for 30 seconds; if the seam between loop iterations is visible, the whole thing reads as broken. This skill exists to force the constraints that make seams invisible: take the shortest duration available, keep the motion ambient (no narrative, no big camera moves), use the cheap fast model (`ltx`), and prompt for a composition where the first and last frames are functionally identical.

**Duration is not a dial here.** `summer_generate_video` accepts only `duration=5` or `duration=10`; the server coerces every other value to 5. So "drop to 3s to hide the seam" is not an option — 5s is the floor, and the seam has to be won in the prompt and the reference frame instead.

If the user wants a 5s punchy marketing shot, that's `video/trailer-shot`. If they want a 10s narrative cutscene, that's `video/cinematic-cutscene`. This skill is the one for video that has to *disappear* — atmosphere behind a logo, mood behind a menu, ambience behind a splash card.

## When to use

- "Looping background for the title screen."
- "Animated backdrop behind the logo on the splash."
- "Menu background — torchlit dungeon, just flicker and motes."
- "Looping ambient video for the pause screen."
- "Splash loop — fog over a forest."
- "Need a video that loops behind the level select."

## When NOT to use

- Marketing shot for a trailer (5-10s with punch) — `video/trailer-shot`.
- Narrative cutscene with a beginning and end — `video/cinematic-cutscene`.
- Static splash image — generate with `2d-assets/concept-art` and use a `TextureRect`. A still is cheaper, lighter, and never seams.
- UI element animation (icons, button states) — those are GDScript `Tween` or sprite sheets, not video.
- A 10-second shot you want to "loop". That seam will be visible. Either accept a hard cut every 10s (ugly) or generate a 5s clip designed to loop.

## Steps

### 1. Confirm the loop will be visible for a long time

> Quick check — this loop will play on a screen the user might stare at for 30+ seconds. That means the loop point must be invisible. I'll take the 5s minimum and prompt for ambient motion (drift, flicker, shimmer) rather than a narrative beat. OK?

If the user wants narrative motion (a character walking, a door opening), this is the wrong skill — route to `video/cinematic-cutscene`.

### 2. Pick the model — `ltx` first, always

For loops, `ltx` is correct ~95% of the time. It's $0.10, ~30s, and the constraints (short duration, ambient motion) are exactly the ones `ltx` handles best. Premium models add cost without adding loop quality.

This skill always passes `imageUrl` (step 3), which puts every call on the image-to-video route — and that route accepts only `ltx`, `kling`, and `minimax`. `kling-turbo` and `veo3` are text-to-video only; pairing either with an `imageUrl` is a 400 `invalid_model`, not a silent downgrade.

| Model | i2v? | Cost | Speed | When |
|---|---|---|---|---|
| `ltx` | yes | $0.10 | ~30s | Default. Use this. |
| `kling` | yes | $0.50 | 2-4 min | Only if the loop is the centerpiece of a premium splash and quality is visibly lacking on `ltx` |
| `minimax` | yes | $0.25 | 2-3 min | Stylized / anime aesthetic loops |
| `kling-turbo` | **no** | $0.30 | 1-2 min | Not reachable from this skill — text-to-video only |
| `veo3` | **no** | $1.00 | 3-5 min | Not reachable from this skill, and pointless for ambient loops anyway |

### 3. Lock the look with a reference still

The reference still doubles as the *target* loop frame. Generate it deliberately — the video model's first and last frames will gravitate toward the reference, which is exactly what you want for a closing seam.

```
summer_generate_image(
  prompt="<subject>, ambient atmospheric scene, cinematic lighting, painterly, wide 16:9 framing, balanced composition with no clear focal action",
  model="nano-banana-2"
)
```

`summer_generate_image` has no size or aspect argument — `options.image_size` is dropped without an error and every MCP image comes back at the server's 1:1 default. Ask for the framing in the prompt, or generate the reference in the Summer dashboard (which exposes aspect ratio) and pass its URL.

This matters more than usual here: on the image-to-video route `aspectRatio` is **not applied at all** — the clip inherits the reference image's framing. So a vertical mobile splash needs a genuinely 9:16 reference image, and setting `aspectRatio="9:16"` on the video call does nothing.

### 4. Prompt for loopable motion only

Loopable motion is **continuous, ambient, directionless, or oscillating**. Avoid anything with a beginning or end (a character entering, a sword swinging, a door closing).

Loopable verbs: `drift`, `flicker`, `swirl`, `shimmer`, `sway`, `pulse`, `glow`, `rise`, `fall`, `wave`, `breathe`, `ripple`.

Non-loopable verbs (avoid): `walks`, `enters`, `appears`, `emerges`, `transforms`, `attacks`, `falls down`, `opens`, `closes`.

```
summer_generate_video(
  prompt="<subject from reference>, <ambient loopable motion>, slow continuous, looping, seamless, cinematic",
  model="ltx",
  imageUrl="<reference URL from step 3>",
  duration=5,
  options={ negative_prompt: "sudden movement, character action, narrative event, fade to black" }
)
```

The phrase **"looping, seamless"** in the prompt biases the model toward stable first/last frames. `options.negative_prompt` is one of the few provider keys that does pass through on the video route (`prompt`, `image_url`, `num_frames`, `duration`, `resolution`, and `model` are stripped; everything else is forwarded), so the negative genuinely rules out narrative drift here — unlike on `summer_generate_image`, where no such argument exists.

`aspectRatio` is omitted deliberately: it is applied on the text-to-video path only, and this call passes `imageUrl`.

The call returns `{ success, queued: true, jobId, ... }` and **no URL** — video generation is asynchronous. Poll `summer_check_job(jobId="<jobId>")` until it reports `completed`, and only then treat the clip as existing.

### 5. Inspect the seam

Watch the result and the seam (the cut between the last and first frame on replay). If the seam is visible:

- **Most common cause:** something moved across the frame and didn't return (a particle drifted off-screen, a cloud moved). Regenerate with `slow continuous, returning motion, oscillating` in the prompt.
- **Second cause:** lighting drifted. Regenerate with `constant lighting, no time of day change`.
- **Third cause:** the motion is simply too fast to close in the time available. You cannot shorten the clip — 5s is the minimum the API offers — so slow the motion in the prompt instead (`very slow`, `barely perceptible drift`).

If three regenerations don't seam-close, accept a small crossfade in the engine: set up two `VideoStreamPlayer` nodes and crossfade between them via a `Tween`. This is a fallback, not the goal.

### 6. Import and wire as a looping VideoStreamPlayer

**Transcode to Ogg Theora first.** The generated clip is an `.mp4`, and Summer Engine cannot load `.mp4`. `.ogv` is the only video container in the build — there is no bundled WebM or MP4 plugin, and nothing transcodes on your behalf. Measured against the shipped binary (4.6.1):

```
$ Summer --headless --path <proj> -s res://probe.gd
VideoStream exts: ["ogv", "tres", "res"]
ERROR: No loader found for resource: res://clip.mp4 (expected type: unknown)
```

`summer_import_from_url` downloads the bytes, runs Godot's import pipeline, and *fails the import* if the file never becomes a loadable resource — so importing the `.mp4` does not quietly half-work, it is rejected and rolled back. Convert first:

```
ffmpeg -i title_screen_bg.mp4 -c:v libtheora -q:v 8 -an title_screen_bg.ogv
```

```
summer_import_from_url(url="<hosted .ogv url>", path="res://assets/video/loops/title_screen_bg.ogv")
```

Then wire it. Every scene-mutating tool takes an explicit `scenePath`, and `summer_set_prop`'s property argument is named `key`, not `property`:

```
summer_add_node(scenePath="res://ui/title_screen.tscn", parent=".", type="VideoStreamPlayer", name="BackgroundLoop")
summer_set_prop(scenePath="res://ui/title_screen.tscn", path="./BackgroundLoop", key="stream", value="res://assets/video/loops/title_screen_bg.ogv")
summer_set_prop(scenePath="res://ui/title_screen.tscn", path="./BackgroundLoop", key="autoplay", value=true)
summer_set_prop(scenePath="res://ui/title_screen.tscn", path="./BackgroundLoop", key="loop", value=true)
summer_set_prop(scenePath="res://ui/title_screen.tscn", path="./BackgroundLoop", key="expand", value=true)
summer_set_prop(scenePath="res://ui/title_screen.tscn", path="./BackgroundLoop", key="anchors_preset", value=15)
summer_save_scene(scenePath="res://ui/title_screen.tscn")
```

Anchors preset 15 is "full rect" — the loop fills the menu. Place the logo and menu buttons as children *above* the `VideoStreamPlayer` in the tree (Godot draws siblings in tree order; later siblings render on top).

### 7. Mute the audio track

Loops should never have a baked audio track that loops with them — the audio seam will be even more obvious than the visual one. The video models don't generate audio anyway, but if you ever import a clip that has audio, mute it:

```
summer_set_prop(scenePath="res://ui/title_screen.tscn", path="./BackgroundLoop", key="volume_db", value=-80)
```

Score the menu separately with `audio/music-track`.

## Reference card — prompts that work

Pattern: `<subject> + <ambient loopable motion> + <constant lighting> + "looping, seamless" + <stylistic anchor>`. Keep under 40 words. Always pair with `imageUrl`.

| Goal | Model | Prompt | Cost | Duration |
|---|---|---|---|---|
| Title menu — fog forest | `ltx` | `dense pine forest in low fog, fog drifting slowly between trunks, soft moonlight, ambient particles rising, looping, seamless, cinematic painterly` | $0.10 | 5s |
| Title menu — dungeon torch | `ltx` | `stone dungeon corridor lit by a single torch, flame flickering steadily, dust motes drifting in the light cone, looping, seamless` | $0.10 | 5s |
| Splash — embers / sky | `ltx` | `dusk sky with slow drifting embers rising upward across frame, deep blue gradient, looping, seamless, cinematic` | $0.10 | 5s |
| Logo backdrop — magic runes | `ltx` | `dark surface with glowing blue runes pulsing softly in slow rhythm, faint shimmer, no narrative motion, looping, seamless` | $0.10 | 5s |
| Menu — underwater | `ltx` | `underwater scene with caustic light dancing on a sandy floor, slow drifting bubbles, gentle current sway on kelp, looping, seamless` | $0.10 | 5s |
| Pause screen — slow rain | `ltx` | `window pane with continuous gentle rain drops, blurred warm interior glow behind, looping, seamless, ambient` | $0.10 | 5s |
| Title — anime sky | `minimax` | `anime style cumulus clouds drifting slowly across a pastel sunset sky, soft, painterly, looping, seamless, Ghibli` | $0.25 | 5s |
| Premium splash centerpiece | `kling` | `dragon silhouette breathing in profile against a vast sunset sky, only the chest rising and falling and clouds drifting, looping, seamless` | $0.50 | 5s |

### Bad prompts and why

| Bad | Why it fails |
|---|---|
| `looping background of a hero walking through a forest` | "Walking" is non-loopable — the hero arrives and departs. Replace with `forest with fog drifting`. |
| `dramatic title screen video` | "Dramatic" implies narrative beats; loops want ambient. Specify the ambient motion. |
| `make it 10 seconds and loop` | 10s loops show their seam. Drop to 5s. |
| `epic looping background trending on artstation` | Adjective slop. The model already knows "cinematic"; the rest hurts. |
| `the door slowly opens, looping` | Doors don't loop — they open once. The clip will hard-cut on replay. |

## Anti-patterns

- **Asking the model for a 10s loop.** Past ~6s, identity drifts and the seam shows. `duration=5` is both the floor and the right answer; 10 is the only other value the API accepts.
- **Treating `summer_generate_video` as synchronous.** It returns `{ queued: true, jobId }` and no URL. Poll `summer_check_job` before claiming a clip exists.
- **Spending `kling` money on a loop.** `ltx` is the right call ~95% of the time. The constraints favor the cheap model.
- **Prompting narrative motion.** "Hero draws sword" doesn't loop. Use ambient verbs.
- **Forgetting `loop=true` on the `VideoStreamPlayer`.** The clip will play once and freeze on the last frame.
- **Forgetting to mute baked audio.** If audio is on, the loop point becomes audible even if it's invisible.
- **Expecting `aspectRatio` to reframe an image-to-video call.** It is applied on the text-to-video path only. A portrait splash needs a portrait *reference image* — the argument does nothing here.
- **Importing the `.mp4` as-is.** `.ogv` is the only video container the engine can load; there is no bundled WebM or MP4 plugin. An un-transcoded import fails and is rolled back.

## Edge cases

- **Splash loop must be tiny in build size.** Loops compress aggressively because of low motion. Target ≤2MB by exporting at 720p, low bitrate, in DaVinci. Studio's import doesn't re-encode by default.
- **Mobile portrait splash.** The reference image must genuinely be portrait — `aspectRatio` is ignored on the image-to-video path, and MCP image generation is square-only, so make the reference in the Summer dashboard or crop it. Anchors preset 15 still works.
- **Loop must sync to a music beat.** The video model doesn't know your BPM. Generate at the duration matching one bar at the menu music tempo (e.g. 120 BPM × 4 beats = 2s, or 8 beats = 4s) and confirm visually.
- **Loop is behind translucent UI.** Generate with extra contrast headroom — the model tends toward mid-grey, and translucent UI on mid-grey reads muddy. Push for `high contrast cinematic` in the prompt.
- **Loop seam still visible after 3 regens.** Set up two `VideoStreamPlayer` siblings and crossfade between them with a `Tween` on a 0.5s overlap. Costs an extra GPU decode but hides the seam.

## Fallback (no MCP)

If the Studio MCP server isn't running, route the user to the Studio web dashboard:

1. Image tab → generate the reference still (the loop's "neutral frame").
2. Video tab → image-to-video with `ltx`, duration 4s, aspect ratio per target.
3. Prompt with the loopable-motion vocabulary above and `"looping, seamless"`.
4. Download the result, transcode to `.ogv` if needed, place under `assets/video/loops/`.

Print the exact prompt + model + duration + aspect ratio so the user can paste it into the dashboard.

## Handoff

Once the loop is wired:

> Loop `title_screen_bg` is wired to `TitleScreen/BackgroundLoop` with autoplay + loop. Next:
> - Score the menu with `audio/music-track` — a quiet ambient bed scored to the loop's mood.
> - For the logo and menu UI on top, hand off to `2d-assets/ui-graphics`.
> - If the user wants a punchy 5s shot for the trailer using the same look, hand off to `video/trailer-shot` (reuse the reference image).
> - If the user wants a narrative intro that plays *before* the title loops, hand off to `video/cinematic-cutscene`.

## See also

- `video/trailer-shot` — punchy marketing footage.
- `video/cinematic-cutscene` — narrative cutscenes with dialogue.
- `audio/music-track` — score the menu.
- `2d-assets/ui-graphics` — logo, menu buttons, HUD that sits over the loop.
- `2d-assets/concept-art` — produce the reference still that anchors the loop.
- `../../references/mcp-tools-reference/mcp-tools-reference.md` — `summer_generate_video` parameter schema and error codes.
