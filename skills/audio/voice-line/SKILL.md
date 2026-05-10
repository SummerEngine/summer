---
name: voice-line
description: Use when generating TTS voice lines — NPC barks, narrator, dialogue. Includes voice-id discovery via summer_list_models family:'audio-voice', a character-to-voice decision tree, stability/style/similarity guidance, and the multi-line dialogue case via text_to_dialogue. Trigger on "make a voice line", "narrator", "NPC says", "voice for the merchant", "TTS line", "dialogue".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: audio
user-invocable: true
allowed-tools: Read Grep Glob Write Edit summer_generate_voice summer_generate_audio summer_list_models summer_search_assets summer_import_from_url summer_add_node summer_set_prop summer_inspect_node
paths: ["audio/voice/**", "scripts/**", "**/*.tscn"]
---

# /voice-line — Generate TTS Voice for NPCs, Narrator, Dialogue

## Overview

The hardest part of TTS isn't the line — it's picking the right voice. ElevenLabs ships hundreds; pick wrong and a tough warlord NPC sounds like a podcast host. This skill walks the voice-id discovery flow (`summer_list_models` family `audio-voice`), narrows by gender / accent / age / energy, presents 4–5 finalists with sample URLs for the user to audition, and locks the pick before generating.

Then it generates one line (or a multi-turn dialogue) with the right stability / style / similarity / speed for the delivery — flat for narration, expressive for a bark, fast for an excited shout.

## When to use

- NPC bark, narrator line, dialogue between two characters, tutorial voice, menu announcer.
- Multi-line conversation with two or more voices → use `text_to_dialogue` capability.

## When NOT to use

- Non-verbal vocal SFX (grunt, scream) → `audio/sound-effect` with prompt `male grunt of pain, mid-thirties, sharp, 400ms`.
- Pre-recorded voice from a real actor — import the .mp3 / .wav with `summer_import_from_url` and skip TTS.

## Steps

### 1. Read the audio bible and any character notes

```
Read .summer/audio-bible.md
Read .summer/characters.md   # if present
Glob .summer/characters/*.md
```

If a character bible exists, the voice should match the character's age / gender / regional origin / energy. If it doesn't, ask:

> Tell me the character: gender, rough age, accent or regional flavor, and energy (calm / measured / excited / gruff). Or just give me a reference — "sounds like the captain in Mass Effect" works.

### 2. Browse the voice catalog

```
summer_list_models(family="audio-voice")
```

Returns a list with `id`, `name`, `accent`, `gender`, `age`, `description`, and `previewUrl`. Filter mentally to 8–12 candidates by the character's hard constraints (gender + age + accent), then pick 4–5 finalists with maximally distinct character (gruff vs warm vs neutral vs theatrical).

Present them to the user like this:

> Four finalists for "old gruff dwarven warlord":
> 1. **Brogan** — male, 50s, rough Scottish, gravelly. Sample: `<previewUrl>`
> 2. **Hodge** — male, 60s, neutral, weathered baritone. Sample: `<previewUrl>`
> 3. **Marrick** — male, 40s, rough English, mid-energy. Sample: `<previewUrl>`
> 4. **Old Drum** — male, 70s, deep, slow speech. Sample: `<previewUrl>`
> Audition and pick one. Or ask for four more.

Wait for the user. Do not pick for them — voice is the highest-stakes audio decision in the project.

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

> Locked voice: `Hodge` (id `21m00Tcm4TlvDq8ikWAM`). I'll use this for all `<character>` lines unless you say otherwise.

Save it in `.summer/voice-cast.md`:

```markdown
# Voice Cast

| Character | Voice name | Voice id | Notes |
|---|---|---|---|
| Captain Hodge | Hodge | 21m00Tcm4TlvDq8ikWAM | Calm, weathered, low-mid |
| Bram the Smith | Brogan | <id> | Gruff Scottish, mid energy |
```

This is the cast bible. Every future voice line uses these ids — consistency is the point.

### 5. Tune stability / similarity / style / speed for delivery

ElevenLabs voice options:

| Param | Range | Effect |
|---|---|---|
| `stability` | 0.0–1.0 | Higher = monotone, consistent. Lower = expressive, variable. |
| `similarity_boost` | 0.0–1.0 | Higher = closer to the original sample. Lower = more freedom (can drift). |
| `style` | 0.0–1.0 | Higher = more theatrical / exaggerated. 0 = neutral. |
| `speed` | 0.7–1.2 | Speech speed multiplier. |

Defaults that work as a starting point:

| Delivery | stability | similarity_boost | style | speed |
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
- **Em dashes** = sharp cut. (Note: avoid em dashes in user-facing UI copy per project standard, but they're fine in voice prompts as a delivery cue.)
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
summer_generate_voice(
  text="Hold the line. They're coming through the south gate. Ready arrows.",
  voiceId="21m00Tcm4TlvDq8ikWAM",
  modelId="eleven_multilingual_v2",
  stability=0.6,
  similarity_boost=0.75,
  style=0.2,
  speed=1.0,
  outputPath="audio/voice/hodge_hold_the_line.mp3"
)
```

`modelId` defaults to `eleven_multilingual_v2`. For very short / latency-sensitive in-game barks, `eleven_turbo_v2_5` is faster; for highest fidelity, `eleven_multilingual_v2` is the default.

### 8. Multi-line dialogue (two or more speakers)

Use `summer_generate_audio` with `capability: "text_to_dialogue"`:

```
summer_generate_audio(
  capability="text_to_dialogue",
  speakers=[
    { name: "Hodge",   voiceId: "21m00Tcm4TlvDq8ikWAM" },
    { name: "Brogan",  voiceId: "<brogan-id>" }
  ],
  script=[
    { speaker: "Hodge",  text: "They're at the gate." },
    { speaker: "Brogan", text: "Aye. Let 'em come." },
    { speaker: "Hodge",  text: "Steady. On my mark." }
  ],
  outputPath="audio/voice/dialogue_gate_warning.mp3"
)
```

This produces a single MP3 with both voices, with dialogue-aware pacing the model handles internally. For very long scripts, split into chunks of ~6 turns and concatenate.

### 9. Wire the line as `AudioStreamPlayer` on the Voice bus

```
summer_add_node(parentPath="/root/Game/NPC", type="AudioStreamPlayer", name="VoiceLine")
summer_set_prop(path="/root/Game/NPC/VoiceLine", property="stream", value="res://audio/voice/hodge_hold_the_line.mp3")
summer_set_prop(path="/root/Game/NPC/VoiceLine", property="bus", value="Voice")
summer_set_prop(path="/root/Game/NPC/VoiceLine", property="volume_db", value=0.0)
summer_set_prop(path="/root/Game/NPC/VoiceLine", property="autoplay", value=false)
```

For positional NPCs, `AudioStreamPlayer3D` with `max_distance=15.0` so distant NPCs aren't audible.

The bible's mix rule says voice ducks music: when this player starts, fade the music bus by `-6 dB`. Wire this in the bus setup or in code with `AudioServer.set_bus_volume_db()`.

### 10. Save to the cast bible

After generation, append to `.summer/voice-cast.md` so future skills find existing lines and don't regenerate. Include line text + filename + voice id.

## Reference card — voice-pick by archetype

```
Old gruff warlord:        male, 50-70, rough/weathered, low pitch, slow
Wise mentor:              male/female, 50+, warm, measured, mid-low pitch
Excited young hero:       18-28, high energy, mid-high pitch
Cold villain:             30-50, neutral/theatrical, low-mid, slow with sharp consonants
Mischievous trickster:    theatrical, light, fast cadence
Calm scholar:             30-50, neutral, mid, even cadence
Scared / breathy:         high stability=0.25, style=0.5
Robotic AI:               stability=1.0, style=0.0
Narrator cinematic:       mid-deep, neutral/theatrical, even, very stable
Narrator intimate:        warmer mid pitch, lower stability for breath
```

## Anti-patterns

- **Picking a voice without auditioning samples.** The user must hear it.
- **Reusing a voice id across two characters.** Players notice instantly. Lock the cast.
- **Stage directions in the text.** `(angrily) Get out!` is read literally as "angrily get out". Use stability/style.
- **One long blob for a multi-turn scene.** Use `text_to_dialogue` so pacing is dialogue-aware.
- **Voice on `Master` bus.** Must be on `Voice` bus so it can duck music per the bible.
- **No ducking on dialogue.** Music drowns voice; players miss lines. Always duck.
- **Picking a voice that doesn't match the character bible.** A noble queen with a cockney accent breaks immersion unless that's the joke.

## Edge cases

- **Line longer than ~1000 characters.** ElevenLabs caps per-call. Split at sentence boundaries, generate each, concatenate with `AudioStreamPlayer.queue` or chained `finished` signals.
- **Mispronunciation of a fictional word.** Spell it phonetically: `Caelthorne` → `KEL-thorn` or `KAYL-thorn`. Or use SSML if the model supports it.
- **Voice drifts in long lines.** Increase `similarity_boost` toward 0.9; or split.
- **Need a non-English line.** `eleven_multilingual_v2` supports 29 languages. Just write in the target language; the same voice id works.
- **User wants the line shorter on regen.** Edit the text first; don't try to compress with `speed` past 1.15 (artifacts).
- **NPC bark variants.** Generate 3–5 variants of the same intent (`"They're at the gate!"`, `"Enemy approaching!"`, `"Look out!"`) and pick at random in code so the bark doesn't repeat.

## Fallback (no MCP)

Print the call (text, voice id, params, target path). User runs via the Summer dashboard, then `summer_import_from_url` the result.

## Handoff

> Line `hodge_hold_the_line.mp3` wired to `NPC/VoiceLine` on the `Voice` bus. Cast bible updated. Next:
> - Generate 3 bark variants of the same intent so the NPC doesn't sound like a recording.
> - For the upcoming gate scene, run `/voice-line` with `text_to_dialogue` for the multi-turn exchange.
> - Set up music ducking on the `Music` bus when `Voice` is active (one Tween or a `BusEffect Compressor` sidechained to `Voice`).

## See also

- `audio/audio-direction` — Voice bus and ducking rules
- `audio/sound-effect` — non-verbal vocal SFX (grunt, scream)
- `audio/adaptive-music` — ducking integration
