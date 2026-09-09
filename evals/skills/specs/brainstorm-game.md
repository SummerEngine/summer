---
spec: eval/skill-spec/brainstorm-game
skill: skill/brainstorm-game
status: ported
source: tests/specs/brainstorm-game.md
runner: manual   # /skill-test today; automated harness is a fast-follow (ROADMAP §3.4)
---

# Skill Spec: /brainstorm-game

## Fixture

- Empty Summer Engine project. `project.godot` exists and no `.summer/` folder exists yet.
- Summer MCP available.
- Host file tools available (Read, Write, Edit).

## Case 1: Happy Path — fresh idea, full brainstorm

**Input:** "I want to make a game but I don't know what."

**Expected behavior:**

1. Skill asks the one opening question: "One sentence — what kind of game do you want to make?"
2. (Simulated user reply: "Something like Hades, but cozy.")
3. Skill recognizes Action-Combat anchor + cozy modifier, picks Action-Combat branch, but flags the tension: "Hades is tense, cozy is calm — let's pin which side wins."
4. Skill walks: core loop candidate → user refinement → three mechanics (push back if user lists more) → one-phrase art direction → scope (recommend vertical slice).
5. Skill drafts the 1-page brief inline, shows it to the user.
6. Skill asks: "May I create `.summer/GameSoul.md` with this brief?"
7. On yes, calls `Write .summer/GameSoul.md`.
8. Skill ends with the routing question pointing to `/summer:design-mechanic` or similar.

**Assertions:**

- [ ] Skill asks ONLY the opening question first, no menu of options.
- [ ] Skill picks ONE branch, not multiple; doesn't ask 6 questions in parallel.
- [ ] Skill enforces the three-mechanic limit (pushes back if user lists more).
- [ ] Brief includes all 8 fields: Pitch, Core loop, Three mechanics, Art direction, Scope, Win condition, "One thing this is NOT", Inspirations, Parked for later.
- [ ] Skill asks "May I create `.summer/GameSoul.md`?" before writing.
- [ ] Brief is shown inline before being written so the user can react.
- [ ] Skill ends with a routing question to a next `/summer:` step.
- [ ] Skill defaults to "vertical slice" scope when the user is unsure.

## Case 2: Failure Path — `.summer/GameSoul.md` already exists

**Fixture:** Same as Case 1, except `.summer/GameSoul.md` already exists with a previous game's brief.

**Input:** "I want to brainstorm a new game."

**Expected behavior:**

- Skill reads the existing `.summer/GameSoul.md` first via `Read`.
- Skill walks the brainstorm normally.
- Before writing, skill detects the file exists and asks: "`.summer/GameSoul.md` already exists. May I overwrite it, or merge into a 'Revision 2' section below the existing brief?"
- Does NOT silently overwrite.

**Assertions:**

- [ ] Skill reads existing `.summer/GameSoul.md` before drafting the new brief.
- [ ] Skill shows the user what would change before writing.
- [ ] Skill explicitly offers overwrite vs. merge — does not default-pick.
- [ ] No `Write` call happens until the user answers.

## Case 3: Edge Case — user pitches a multiplayer 4-player co-op horror RPG with crafting

**Fixture:** Same as Case 1.

**Input:** "I want a 4-player online co-op horror RPG with crafting, base-building, dialogue trees, and procedural worlds, kind of like Valheim meets Phasmophobia meets Disco Elysium."

**Expected behavior:**

- Skill catches the multiplayer flag (4-player co-op = scope explosion) and surfaces it explicitly: "Multiplayer is its own scope category — it roughly 3x's everything. Confirm: is multiplayer non-negotiable, or could a great single-player version land first and multiplayer come later?"
- Skill enforces the three-mechanic constraint hard. Names which mechanics from the user's pitch are content vs. mechanics, e.g.: "crafting + base-building are systems, not mechanics; dialogue is a mechanic if choices change outcomes."
- Skill states a sanity-check concern: "Procedural worlds + horror + RPG depth + multiplayer at vertical-slice scope is unrealistic. Suggest scoping to one of those four pillars."
- Skill does NOT just write the brief with all five things in it.
- Skill asks the user to pick the cut.

**Assertions:**

- [ ] Skill flags multiplayer explicitly and asks about negotiability before continuing.
- [ ] Skill distinguishes "system/feature" from "mechanic" out loud.
- [ ] Skill names a scope concern instead of writing the brief verbatim from the pitch.
- [ ] Skill never writes a brief with more than three mechanics.
- [ ] Skill offers a clear cut, not a vague "scope down" platitude.

## Case 4: No Summer MCP / no host file write — fallback path

**Fixture:** Same as Case 1, except the host has no file-write tool (read-only agent in a constrained environment).

**Input:** "Help me brainstorm a game."

**Expected behavior:**

- Skill detects no write tool is available.
- Walks the brainstorm normally.
- Instead of asking "May I create `.summer/GameSoul.md`?", prints the full brief to the user with explicit save instruction: "Save this as `.summer/GameSoul.md` in your project root. Every Summer skill reads it."
- Still ends with the routing question.

**Assertions:**

- [ ] Skill does NOT call a file-write tool that doesn't exist.
- [ ] Skill prints the brief inline as a self-contained block.
- [ ] Skill includes the explicit save instruction with the canonical path.
- [ ] Skill still asks the user the brainstorm questions and the routing question.

---

This spec runs via `/skill-test brainstorm-game spec` (see `workflow/skill-test/SKILL.md`).
