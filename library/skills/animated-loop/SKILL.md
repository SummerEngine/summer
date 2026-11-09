---
name: animated-loop
description: "Generate a short seamless video loop: splash background, animated logo backdrop, idle title screen."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: video
user-invocable: true
allowed-tools: Read Grep Glob Write Edit summer_assets_generate_video summer_jobs_wait summer_assets_generate_image summer_assets_search summer_import_from_url summer_add_node summer_set_prop summer_call
paths: ["assets/video/**", "menus/**", "ui/**"]
---

# animated-loop — 5 Second Seamless Background Loop

A loop is the only video format that has to *not have* a beginning or end. The viewer sees it on the title screen for 30 seconds; if the seam between loop iterations is visible, the whole thing reads as broken. This skill exists to force the constraints that make seams invisible: take the shortest duration available, keep the motion ambient (no narrative, no big camera moves), use the fast model (`ltx`), and prompt for a composition where the first and last frames are functionally identical.

**Duration is not a dial here.** On `ltx` and `kling`, `assets.generate_video` renders only `duration: 5` or `duration: 10`; every other value renders 5. So "drop to 3s to hide the seam" is not an option — 5s is the floor, and the seam has to be won in the prompt and the reference frame instead.

If the user wants a 5s punchy marketing shot, that's `trailer-shot`. If they want a 10s narrative cutscene, that's `cinematic-cutscene`. This skill is the one for video that has to *disappear* — atmosphere behind a logo, mood behind a menu, ambience behind a splash card.

## When to use

- "Looping background for the title screen."
- "Animated backdrop behind the logo on the splash."
- "Menu background — torchlit dungeon, just flicker and motes."
- "Looping ambient video for the pause screen."
- "Splash loop — fog over a forest."
- "Need a video that loops behind the level select."

## When NOT to use

- Marketing shot for a trailer (5-10s with punch) — `trailer-shot`.
- Narrative cutscene with a beginning and end — `cinematic-cutscene`.
- Static splash image — generate with `concept-art` and use a `TextureRect`. A still is cheaper, lighter, and never seams.
- UI element animation (icons, button states) — those are GDScript `Tween` or sprite sheets, not video.
- A 10-second shot you want to "loop". That seam will be visible. Either accept a hard cut every 10s (ugly) or generate a 5s clip designed to loop.

## Steps

### 1. Confirm the loop will be visible for a long time

> Quick check — this loop will play on a screen the user might stare at for 30+ seconds. That means the loop point must be invisible. I'll take the 5s minimum and prompt for ambient motion (drift, flicker, shimmer) rather than a narrative beat. OK?

If the user wants narrative motion (a character walking, a door opening), this is the wrong skill — route to `cinematic-cutscene`.

### 2. Pick the model — `ltx` first, always

For loops, `ltx` is almost always right. It takes ~30s, and short ambient motion is what it handles best. The premium models cost more credits and do not loop better.

This skill always passes `imageUrl` (step 3), which puts every call on the image-to-video route. `kling-turbo` and `veo3` are text-to-video only; pairing either with an `imageUrl` is a 400 `invalid_model`, not a silent downgrade.

| Model | i2v? | Speed | When |
|---|---|---|---|
| `ltx` | yes | ~30s | Default. Use this. |
| `kling` | yes | 2-4 min | Only if the loop is the centerpiece of a premium splash and quality is visibly lacking on `ltx` |
| `kling-turbo` | **no** | 1-2 min | Not reachable from this skill — text-to-video only |
| `veo3` | **no** | 3-5 min | Not reachable from this skill, and pointless for ambient loops anyway |

### 3. Lock the look with a reference still

The reference still doubles as the *target* loop frame. Generate it deliberately — the video model's first and last frames will gravitate toward the reference, which is exactly what you want for a closing seam.

```
assets.generate_image({
  prompt: "<subject>, ambient atmospheric scene, cinematic lighting, painterly, wide framing, balanced composition with no clear focal action",
  model: "nano-banana-2",
  aspectRatio: "16:9"
})
```

Set `aspectRatio` to the screen the loop fills (`16:9`, or `9:16` for a vertical mobile splash).

On the image-to-video route `aspectRatio` is **not applied at all** — the clip inherits the reference image's framing. So a vertical mobile splash needs a 9:16 reference image, and setting `aspectRatio: "9:16"` on the video call does nothing.

### 4. Prompt for loopable motion only

Loopable motion is **continuous, ambient, directionless, or oscillating**. Avoid anything with a beginning or end (a character entering, a sword swinging, a door closing).

Loopable verbs: `drift`, `flicker`, `swirl`, `shimmer`, `sway`, `pulse`, `glow`, `rise`, `fall`, `wave`, `breathe`, `ripple`.

Non-loopable verbs (avoid): `walks`, `enters`, `appears`, `emerges`, `transforms`, `attacks`, `falls down`, `opens`, `closes`.

```
assets.generate_video({
  prompt: "<subject from reference>, <ambient loopable motion>, slow continuous, looping, seamless, cinematic",
  model: "ltx",
  imageUrl: "<reference URL from step 3>",
  duration: 5,
  negativePrompt: "sudden movement, character action, narrative event, fade to black"
})
```

The phrase **"looping, seamless"** in the prompt biases the model toward stable first/last frames, and `negativePrompt` rules out narrative drift. Images have no negative prompt: put negations in the image prompt text.

`aspectRatio` is omitted deliberately: it is applied on the text-to-video path only, and this call passes `imageUrl`.

The call answers at once with `{ status: "running", job: { id } }` and **no URL**. Call `jobs.wait({ jobId: "<job.id>", timeoutSeconds: 50 })` until `finished` is true; only a `done` job's `result` holds the clip.

### 5. Inspect the seam

Watch the result and the seam (the cut between the last and first frame on replay). If the seam is visible:

- **Most common cause:** something moved across the frame and didn't return (a particle drifted off-screen, a cloud moved). Regenerate with `slow continuous, returning motion, oscillating` in the prompt.
- **Second cause:** lighting drifted. Regenerate with `constant lighting, no time of day change`.
- **Third cause:** the motion is simply too fast to close in the time available. You cannot shorten the clip — 5s is the minimum the API offers — so slow the motion in the prompt instead (`very slow`, `barely perceptible drift`).

If three regenerations don't seam-close, accept a small crossfade in the engine: set up two `VideoStreamPlayer` nodes and crossfade between them via a `Tween`. This is a fallback, not the goal.

### 6. Import and wire as a looping VideoStreamPlayer

**Import the `.mp4` as it is; the import converts it.** Summer Engine plays video only as Ogg Theora (`.ogv`) — there is no MP4 or WebM loader in the build — so every Summer import tool converts a video on the way in: `summer_import_from_url`, its batch, `summer_import_asset_by_id` and `summer_import_asset`. A clip Summer generated or stores converts on Summer's media host; any other video converts with ffmpeg on this computer when it has Theora, else on summerengine.com. The `.ogv` lands at the path you asked for with the extension swapped, and the answer names it in `videoConversions` and `note`:

```
summer_import_asset_by_id(assetId="<the clip's asset id>", path="res://assets/video/loops/title_screen_bg.mp4")
→ importedTo: res://assets/video/loops/title_screen_bg.ogv
```

Load the `.ogv` path from the answer, never the `.mp4`.

Then wire it in one script. `scenePath` is the exact scene to change:

```
summer_run_script(scenePath="res://ui/title_screen.tscn", source="""
func run(ctx):
    var loop_player = ctx.add_node("VideoStreamPlayer", "BackgroundLoop", null, {
        "stream": load("res://assets/video/loops/title_screen_bg.ogv"),
        "autoplay": true,
        "loop": true,
        "expand": true,
    })
    loop_player.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)   # the loop fills the menu
    ctx.get_scene_root().move_child(loop_player, 0)   # drawn first: the menu draws on top
    ctx.save_scene()
""")
```

Controls draw in tree order and later siblings render on top, so the logo and menu buttons come after the `VideoStreamPlayer` in the tree.

### 7. Mute the audio track

Loops should never have a baked audio track that loops with them — the audio seam will be even more obvious than the visual one. The video models don't generate audio anyway, but if you ever import a clip that has audio, mute it:

```
summer_set_prop(scenePath="res://ui/title_screen.tscn", path="./BackgroundLoop", key="volume_db", value=-80)
```

Score the menu separately with `music-track`.

## Reference card — prompts that work

Pattern: `<subject> + <ambient loopable motion> + <constant lighting> + "looping, seamless" + <stylistic anchor>`. Keep under 40 words. Always pair with `imageUrl`.

| Goal | Model | Prompt | Duration |
|---|---|---|---|
| Title menu — fog forest | `ltx` | `dense pine forest in low fog, fog drifting slowly between trunks, soft moonlight, ambient particles rising, looping, seamless, cinematic painterly` | 5s |
| Title menu — dungeon torch | `ltx` | `stone dungeon corridor lit by a single torch, flame flickering steadily, dust motes drifting in the light cone, looping, seamless` | 5s |
| Splash — embers / sky | `ltx` | `dusk sky with slow drifting embers rising upward across frame, deep blue gradient, looping, seamless, cinematic` | 5s |
| Logo backdrop — magic runes | `ltx` | `dark surface with glowing blue runes pulsing softly in slow rhythm, faint shimmer, no narrative motion, looping, seamless` | 5s |
| Menu — underwater | `ltx` | `underwater scene with caustic light dancing on a sandy floor, slow drifting bubbles, gentle current sway on kelp, looping, seamless` | 5s |
| Pause screen — slow rain | `ltx` | `window pane with continuous gentle rain drops, blurred warm interior glow behind, looping, seamless, ambient` | 5s |
| Title — anime sky | `ltx` | `anime style cumulus clouds drifting slowly across a pastel sunset sky, soft, painterly, looping, seamless, Ghibli` | 5s |
| Premium splash centerpiece | `kling` | `dragon silhouette breathing in profile against a vast sunset sky, only the chest rising and falling and clouds drifting, looping, seamless` | 5s |

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
- **Treating `assets.generate_video` as finished.** It answers `{ status: "running", job }` and no URL. Wait with `jobs.wait` before claiming a clip exists.
- **Using `kling` for a loop.** `ltx` is almost always right; short ambient motion is what it does best.
- **Prompting narrative motion.** "Hero draws sword" doesn't loop. Use ambient verbs.
- **Forgetting `loop=true` on the `VideoStreamPlayer`.** The clip will play once and freeze on the last frame.
- **Forgetting to mute baked audio.** If audio is on, the loop point becomes audible even if it's invisible.
- **Expecting `aspectRatio` to reframe an image-to-video call.** It is applied on the text-to-video path only. A portrait splash needs a portrait *reference image* — the argument does nothing here.
- **Loading the `.mp4` path after an import.** The import converted the clip to `.ogv` and saved it under that name; `load()` the `.ogv` path the answer names.
- **Converting by hand.** The import tools convert; a hand-made ffmpeg command also fails on builds without libtheora (Homebrew's default ffmpeg has none).

## Edge cases

- **Splash loop must be tiny in build size.** Loops compress aggressively because of low motion. Target ≤2MB by exporting at 720p, low bitrate, in DaVinci. The import's conversion keeps quality high (Theora at quality 8, at most 1080p), so a small file starts from a 720p clip.
- **Mobile portrait splash.** The reference image must be portrait — `aspectRatio` is ignored on the image-to-video path, and MCP image generation is square-only, so make the reference in the Summer dashboard or crop it. Anchors preset 15 still works.
- **Loop must sync to a music beat.** The video model doesn't know your BPM. Generate at the duration matching one bar at the menu music tempo (e.g. 120 BPM × 4 beats = 2s, or 8 beats = 4s) and confirm visually.
- **Loop is behind translucent UI.** Generate with extra contrast headroom — the model tends toward mid-grey, and translucent UI on mid-grey reads muddy. Push for `high contrast cinematic` in the prompt.
- **Loop seam still visible after 3 regens.** Set up two `VideoStreamPlayer` siblings and crossfade between them with a `Tween` on a 0.5s overlap. Costs an extra GPU decode but hides the seam.

## Without Summer Engine

In a session without Summer Engine tools (the assets profile; the `summer-assets` skill has the whole loop), do steps 1-5 and stop when the seam passes. Skip steps 6-7 (the `VideoStreamPlayer` and its audio). Save the file where the person asked with `out` (the `summer-assets` skill says how), and tell them the path and format. The file is MP4; tell the person to play it looped and muted.

## Fallback (no MCP)

If the MCP server isn't running, route the user to the Summer dashboard:

1. Image tab → generate the reference still (the loop's "neutral frame").
2. Video tab → image-to-video with `ltx`, duration 5s, aspect ratio per target.
3. Prompt with the loopable-motion vocabulary above and `"looping, seamless"`.
4. Import the clip's URL from a shell while Summer Engine runs: `summer tool import-from-url --args '{"url":"<clip url>","path":"res://assets/video/loops/<name>.ogv"}'`. It converts the clip to Ogg Theora (`.ogv`), the only video Summer Engine plays.

Print the exact prompt + model + duration + aspect ratio so the user can paste it into the dashboard.

## Handoff

Once the loop is wired:

> Loop `title_screen_bg` is wired to `TitleScreen/BackgroundLoop` with autoplay + loop. Next:
> - Score the menu with `music-track` — a quiet ambient bed scored to the loop's mood.
> - For the logo and menu UI on top, hand off to `ui-graphics`.
> - If the user wants a punchy 5s shot for the trailer using the same look, hand off to `trailer-shot` (reuse the reference image).
> - If the user wants a narrative intro that plays *before* the title loops, hand off to `cinematic-cutscene`.

## See also

- `trailer-shot` — punchy marketing footage.
- `cinematic-cutscene` — narrative cutscenes with dialogue.
- `music-track` — score the menu.
- `ui-graphics` — logo, menu buttons, HUD that sits over the loop.
- `concept-art` — produce the reference still that anchors the loop.
- `summer_docs_read` id `reference/mcp-tools-reference` — how to call `assets.generate_video`; `summer_search` returns its exact input.

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@latest` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `summer_assets_generate_image` | `summer assets generate-image` |
| `assets.generate_video`, `summer_assets_generate_video` | `summer assets generate-video` |
| `summer_assets_search` | `summer assets search` |
| `summer_docs_read` | `summer docs read` |
| `summer_add_node` | `summer engine add-node` |
| `summer_import_asset` | `summer engine import-asset` |
| `summer_import_asset_by_id` | `summer engine import-asset-by-id` |
| `summer_import_from_url` | `summer engine import-from-url` |
| `summer_run_script` | `summer engine run-script` |
| `summer_set_prop` | `summer engine set-prop` |
| `jobs.wait`, `summer_jobs_wait` | `summer jobs wait` |
| `summer_search` | `summer ops search "<what you want>"` |
<!-- /shell-commands -->
