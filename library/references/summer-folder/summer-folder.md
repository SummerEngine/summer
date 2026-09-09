# `.summer/` Folder Convention

> The canonical layout for project-scoped Summer state. Read this if you're authoring a skill that writes durable design output, locked project memory, or agent-readable design notes.

## Files at the root of `.summer/`

- `GameSoul.md` — the project brief. Created by `/brainstorm-game`. Contains: name, one-sentence pitch, core loop, 3 mechanics max, art direction summary, scope. Updated whenever the game's high-level direction changes.
- `art-bible.md` — visual style reference. Created by `/art-direction`. Contains: palette (6–15 hex codes), mood adjectives, lighting plan, post-processing notes, do/don't list, references.
- `audio-bible.md` — sonic identity. Created by `/audio-direction`. Contains: music style + tempo range, SFX vocabulary (8 classes), dynamic music FSM, bus layout reference.
- `build-plan.md` — implementation plan derived from `GameSoul.md`. Created by `/make-game` before scaffold/build work.
- `project.json` — written by `summer create`, not by skills: the template pin (`id`, `version`, and `repo` + `commit` + `tree_digest` or `builtin: true`), `toolkit_version`, `created_at`. Read it to learn which template started the project; never edit it by hand.

## Subdirectories

- `mechanics/<mechanic-name>.md` — one file per designed mechanic (e.g., `double-jump.md`, `parry.md`). Created by `/design-mechanic`. Contains: input → response → feedback → failure modes → tunable parameters.
- `levels/<level-name>.md` — one file per designed level. Created by `/design-level`. Contains: teaching goal, pacing curve (5 beats), encounters, secrets, reward gating.
- `npcs/<npc-name>.md` — one file per designed NPC. Created by `/design-npc`. Contains: archetype, perception model, decision tree, escalation, defeat sequence.
- `memory/` — structured project memory for durable facts that must survive future sessions. Use this for locked cast decisions, character facts, provider IDs, world canon, and conflict notes.
- `skills/` — installed project-scoped Summer skills. Do not put game design memory here.

## Structured memory

Use `.summer/memory/` when the fact is more specific than a bible, must be re-used by many skills, or must not silently drift. Examples:

- `memory/casting/voices.md` — stable character-to-voice assignments, including ElevenLabs voice IDs.
- `memory/characters/<character-name>.md` — canonical character facts, aliases, personality, visual/audio constraints, linked assets.
- `memory/world/canon.md` — lore and setting facts that dialogue, quests, levels, and art should not contradict.
- `memory/systems/<system-name>.md` — gameplay rules and implementation decisions that cross scenes/scripts.
- `memory/decisions/<yyyy-mm-dd-topic>.md` — rationale for important choices.
- `memory/conflicts/open.md` — unresolved conflicts between memory and implementation.

Markdown is canonical. Optional generated indexes such as `memory/index.json` may exist for UI/search speed, but agents must treat the Markdown files as the source of truth.

Locked facts should use short YAML frontmatter:

```yaml
---
id: casting.voice.main-cast
type: casting
status: active
priority: locked
stable: true
applies_to:
  - character:bob
  - character:sarah
providers:
  - elevenlabs
---
```

Then write the fact in normal Markdown so users can inspect and edit it:

```markdown
# Main Voice Cast

| Character | Provider | Voice ID | Stability |
|---|---|---|---|
| Bob | ElevenLabs | `voice_bob_id` | locked |
| Sarah | ElevenLabs | `voice_sarah_id` | locked |
```

## Conventions

- All filenames are lowercase, hyphens not underscores.
- Skills MUST ask "May I write/update `.summer/<file>`?" before any write to this folder.
- Skills MAY read existing files in `.summer/` without permission to ground their output in prior decisions.
- The folder lives in the project root (sibling to `project.godot`).
- Add `.summer/` to `.gitignore` if the user prefers it private; default is to commit it (game design lives with the game).
- Changing a `priority: locked` memory requires explicit user confirmation. If implementation data conflicts with locked memory, stop and ask whether to update memory or fix the implementation.

## Skills that write here

| Skill | Writes |
|---|---|
| `/brainstorm-game` | `.summer/GameSoul.md` |
| `/art-direction` | `.summer/art-bible.md` |
| `/audio-direction` | `.summer/audio-bible.md` |
| `/design-mechanic` | `.summer/mechanics/<name>.md` |
| `/design-level` | `.summer/levels/<name>.md` |
| `/design-npc` | `.summer/npcs/<name>.md` |
| `/voice-line` | `.summer/memory/casting/voices.md` |
| `/debug` | does NOT write here |
| `/play` | does NOT write here |
| `/game-feel`, `/vfx-<effect>` | does NOT write here (VFX edits scenes/scripts) |
| `/tune-performance` | optionally writes `.summer/perf-notes.md` if user requests |
| `/setup-multiplayer` | optionally writes `.summer/multiplayer-architecture.md` |
| `/export-and-ship` | does NOT write here (writes export configs in `project.godot`) |

## Linter check (future)

Once the `skill-test` skill gains an executable mode, it should validate that any skill writing to `.summer/` is documented in the table above.
