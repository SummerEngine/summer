---
name: game-design
description: "Review a game or interview its creator about the design."
license: MIT
user-invocable: true
---

# Game design

Use the words after `/game-design` as the request. The bare command reviews the current game when there is one. An explicit request for an interview starts a conversation even with a game open. A creator can start with `/game-design story`, `/game-design map`, `/game-design art`, `/game-design spells`, `/game-design vfx`, or describe the problem in their own words.

Read the linked guides from this skill folder. If the skill came from an MCP library read, use the linked file IDs to read the guides and their text references. The illustrations are in the installed skill folder, and the examples describe the comparisons in words.

## Start with general game development

Open and apply [General game development](references/general/guide.md) for every invocation. Use it to find the experience the creator wants, the playable moment that can deliver it, and the next decision worth making. If the request already identifies the moment, carry it straight to the matching specialist in this turn. Give the creator one conversation and one recommendation.

**With a game**, start inspecting what the creator supplied. Read the brief or `.summer/GameSoul.md` when available. Follow the configured main scene in `project.godot`, the actual web entry in a Web Only project, or the relevant sequence in a recording or set of rules. For permitted Godot playtests with a connected editor, use the `agent-playtesting` skill. Without editor access, review the supplied project files, rules or recording. A general review follows the opening, a later decision, and its consequence or ending. A focused question starts at the named moment. Identify the inspected version and point to the file, rule or timestamp where it happens. Distinguish what you traced, what you played, and what a player told you.

**With an idea**, use what the creator has already given you. If all you have is a blank command, ask “What’s one moment you’d love someone to experience in your game?” If they bring a mood or setting, help them imagine a playable moment before asking for mechanics. Ask one question per turn. When they bring new material, use it to answer the outstanding question. If a build is inaccessible, work from a recording, rules excerpt or the creator's account.

## Choose the craft the creator is working on

An explicit craft request goes straight to the corresponding skill alongside general game development. Carry over any draft, sketch, screenshot, constraints or answers the creator supplied. A writer can start with two lines of dialogue, a map designer with a floor plan, and an artist with a description of how a place should feel. A genre can emerge later.

| What does the creator need to make or change? | Open and apply |
|---|---|
| Tell a story, find a voice, draft dialogue, stage a reveal or revise a scene that feels flat | [Story writing](references/storycraft/guide.md) |
| Lay out a level, block out a route, orient a player on the return trip, or draw a map they can use | [Map and level design](references/maps/guide.md) |
| Choose an art style, make a focal point read, or give assets, colors, lighting and motion a coherent visual language | [Art direction](references/art-direction/guide.md) |
| Invent a magic ability, choose when to cast it, tell which target it affected, or design the timing and shape of a gameplay or ambient effect | [Spells and visual effects](references/spells/guide.md) |

Let the requested change determine which specialists work together. If a line of dialogue sounds stiff, work on the writing. If a character responds to a secret they never learned, bring in narrative and characters. If a player can see two doors and cannot infer which one the clue means, look at exploration and puzzles. If they never see the second door from the fork, inspect the map layout. If the door is in frame but its silhouette disappears against the wall, inspect art direction. For intertwined problems, offer a single small comparison that separates the causes. The [closed cinema example](references/closed-cinema.md) shows how.

If players cast a spell at the right moment but misread when it takes effect, inspect its rules and visual timing together. If they can explain the spell perfectly and still never have a reason to use it, compare the decisions it offers with the relevant genre specialist. A request about ambient dust or a victory effect can start directly with visual effects. [Worked spell timing strip](references/borrowed-step.md)

## Select and invoke the specialist

Use the general skill together with the genre specialist that explains what the player is doing **at the moment under review**. A genre label is a starting point. A survival game’s troublesome inventory choice routes differently from its unreadable jump.

| What does the player do here? | Open and apply |
|---|---|
| Execute a movement, attack, rhythm, race or sport under timing or control constraints | [Action and timing](references/action/guide.md) |
| Find a route, read danger, solve a puzzle, or connect clues | [Exploration and puzzles](references/exploration/guide.md) |
| Plan a turn, counter a strategy, or shape a deck, squad or board position | [Strategy and tactics](references/strategy/guide.md) |
| Choose an upgrade, manage a run, escape with loot, or carry power into another attempt | [Progression and replay](references/progression/guide.md) |
| Build, grow, automate, or manage resources and time | [Simulation and economies](references/simulation/guide.md) |
| Express a role, interpret a character, or see a narrative choice acknowledged | [Narrative and characters](references/narrative/guide.md) |
| Coordinate, negotiate, bluff, or share decisions with other people | [Multiplayer and social play](references/multiplayer/guide.md) |
| Practice a skill for use in a new situation, or investigate evidence when learning how to inquire is the goal | [Learning and training](references/learning/guide.md) |

Use the same creator goal, observed moment, evidence, constraints and open question in both skills. Follow links relative to each skill's folder. If there is no meaningful genre match yet, continue with the general skill. Revisit the table when the activity becomes clear. If a quiet experience already has a concrete next step, it can finish there. For a hybrid, add a second genre specialist when the interaction between two activities changes the decision. For example, in a rhythm roguelite, ask whether repetitive play comes from predictable beat patterns or upgrades that leave every run feeling alike. The answer identifies what to test.

## Return one answer

Keep creator replies free of book citations and reading lists. Explain the design choice in the context of this game. Ground a review in a moment the creator can find and an interview in what they have told you.

For an idea, describe the playable moment the creator chose, the first piece worth making with their resources, and what they could learn from trying it. For an existing game, lead with what to keep or change and the observed moment that supports it. Name a competing explanation, the smallest comparison, and the result that would change your recommendation. For a craft request, give the creator a piece they can read, draw, lay out or try now. When the current game delivers the experience the creator wants, explain what earns its place. See the [worked review and interview](references/whole-game-review.md) or choose a [hands-on design workshop](references/design-workshops.md) for the question at hand.
