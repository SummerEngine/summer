---
name: sound-effect
description: "Make sound effects (swings, hits, whooshes, reloads, UI): three versions to pick from, then wire them."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: audio
user-invocable: true
allowed-tools: Read Grep Glob Write Edit summer_assets_generate_sfx_choices summer_assets_choices summer_assets_generate_audio summer_assets_search summer_import_from_url summer_import_asset_by_id summer_add_node summer_set_prop summer_instantiate_scene summer_inspect_node summer_get_scene_tree summer_call
paths: ["audio/sfx/**", "scripts/**", "**/*.tscn"]
---

# /sound-effect — Make a Sound Effect and Wire It

> **IMPORTANT — the first sound effect in a chat:** before you generate it, ask the person one short question:
>
> > Do you want me to create three versions with three different models, and show them to you in a page where you pick?
>
> Say why in one plain line: the best model changes a lot from one sound to the next, so picking by ear gives a better result.
>
> - **Yes** → `assets.generate_sfx_choices`, tell them where to listen (their Studio tab opens the page, else `reviewUrl`), then `assets.choices` until they decide. Import the approved clips and wire them. The model they approve becomes their default.
> - **No** → `assets.generate_audio` with `capability: "sound_effects"` and **no** `modelId` (it uses their approved default, else ElevenLabs).
>
> Ask once per chat. After they answer, do not ask again in the same chat; follow their answer for the rest of it.

## When to use

- One-shots: swing, clash, scrape, hit, punch, impact, whoosh, pickup, jump, land, door, UI click.
- Timed sequences tied to an animation: reload, attack combo, door unlock.
- Short loops (hum, servo, energy field) up to a few seconds.

Not for: music or stingers (`music-track`), long location ambience (`ambient-bed`), voice (`voice-line`), the SFX vocabulary of the game (`audio-direction`).

## Steps

### 1. Read the audio bible

Read `.summer/audio-bible.md` if it exists and map the request to one of its SFX classes; obey its character and DON'Ts. If it is missing, offer `/audio-direction` or go on with sensible defaults.

### 2. Reuse before you generate

Generation costs credits (`dryRun: true` on the generate call shows how many). `assets.search({ query: "<subject>", assetType: "audio", scope: "all" })`; if a clip fits, ask whether to use it.

### 3. Write the prompt

Describe the physical event, not a mood. The shape that tested well:

```
Foley one-shot: <physical event with materials>, <transient + tail described>, close-mic, dry, no reverb, no music, no voices.
```

- Sword clash: `Foley one-shot: two steel longswords strike edge to edge, bright sharp metallic impact, short ringing tail that dies in half a second, close-mic, dry, no reverb, no music, no voices.`
- Punch: `Foley one-shot: a bare fist hits a heavy leather bag, deep thud with a slap on top, no tail, close-mic, dry, no reverb, no music, no voices.`
- Boulder drop: `Foley one-shot: a large boulder drops onto packed dirt, heavy low thump with a short rumble and a few small stones settling, close-mic, dry, no music, no voices.`

**Whooshes and swings:** say `air movement only, no metal ring, no impact`, or the model adds a clang.

**Timed sequences:** give the exact total length and the time of each event, and set `durationSeconds` to that length:

```
Foley sequence, exactly 2 seconds, three distinct mechanical sounds: at 0.2 s the empty magazine is released and pulled out with a metal click; at 1.0 s a full magazine is slammed in with a solid clack; at 1.6 s the charging handle is pulled back and released with a sharp metallic snap. Close-mic, dry, no gunshot, no music.
```

**Loops:** write `seamless loop` in the text and pass `loop: true`. Only ElevenLabs SFX v2 makes loops: use `assets.generate_audio` with `modelId: "eleven_text_to_sound_v2"`, or include it in a choice set.

Avoid: vibe words (`epic`, `cool`, `realistic`), several unrelated events in one prompt (split them, unless it is a timed sequence), and no length.

### 4. Length

- One-shots: 0.5-2 s.
- Animation-synced sounds (reloads, attacks): `durationSeconds` = the animation length, with the event times written in the prompt.
- Minimums: Stable Audio 3 SFX >= 1 s, Sonilo SFX 1.1 >= 0.5 s, ElevenLabs SFX v2 0.5-30 s. When a choice set includes Stable Audio 3, use at least 1 s and let the player use the front of the clip.

### 5. Pick the models

| Model id | Name | Use it for |
|---|---|---|
| `eleven_text_to_sound_v2` | ElevenLabs SFX v2 | Strong default on most sounds; the only one with seamless loops |
| `sonilo-sfx-1.1` | Sonilo SFX 1.1 | Strong default on most sounds |
| `stable-audio-3-sfx` | Stable Audio 3 SFX | Sometimes the best on fast movement (swings, whooshes); less consistent |

A choice set makes all three by default. To compare only two, pass `models`: ElevenLabs + Sonilo is the strong pair; include Stable Audio 3 for movement sounds.

### 6. Generate

Show the prompt and the length before you call; every version is a billed generation.

**Choice set (the person said yes):**

```
assets.generate_sfx_choices({ text: "<prompt>", durationSeconds: 1.0 })
```

The answer has `choiceSetId`, `reviewUrl`, the `clips` and `studioTabOpened`. The page opens in their open Summer Studio tab; if `studioTabOpened` is false, give them `reviewUrl`. Do not pick for them. Then:

```
assets.choices({ choiceSetId: "<id>", waitSeconds: 50 })
```

Call it again while `status` is `pending`. When it is `decided`, each clip with `approved: true` has `audioUrl`, `assetId` and the person's `note`. If they approved none, ask what to change and make a new set.

**One version (the person said no, or later sounds after a decided set):**

```
assets.generate_audio({ capability: "sound_effects", text: "<prompt>", durationSeconds: 1.0 })
```

Leave out `modelId` so their approved default runs. The description goes in `text`, not `prompt` (without `text` the call is refused: `text_required`). The answer's `asset` has `assetId`, `fileUrl` and `durationSeconds`.

No Summer project (an asset-only request, or the engine is not installed or not running): stop here. The clips are in the person's Summer library; give them the `audioUrl` of each approved version and skip steps 7 and 8.

### 7. Import

```
summer_import_from_url(url: "<audioUrl>", path: "res://audio/sfx/sword_clash_01.<ext>")
```

or `summer_import_asset_by_id(assetId: "<assetId>", path: "res://audio/sfx/sword_clash_01.<ext>")`. Keep the extension of the file you got (the end of `audioUrl` or `fileUrl`). When the person approved several versions, import each one (`_01`, `_02`, …) and play a random one per event for variety.

One-shots keep loop OFF in the Import dock; looping a one-shot clicks. For a loop: WAV uses Edit > Loop Mode = Forward; OGG/MP3 use Loop = on.

### 8. Wire

| Node | Use for |
|---|---|
| `AudioStreamPlayer` | UI and non-positional sounds |
| `AudioStreamPlayer2D` | 2D positional |
| `AudioStreamPlayer3D` | 3D positional (weapon swing in the world, footstep) |

One script adds the player with its settings; `scenePath` is the exact scene to change:

```
summer_run_script(scenePath="res://main.tscn", source="""
func run(ctx):
    ctx.add_node("AudioStreamPlayer3D", "SwingSFX", ctx.find("Player"), {
        "stream": load("res://audio/sfx/sword_swing_01.wav"),
        "bus": "SFX",
        "max_distance": 25.0,
    })
    ctx.save_scene()
""")
```

The bus must match the bible (`SFX`, `UI`, `Ambient`, …); the default bus is `Master`. If the bus does not exist, run `/audio-direction`.

Fire animation-synced sounds from the animation's Call Method Track (`play()`), not from `_process`.

For a sound that must outlive its emitter (a death blow), spawn a self-freeing player at runtime:

```gdscript
# scripts/audio/SfxOneShot.gd
extends AudioStreamPlayer3D

func _ready() -> void:
	finished.connect(queue_free)
	play()
```

Save it as a `.tscn` and instantiate it per event in GDScript (`preload(...).instantiate()` + `add_child`).

### 9. Check

`summer_inspect_node(path="Player/SwingSFX")`: verify `stream`, `bus`, `volume_db`. Too quiet: raise `volume_db` (+3 to +9, never past +12), else regenerate with a heavier description. Too long: `stop()` on a timer.

## Without Summer Engine

In a session without Summer Engine tools (the assets profile; the `summer-assets` skill has the whole loop), do steps 1-6 and skip steps 7-9 (import, wiring, scene check). With `assets.generate_sfx_choices`, the person picks in the page; then save each approved clip where the person asked with `assets.get` and `out` (the `summer-assets` skill says how), and tell them the path and format.

## Fallback (no MCP)

Print the prompt, the length and the target path (`res://audio/sfx/<name>.wav`), and tell the person to make it in Summer Studio, then import it.

## See also

- `audio-direction` — the SFX vocabulary this skill obeys
- `ambient-bed` — long looping textures
- `music-track` — music
- `voice-line` — speech
- `summer_docs_read` id `reference/mcp-tools-reference`

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@latest` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `assets.choices`, `summer_assets_choices` | `summer assets choices` |
| `assets.generate_audio`, `summer_assets_generate_audio` | `summer assets generate-audio` |
| `assets.generate_sfx_choices`, `summer_assets_generate_sfx_choices` | `summer assets generate-sfx-choices` |
| `assets.get` | `summer assets get` |
| `assets.search`, `summer_assets_search` | `summer assets search` |
| `summer_docs_read` | `summer docs read` |
| `summer_add_node` | `summer engine add-node` |
| `summer_get_scene_tree` | `summer engine get-scene-tree` |
| `summer_import_asset_by_id` | `summer engine import-asset-by-id` |
| `summer_import_from_url` | `summer engine import-from-url` |
| `summer_inspect_node` | `summer engine inspect-node` |
| `summer_instantiate_scene` | `summer engine instantiate-scene` |
| `summer_run_script` | `summer engine run-script` |
| `summer_set_prop` | `summer engine set-prop` |
<!-- /shell-commands -->
