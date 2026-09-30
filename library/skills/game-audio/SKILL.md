---
name: game-audio
description: "Add cozy game audio in Summer: a cue for every player action, loudness and length rules, a pooled bus-aware player, generated vs synthesized sounds."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: audio
user-invocable: true
allowed-tools: Read Grep Glob Edit Write summer_get_script_errors
paths: ["**/*.gd", "**/*.gdshader", "**/*.tscn"]
---

# Cozy game audio in Summer

Proven in a cozy multiplayer garden game: one static player script, a small pipeline folder, and a
SOURCES.md with provenance next to the files.

## 1. Cue list by moment

Sound follows the player's intent: every action they choose gets an answer within 50 ms.

| Moment | Cue | Character |
|---|---|---|
| Place/plant something | `plant_seed`, `egg_place`, `sprinkler_place` | soft, low, earthy tap |
| Collect/harvest | `harvest_pop`; rare/gold → `harvest_rare` | bubbly pop; rare = harp + bells, 2-3 s |
| Money moves | `coin_tick` per coin (rate-limited), `sell_receipt` once per sale, `buy` | small metal, never a loud register |
| Refused action | `error_soft` | low, two notes down, *friendly* |
| Menus | `ui_open`, `ui_close`, `ui_click` | quiet wood/paper; UI bus |
| Care/tend | `water`, `pet_happy`, `egg_hatch` | organic |
| Movement | `footstep_grass` (3+ variants) | quietest cue in the game |
| Characters talking | `plant_talk_blip` (pitched syllables, one per letter group) | cute babble, voice set by pitch |
| Progress | `level_up`, `quest_complete`, `hunt_pickup` | short jingle, not a victory fanfare |
| Bed | music loop 60-90 s, rain/wind loops | always under everything |

## 2. Loudness and length rules

- Match by **max 100 ms RMS**, not peak: UI -25, frequent ticks -26, gameplay -20, jingles -21,
  footsteps -29 dBFS; peaks capped at -1 dBFS. Loops by integrated LUFS: music -21, rain -30.
  Why: short cues have no reliable integrated LUFS (gating), and peaks say nothing about perceived loudness.
- The more often a cue fires, the quieter and shorter it is (click 0.13 s, coin 0.5 s, fanfare < 3.5 s).
- Low-pass one-shots at 6-11 kHz and high-pass at 70 Hz. Cozy = no hiss, no rumble, no ice-pick highs.
- Trim leading silence to < 5 ms (latency feels like lag); short fade-out so nothing clicks.
- One-shots mono (3D panning works); music stereo.
- Seamless loops: crossfade the last ~1.5 s (noise) or ~0.1 s at a bar line (music) with the audio just
  before the loop start, and write `loop_begin`/`loop_end` into the `.wav.import`. Music keeps its intro
  (plays once) and is cut to whole bars.

## 3. Player pattern

One static-API node (`class_name GardenSfx`) so gameplay code calls `GardenSfx.play("harvest_pop", pos)`
without wiring:
- lazily adds itself to `root` (deferred) and queues calls until it is in the tree;
- creates buses Music / SFX / UI sending to Master (the settings slider and `--mute` on Master still apply);
- a pool of 8 `AudioStreamPlayer` + 8 `AudioStreamPlayer3D`, idle-first then round-robin steal;
- per-cue minimum interval (spam protection) and random variant + `pitch_jitter` (repeats never identical);
- a `pitch` argument for character voices; `music(on)`/`rain(on)` fade over 2.5 s;
- a const cue table with explicit paths (DirAccess listing breaks in exports).

## 4. Generation vs procedural

- **Generate** (`summer tool generate-audio`, capability `sound_effects` / `music`, ElevenLabs behind
  Summer Studio) for organic sounds: soil, water, coins, rustle, jingles, music. Always add the style tail
  "cozy cute video game sound, soft and warm, clean, dry, no background noise". Limit: 20 generations per
  10 minutes; generated assets are listed publicly in the Summer library.
- **Synthesize** (stdlib Python or `AudioStreamWAV` in GDScript) for anything that must be controllable
  and consistent: babble syllables (harmonics through two vowel formants), UI blips, chimes.
- Measure what you cannot hear: print a 10-20 ms RMS envelope of each raw file. One garden generation came
  back silent (-55 dBFS peak) and one "four footsteps" clip had faint pre-roll; the envelope caught both.

## 5. Do / don't

- DO keep `SOURCES.md` (file, tool, prompt, asset id, date, cost). Why: licensing and re-generation.
- DO verify silently: `--headless --audio-driver Dummy`, load every file, check loops, play every cue.
  Why: agents must never make the user's machine play sound unasked.
  Expect one leaked-playback warning at exit under Dummy (the mixer never runs); stop players and free the node first.
- DON'T ship stereo one-shots or unnormalized raw generations. Why: 3D panning and a +/- 20 dB spread.
- DON'T play a cue per frame or per coin without a minimum interval. Why: clipping and ear fatigue.
- DON'T add a second music player next to an existing one; duck or replace it.
- DON'T use MP3 for seamless loops (encoder padding gap). WAV + QOA import (`compress/mode=2`) is small enough.
