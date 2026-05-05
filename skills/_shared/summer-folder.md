# `.summer/` Folder Convention

> The canonical layout for project-scoped Summer state. Read this if you're authoring a skill that writes durable design output (briefs, art bible, level docs).

## Files at the root of `.summer/`

- `GameSoul.md` — the project brief. Created by `/summer:brainstorm-game`. Contains: name, one-sentence pitch, core loop, 3 mechanics max, art direction summary, scope. Updated whenever the game's high-level direction changes.
- `art-bible.md` — visual style reference. Created by `/summer:art-direction`. Contains: palette (6–15 hex codes), mood adjectives, lighting plan, post-processing notes, do/don't list, references.
- `audio-bible.md` — sonic identity. Created by `/summer:audio-direction`. Contains: music style + tempo range, SFX vocabulary (8 classes), dynamic music FSM, bus layout reference.

## Subdirectories

- `mechanics/<mechanic-name>.md` — one file per designed mechanic (e.g., `double-jump.md`, `parry.md`). Created by `/summer:design-mechanic`. Contains: input → response → feedback → failure modes → tunable parameters.
- `levels/<level-name>.md` — one file per designed level. Created by `/summer:design-level`. Contains: teaching goal, pacing curve (5 beats), encounters, secrets, reward gating.
- `npcs/<npc-name>.md` — one file per designed NPC. Created by `/summer:design-npc`. Contains: archetype, perception model, decision tree, escalation, defeat sequence.

## Conventions

- All filenames are lowercase, hyphens not underscores.
- Skills MUST ask "May I write/update `.summer/<file>`?" before any write to this folder.
- Skills MAY read existing files in `.summer/` without permission to ground their output in prior decisions.
- The folder lives in the project root (sibling to `project.godot`).
- Add `.summer/` to `.gitignore` if the user prefers it private; default is to commit it (game design lives with the game).

## Skills that write here

| Skill | Writes |
|---|---|
| `/summer:brainstorm-game` | `.summer/GameSoul.md` |
| `/summer:art-direction` | `.summer/art-bible.md` |
| `/summer:audio-direction` | `.summer/audio-bible.md` |
| `/summer:design-mechanic` | `.summer/mechanics/<name>.md` |
| `/summer:design-level` | `.summer/levels/<name>.md` |
| `/summer:design-npc` | `.summer/npcs/<name>.md` |
| `/summer:debug` | does NOT write here |
| `/summer:play` | does NOT write here |
| `/summer:vfx` | does NOT write here (VFX edits scenes/scripts) |
| `/summer:tune-performance` | optionally writes `.summer/perf-notes.md` if user requests |
| `/summer:setup-multiplayer` | optionally writes `.summer/multiplayer-architecture.md` |
| `/summer:export-and-ship` | does NOT write here (writes export configs in `project.godot`) |

## Linter check (future)

Once `_meta/skill-test` gains an executable mode, it should validate that any skill writing to `.summer/` is documented in the table above.
