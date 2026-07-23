---
name: brainstorm-game
description: Use when the user explicitly wants to brainstorm, does not know what game to make, or has only a vague idea that lacks a buildable core loop. Walks through genre, scope, core loop, mechanics, and art direction, then writes a 1-page brief to `.summer/GameSoul.md`. Do not use when the user already supplied a concrete game brief; route that directly to make-game.
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: scene-and-project
user-invocable: true
allowed-tools: Read Grep Glob Write Edit summer_get_project_context summer_get_scene_tree
paths: [".summer/**", "project.godot", "**/*.md"]
---

# /brainstorm-game — Decide What Game to Build

## Overview

Most game projects fail because they were never scoped. This skill turns "I want to make a game" into a 1-page brief that names the pitch, the core loop, three mechanics max, the art direction, and the scope (jam / vertical slice / full game). The brief lands at `.summer/GameSoul.md` — the file Summer's onboarding pipeline and every future `summer:` skill reads on first turn.

**Core principle:** Constrain ruthlessly. A buildable bad idea beats an un-buildable great idea. Three mechanics, one art direction, one scope. Anything else gets parked in a "Later" list.

## Concrete brief guard

If the user already named the game shape and described the primary action or
failure/restart loop, stop this interview and return the original request to
`summer:make-game`. Do not ask them to repeat genre, core loop, mechanics, art
direction, scope, or technical architecture.

This skill is for discovering the game, not for delaying a game the user has
already defined.

## Steps

### 1. Open with the one question

Ask exactly this and wait:

> One sentence — what kind of game do you want to make?

Don't pre-pitch genres. Don't list options. Read what they say. The first sentence is signal.

If they freeze ("I don't know"), offer 4 reference points only:

> No worries. Pick the one that pulls you most: a) something cozy and exploratory (Stardew, A Short Hike), b) something tight and skill-based (Celeste, Hades), c) something story-led (Disco Elysium, Citizen Sleeper), d) something silly and short (Goat Sim, Untitled Goose). Or describe a different vibe.

### 2. Branch on genre signal

Read their answer for a genre anchor and pick **one** branch. Don't ask multiple questions in parallel.

| Anchor word(s) | Branch |
|---|---|
| "shooter", "FPS", "TPS", "combat" | Action-Combat branch |
| "platformer", "metroidvania", "souls-like" | Skill-Platforming branch |
| "RPG", "story", "narrative", "dialogue" | Narrative branch |
| "roguelike", "deckbuilder", "auto-battler" | Run-Based branch |
| "sim", "cozy", "farming", "city-builder" | Sim branch |
| "puzzle", "physics", "sandbox" | Puzzle branch |
| "horror", "atmospheric" | Horror branch |
| "multiplayer", "PvP", "co-op" | Multiplayer branch (forces the multiplayer-or-not call before scope) |

If unclear, ask the smallest disambiguating question:

> Tighter on this — is it more "tense and dangerous" or "calm and exploratory"?

### 3. Pin the core loop

A core loop is what the player does for 30 seconds, repeated. State a candidate and ask them to refine. Examples per branch:

| Branch | Candidate core loop |
|---|---|
| Action-Combat | "Enter room, read enemy patterns, kill, loot, advance." |
| Skill-Platforming | "See obstacle, attempt, fail, learn, retry, clear, next." |
| Narrative | "Walk to character, choose dialogue, see consequence, walk to next." |
| Run-Based | "Pick a card/weapon/build, fight, die, unlock, repeat with edge." |
| Sim | "Plan day, execute, harvest reward, plan next day." |
| Puzzle | "See state, form theory, test, observe, solve or rethink." |
| Horror | "Hear cue, locate threat, hide or flee, advance space." |

State your candidate. Ask:

> The 30-second loop I'm hearing: <candidate>. Does that match what you have in your head, or is the actual moment-to-moment different?

### 4. Constrain to three mechanics maximum

Force the trade. State the rule:

> Three mechanics, no more. What are the three things this game has that other games in this genre don't?

If they pitch five, push back. Not "we'll add it later" — actually cut. Two examples for them to react to:

> Hades has three: dash-attack-cast, room reward choice, and run-end conversation. Everything else (mirror upgrades, weapon variants, bosses) is content built on those three. What are yours?

Common new-dev mistake: listing features ("inventory, crafting, quests") instead of mechanics ("a single resource that's both currency and ammo"). Push them toward verbs and decisions, not nouns and systems.

### 5. Pick an art direction in one phrase

Not a paragraph. Examples to anchor:

- "Lo-fi PS1 polygons + dithered shader"
- "Hand-drawn 2D, single bold outline, 4-color palette"
- "Toon-shaded Nintendo-bright, no realistic lighting"
- "Pixel art, 16x16 tiles, GameBoy 4-shade green"

Ask:

> One phrase for the look. If a stranger asked your screenshot's style in 6 words, what do you say?

Don't go deeper here — `/summer:art-direction` is where the bible gets built. This is one phrase to seed it.

### 6. Pin the scope

State the choices flat:

> Scope. Pick one: (a) a minimum playable game — one complete interactive loop you can actually control and retry. (b) a vertical slice — 30-60 minutes of polished play that proves the core loop. (c) a full game — the complete planned content.

If they are unsure, recommend the minimum playable game first. "Minimum" never
means an empty scene: it still includes the player action, challenge, and
failure/restart or win loop.

### 7. Sanity-check the combination

Do this in your head, not out loud unless something fails:

- Is the core loop achievable with the three mechanics + the chosen art direction in the chosen scope? If not, name what has to flex (usually scope down or merge two mechanics into one).
- Is there a hidden multiplayer requirement? ("4-player" or "co-op" anywhere = stop, multiplayer is its own scope explosion.)
- Is the art direction generatable / sourceable for a solo dev? (Photoreal 3D for a 4-week vertical slice is a red flag.)

If you spot a problem, raise it once, plainly:

> One concern: <X>. Suggest <flex Y>. OK or do you want to push through anyway?

### 8. Draft the brief

Compose the 1-page brief. Format:

```markdown
# <Game Name or "Untitled">

**Pitch:** <One sentence the player would tell a friend.>

**Core loop (30s):** <What the player does, repeated.>

**Three mechanics:**
1. <Verb-led: "Parry to convert damage into mana"  not "Combat system">
2. <…>
3. <…>

**Art direction (one phrase):** <…>

**Scope:** <Jam | Vertical slice | Full game>

**Win condition:** <How the player knows they succeeded — ending? Score? Unlock?>

**One thing this is NOT:** <Define by negation. Cuts scope creep later.>

**Inspirations:** <2-4 specific games, films, or images.>

**Parked for later:** <Things they pitched that didn't make the three.>
```

### 9. Confirm the brief and write

Show the complete brief once and ask a visible-product question:

> Does this capture the game you want to build?

On yes, use `Write` (host file tool). The accepted request authorizes this
reversible project note; do not ask separately for file permission.

```
Write .summer/GameSoul.md
```

If `.summer/GameSoul.md` already exists, read it first and append a dated
revision while preserving the earlier brief. Ask only if the user explicitly
requires replacement and safe merging is impossible.

**Fallback (no host write tool — agent is read-only):**

Print the full brief to the user with the explicit instruction:

> Save this as `.summer/GameSoul.md` in your project root. Every Summer skill reads it.

### 10. Return to the build

When invoked by `summer:make-game`, return the accepted brief to that
orchestrator immediately. It should continue to the playable MVP without asking
the user to choose another workflow or exposing the internal project setup.

When invoked directly, recommend one next action in ordinary text:

> Brief saved. Ready for me to build the smallest playable version?

## Anti-patterns (don't do these)

| Anti-pattern | Why it fails |
|---|---|
| Asking 6 questions in a row before any branching | User feels interviewed, not collaborated with. Branch after each answer. |
| Letting them list 5+ mechanics | Three is the constraint. Without the constraint, the brief is useless. |
| Skipping the "one thing this is NOT" line | This is the single best scope-protection in the brief. Future "let's add X" gets compared against it. |
| Writing the brief without showing it first | They have to react to it. They'll catch their own bad fits when they read it back. |
| Defaulting to "full game" scope | New devs overestimate. Default to vertical slice; let them upgrade if they push. |
| Pitching a genre they didn't ask for | The first sentence they typed is signal. Don't override it. |
| Including art direction details | One phrase. Bible-building is `/summer:art-direction`. |
| Asking for separate file-write approval | The accepted brief already authorizes its reversible project note. |

## Collaborative protocol

This skill writes one file (`.summer/GameSoul.md`). Show the brief inline and
confirm the visible game definition before saving. Do not ask separately for
permission to write the file. See `references/collaborative-protocol.md`.

## Want a working starter?

No template — this is a workflow that produces the brief that drives template selection later. Once `.summer/GameSoul.md` exists, `/summer:make-game` can match it against `references/template-registry.md`.

## See also

- `references/collaborative-protocol.md` — material-boundary rules
- `references/template-registry.md` — templates the brief will be matched against later
- `gameplay-mechanics/design-mechanic/SKILL.md` — design the core loop in detail
- `level-design/design-level/SKILL.md` — sketch level 1
- `rendering-and-lighting/art-direction/SKILL.md` — turn the one-phrase look into a full bible
- `audio/audio-direction/SKILL.md` — sonic identity
- `scene-and-project/make-game/SKILL.md` — build the playable MVP once the brief is locked
