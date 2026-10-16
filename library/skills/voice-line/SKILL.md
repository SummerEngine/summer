---
name: voice-line
description: "Generate voice lines (NPC barks, narrator, dialogue) with a character-to-voice choice and multi-line support."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: audio
user-invocable: true
allowed-tools: Read Grep Glob Write Edit summer_assets_generate_audio summer_assets_search summer_import_from_url summer_add_node summer_set_prop summer_inspect_node summer_call
paths: [".summer/**", "audio/voice/**", "scripts/**", "**/*.tscn"]
---

# /voice-line — Generate TTS Voice for NPCs, Narrator, Dialogue

## Overview

The hardest part of TTS isn't the line — it's picking the right voice; pick wrong and a tough warlord NPC sounds like a podcast host. On the ElevenLabs models **only Summer's game cast may speak**: the `voiceId` of `assets.generate_audio` must be one of the cast voices below, and any other id is refused (`voice_not_allowed`). The fal speech models (`minimax-speech-2.8-hd`, `gemini-3.8-flash-tts`, ...) speak with their own prebuilt voices instead. So the pick comes from the cast (or the project's cast bible), and this skill's job is to make that pick deliberately and then lock it.

Then it generates one line (or a multi-turn dialogue) with the right stability / style / similarity / speed for the delivery — flat for narration, expressive for a bark, fast for an excited shout.

## When to use

- NPC bark, narrator line, dialogue between two characters, tutorial voice, menu announcer.
- Multi-line conversation with two or more voices → use `text_to_dialogue` capability.

## When NOT to use

- Non-verbal vocal SFX (grunt, scream) → `sound-effect` with prompt `male grunt of pain, mid-thirties, sharp, 400ms`.
- Pre-recorded voice from a real actor — import the .mp3 / .wav with `summer_import_from_url` and skip TTS.

## Steps

### 1. Read the audio bible and any character notes

```
Read .summer/audio-bible.md
Read .summer/memory/casting/voices.md   # preferred cast memory, if present
Read .summer/voice-cast.md              # legacy cast memory, if present
Read .summer/characters.md   # if present
Glob .summer/characters/*.md
Glob .summer/memory/characters/*.md
```

If a character bible exists, the voice should match the character's age / gender / regional origin / energy. If it doesn't, ask:

> Tell me the character: gender, rough age, accent or regional flavor, and energy (calm / measured / excited / gruff). Or just give me a reference — "sounds like the captain in Mass Effect" works.

### 2. Get the voice id

Check the cast bible first (step 1). If the character already has a locked id, use it and skip to step 5.

If not, pick from Summer's game cast with the user. There is no preview-URL endpoint on this surface — do not claim you auditioned anything; the person listens to the generated line. The cast (name, role, id):

| Voice | Role | Id |
|---|---|---|
| George | Storyteller, warm | `JBFqnCBsd6RMkjVDRZzb` |
| Charlie | Hero, deep, energetic | `IKne3meq5aSn9XLyUdCD` |
| Jessica | Heroine, playful | `cgSgspJ2msm6clMCkdW9` |
| Harry | Warrior, fierce | `SOYHLrjzK2X1ezoPC6cr` |
| Callum | Trickster, husky | `N2lVS1w4EtoT3dr4eOWO` |
| Brian | Narrator, deep | `nPczCjzI2devNBz1zQrb` |
| Bill | Elder, wise | `pqHfZKP75CvOlQylNhV4` |
| Sarah | Mentor, reassuring | `EXAVITQu4vr4xnSDxMaL` |
| Adam | Villain, firm | `pNInz6obpgDQGcFmaJgB` |
| Roger | Captain, laid back | `CwhRBWXzGAHq8TQ4Fs17` |
| Lily | Actress, velvety | `pFZP5JQG7iQjIQuC4Bku` |
| Liam | Streamer, energetic | `TX3LPaxmHKxFdv7VOQHJ` |
| Matilda | Guide, knowledgeable | `XrExE9yKIg1WjnnlVkGX` |
| Daniel | Broadcaster, steady | `onwK4e9ZLuTAKqWW03F9` |
| River | Courier, relaxed | `SAz9YHcvj6GT2YYXdXww` |
| Bella | Healer, bright | `hpp4J3VqNfWAUOO0d1Us` |
| Laura | Sidekick, quirky | `FGY2WhTYpPnrIDTdsKH5` |
| Alice | Oracle, clear | `Xb7hH8MSUJpSbSDYk0k2` |
| Eric | Merchant, smooth | `cjVigY5qzO86Huf0OWal` |
| Chris | Companion, charming | `iP95p4xoKVk53GoZ742B` |
| Will | Adventurer, optimistic | `bIHbv24MWmeRgasZH58o` |

Ask:

> For `<character>` I suggest `<voice>` (<role>). OK, or another cast voice?

Omitting `voiceId` entirely is valid — `assets.generate_audio` falls back to the default voice (George, `JBFqnCBsd6RMkjVDRZzb`). That is fine for a throwaway read-through, never for a shipped cast.

Voice is the highest-stakes audio decision in the project. Do not guess ids — an id outside the cast is refused, not a different-sounding voice.

### 3. Character-to-voice decision tree (when the user wants a recommendation)

If the user says "you pick", lean on this tree:

| Character archetype | Look for |
|---|---|
| Old gruff warlord | male, 50–70, rough or weathered, low pitch, slow speech, regional accent for color |
| Wise mentor | male or female, 50+, neutral or warm, measured cadence, mid-low pitch |
| Excited young hero | 18–28, high energy, mid-high pitch, your own region's dominant accent |
| Cold villain | 30–50, neutral or theatrical, low-mid pitch, slow with sharp consonants |
| Mischievous trickster | varies age, theatrical, light pitch, fast cadence |
| Calm scholarly NPC | 30–50, neutral, mid pitch, even cadence, no regional color |
| Scared child | child voice if available; otherwise high-pitched young adult with high stability |
| Robotic / AI | flat / synthesized voice; or any voice with `stability=1.0` and `style=0.0` for monotone |
| Narrator (cinematic) | mid-deep male or female, neutral or theatrical, even cadence, very stable |
| Narrator (intimate) | warmer, mid pitch, lower stability for breathy nuance |

### 4. Lock the voice id

After the pick:

> Locked voice: `Roger` (id `CwhRBWXzGAHq8TQ4Fs17`). I'll use this for all `<character>` lines unless you say otherwise.

Ask before writing:

> May I update `.summer/memory/casting/voices.md` with this locked voice assignment?

Save it in `.summer/memory/casting/voices.md`:

```markdown
---
id: casting.voice.main-cast
type: casting
status: active
priority: locked
stable: true
providers:
  - elevenlabs
---

# Voice Cast

| Character | Voice name | Voice id | Notes |
|---|---|---|---|
| Captain Hodge | Roger | CwhRBWXzGAHq8TQ4Fs17 | Calm, weathered, low-mid |
| Bram the Smith | Harry | SOYHLrjzK2X1ezoPC6cr | Gruff, mid energy |
```

This is the cast bible. Every future voice line uses these ids — consistency is the point.

If legacy `.summer/voice-cast.md` already exists, read it first and either keep using it for this project or ask to migrate it into `.summer/memory/casting/voices.md`. Do not maintain two conflicting cast files.

### 5. Tune stability / similarity / style / speed for delivery

These go in the `voiceSettings` object of `assets.generate_audio`, in camelCase — `stability`, `similarityBoost`, `style`, `speed`, `useSpeakerBoost`. A snake_case key such as `similarity_boost` is not one of its fields and does nothing.

| Param | Range | Effect |
|---|---|---|
| `stability` | 0.0–1.0 | Higher = monotone, consistent. Lower = expressive, variable. |
| `similarityBoost` | 0.0–1.0 | Higher = closer to the original sample. Lower = more freedom (can drift). |
| `style` | 0.0–1.0 | Higher = more theatrical / exaggerated. 0 = neutral. |
| `speed` | 0.7–1.2 | Speech speed multiplier. |

Defaults that work as a starting point:

| Delivery | stability | similarityBoost | style | speed |
|---|---|---|---|---|
| Calm narration | 0.75 | 0.75 | 0.0 | 1.0 |
| Cinematic narration | 0.5 | 0.85 | 0.4 | 0.95 |
| NPC bark (combat shout) | 0.3 | 0.75 | 0.6 | 1.1 |
| NPC bark (calm idle) | 0.6 | 0.75 | 0.2 | 1.0 |
| Excited youth | 0.35 | 0.7 | 0.55 | 1.1 |
| Cold villain | 0.65 | 0.85 | 0.3 | 0.92 |
| Robotic | 1.0 | 0.85 | 0.0 | 1.0 |
| Scared / breathy | 0.25 | 0.7 | 0.5 | 1.05 |

Ask:

> Delivery flavor? Calm idle / combat shout / cinematic / robotic / scared / cold? I'll set stability and style to match.

### 6. Build the line

For a single line, the prompt is just the text. Punctuation and formatting matter:

- **Periods** = clear pauses (~300ms). Use them.
- **Commas** = short pauses (~100ms).
- **Em dashes** = sharp cut.
- **All-caps word** = stress: `You SHALL not pass.`
- **Ellipsis** = trailing pause: `I... I don't know what to say.`
- **Parenthetical stage direction is ignored** — `(angrily)` is read as the word "angrily". Use stability/style instead.

Example lines:

```
"Hold the line. They're coming through the south gate. Ready arrows."
"You shall not pass. Turn back."
"I... I don't know if I can do this."
"BREACH! BREACH! Fall back to the inner courtyard!"
```

### 7. Confirm and call

```
assets.generate_audio({
  capability: "text_to_speech",
  text: "Hold the line. They're coming through the south gate. Ready arrows.",
  voiceId: "CwhRBWXzGAHq8TQ4Fs17",
  modelId: "eleven_multilingual_v2",
  voiceSettings: { stability: 0.6, similarityBoost: 0.75, style: 0.2, speed: 1.0 }
})
```

`modelId` defaults to `eleven_multilingual_v2`. For very short / latency-sensitive in-game barks, `eleven_flash_v2_5` is faster; for highest fidelity, `eleven_multilingual_v2` is the default. A line spends the person's credits; `dryRun: true` returns its `estimate` first.

There is no `outputPath` — the answer is a hosted asset, `asset` (`assetId`, `fileUrl`, `durationSeconds`; MP3, `audio/mpeg`). Land it in the project explicitly:

```
summer_import_from_url(url="<fileUrl>", path="res://audio/voice/hodge_hold_the_line.mp3")
```

### 8. Multi-line dialogue (two or more speakers)

Use `assets.generate_audio` with `capability: "text_to_dialogue"`:

There is no `speakers` roster and no `script` array. The whole conversation is one flat `inputs` array of `{ text, voiceId }` objects, in turn order — the voice id is repeated on every line:

```
assets.generate_audio({
  capability: "text_to_dialogue",
  inputs: [
    { text: "They're at the gate.",   voiceId: "CwhRBWXzGAHq8TQ4Fs17" },
    { text: "Aye. Let 'em come.",     voiceId: "SOYHLrjzK2X1ezoPC6cr" },
    { text: "Steady. On my mark.",    voiceId: "CwhRBWXzGAHq8TQ4Fs17" }
  ]
})
```

`inputs` is required for this capability; omitting it is refused as invalid input (`inputs_required`). `modelId` defaults to `eleven_v3` here, not `eleven_multilingual_v2`. The result is a single MP3 with both voices and dialogue-aware pacing the model handles internally — import it with `summer_import_from_url` like any other clip. For very long scripts, split into chunks of ~6 turns and concatenate.

### 9. Wire the line as `AudioStreamPlayer` on the Voice bus

One script adds the player with its settings; `scenePath` is the exact scene to change:

```
summer_run_script(scenePath="res://main.tscn", source="""
func run(ctx):
    ctx.add_node("AudioStreamPlayer", "VoiceLine", ctx.find("NPC"), {
        "stream": load("res://audio/voice/hodge_hold_the_line.mp3"),
        "bus": "Voice",
        "volume_db": 0.0,
        "autoplay": false,
    })
    ctx.save_scene()
""")
```

For positional NPCs, `AudioStreamPlayer3D` with `max_distance=15.0` so distant NPCs aren't audible.

The bible's mix rule says voice ducks music: when this player starts, fade the music bus by `-6 dB`. Wire this in the bus setup or in code with `AudioServer.set_bus_volume_db()`.

### 10. Save to the cast bible

After generation, append to `.summer/memory/casting/voices.md` so future skills find existing lines and don't regenerate. Include line text + filename + voice id.

If the assignment is marked `priority: locked`, do not replace the voice id automatically. If a scene, script, import config, or user prompt conflicts with the locked memory, stop and ask whether to update memory or fix the implementation.

## Reference card — voice-pick by archetype

```
Old gruff warlord:        male, 50-70, rough/weathered, low pitch, slow
Wise mentor:              male/female, 50+, warm, measured, mid-low pitch
Excited young hero:       18-28, high energy, mid-high pitch
Cold villain:             30-50, neutral/theatrical, low-mid, slow with sharp consonants
Mischievous trickster:    theatrical, light, fast cadence
Calm scholar:             30-50, neutral, mid, even cadence
Scared / breathy:         stability=0.25, style=0.5
Robotic AI:               stability=1.0, style=0.0
Narrator cinematic:       mid-deep, neutral/theatrical, even, very stable
Narrator intimate:        warmer mid pitch, lower stability for breath
```

## Anti-patterns

- **Inventing voices.** On the ElevenLabs models only the cast in step 2 may speak, and there are no preview URLs on this surface. Pick from the cast with the user.
- **Guessing a voice id.** A wrong id is a provider error, not a different voice.
- **Reusing a voice id across two characters.** Players notice instantly. Lock the cast.
- **Changing a locked voice without approval.** A cast voice is project memory, not a throwaway generation option.
- **Stage directions in the text.** `(angrily) Get out!` is read literally as "angrily get out". Use stability/style.
- **One long blob for a multi-turn scene.** Use `text_to_dialogue` so pacing is dialogue-aware.
- **Voice on `Master` bus.** Must be on `Voice` bus so it can duck music per the bible.
- **No ducking on dialogue.** Music drowns voice; players miss lines. Always duck.
- **Picking a voice that doesn't match the character bible.** A noble queen with a cockney accent breaks immersion unless that's the joke.

## Edge cases

- **Line longer than ~1000 characters.** ElevenLabs caps per-call. Split at sentence boundaries, generate each, and play them in order by chaining the player's `finished` signal.
- **Mispronunciation of a fictional word.** Spell it phonetically: `Caelthorne` → `KEL-thorn` or `KAYL-thorn`. Or use SSML if the model supports it.
- **Voice drifts in long lines.** Increase `similarityBoost` toward 0.9; or split.
- **Need a non-English line.** `eleven_multilingual_v2` supports 29 languages. Just write in the target language; the same voice id works.
- **User wants the line shorter on regen.** Edit the text first; don't try to compress with `speed` past 1.15 (artifacts).
- **NPC bark variants.** Generate 3–5 variants of the same intent (`"They're at the gate!"`, `"Enemy approaching!"`, `"Look out!"`) and pick at random in code so the bark doesn't repeat.

## Without Summer Engine

In a session without Summer Engine tools (the assets profile; the `summer-assets` skill has the whole loop), do steps 1-8 and skip step 9 (`AudioStreamPlayer`). Step 10 still applies when the project has a `.summer/` folder; otherwise give the person the voice id with the files. Save the file where the person asked with `out` (the `summer-assets` skill says how), and tell them the path and format.

## Fallback (no MCP)

Print the call (text, voice id, params, target path). User runs via the Summer dashboard, then `summer_import_from_url` the result.

## Handoff

> Line `hodge_hold_the_line.mp3` wired to `NPC/VoiceLine` on the `Voice` bus. Cast bible updated. Next:
> - Generate 3 bark variants of the same intent so the NPC doesn't sound like a recording.
> - For the upcoming gate scene, run `/voice-line` with `text_to_dialogue` for the multi-turn exchange.
> - Set up music ducking on the `Music` bus when `Voice` is active (one Tween, or an `AudioEffectCompressor` on `Music` with `sidechain` set to `Voice`).

## See also

- `audio-direction` — Voice bus and ducking rules
- `sound-effect` — non-verbal vocal SFX (grunt, scream)
- `adaptive-music` — ducking integration

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@latest` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `assets.generate_audio`, `summer_assets_generate_audio` | `summer assets generate-audio` |
| `summer_assets_search` | `summer assets search` |
| `summer_add_node` | `summer engine add-node` |
| `summer_import_from_url` | `summer engine import-from-url` |
| `summer_inspect_node` | `summer engine inspect-node` |
| `summer_run_script` | `summer engine run-script` |
| `summer_set_prop` | `summer engine set-prop` |
<!-- /shell-commands -->
