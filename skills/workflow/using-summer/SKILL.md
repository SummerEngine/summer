---
name: using-summer
description: Use when starting any conversation in a Summer Engine project — establishes how to find and use Summer skills and the summer-engine MCP, requiring Skill tool invocation before ANY response including clarifying questions.
license: MIT
compatibility: [Cursor, Claude Code, Codex, Windsurf, Gemini, OpenCode, Factory, Copilot]
category: _meta
user-invocable: false
---

<SUBAGENT-STOP>
If you were dispatched as a subagent to execute a specific task, skip this skill. The parent agent has already loaded it.
</SUBAGENT-STOP>

<EXTREMELY-IMPORTANT>
If you think there is even a 1% chance a Summer skill might apply to what you are doing, you ABSOLUTELY MUST invoke the skill.

IF A SKILL APPLIES TO YOUR TASK, YOU DO NOT HAVE A CHOICE. YOU MUST USE IT.

This is not negotiable. This is not optional. You cannot rationalize your way out of this.
</EXTREMELY-IMPORTANT>

## Instruction Priority

Summer skills override default model behavior, but **user instructions always win**:

1. **User's explicit instructions** (CLAUDE.md, GEMINI.md, AGENTS.md, direct requests) — highest priority.
2. **Summer skills** — override default agent behavior where they conflict.
3. **Default system prompt** — lowest priority.

If `CLAUDE.md` says "skip the brainstorm, just build it" and a skill says "always brainstorm first" — follow the user. The user is in control.

## What Summer Is

**Summer Engine** is an AI-native game engine — editor, scene graph, asset pipeline, and runtime are all instrumented for programmatic control by AI agents. **Summer** (this skill set + MCP server) is how your coding agent talks to it.

Two layers:

- **Skills** — discipline guides that fire on specific situations: brainstorming a game, designing a mechanic, building an FPS controller, debugging a crash, shipping a build. Each one is a SKILL.md you load via the Skill tool.
- **MCP tools** — `summer_*` tools that talk to the running Summer Engine on `localhost:6550`. Scene mutation (`summer_add_node`, `summer_set_prop`), inspection (`summer_get_scene_tree`, `summer_inspect_node`), play/diagnostics (`summer_play`, `summer_get_diagnostics`), asset import/generation (`summer_import_from_url`, `summer_generate_3d`), and 30+ more.

## Fresh post-connect route

If Summer was just connected and the user has not supplied a game goal, ask one
ordinary-text question and wait:

> Do you already know what game you want to make, or should we brainstorm it together?

Do not render a menu. A game build routes to `make-game`; for a vague answer it
invokes `brainstorm-game` and resumes after the brief is accepted. A concrete
description skips that interview.

**Scripting language:** Summer Engine is compatible with Godot 4.5. You can write game code in either:

- **GDScript** (`.gd`) — the default. Best supported by Summer skills (see `summer:gdscript-patterns`). Use this unless the user has explicitly chosen C#.
- **C#** (`.cs`) — fully supported by the engine. There is no `summer:csharp-patterns` skill yet — when writing C#, use the Godot 4.5 C# API from first principles. The patterns are different (different lifecycle method names, different signal API, different export attributes), so don't blindly translate GDScript idioms. Confirm with the user that they want C# before producing it; switching languages mid-project is painful.

Scenes are always `.tscn`/`.scn`. Resources are always `.tres`/`.res`. Drive the engine through `summer_*` tools — do not hand-edit `.tscn` files; the editor holds in-memory state that diverges from disk.

The engine must be running for MCP tools that touch scenes or diagnostics. If it isn't, the tool returns an error pointing the user at `summer run`.

`.summer/` is the project's durable memory. `summer_get_project_context` surfaces a lightweight `projectMemory` summary; use it to read only the relevant Markdown before creative, audio, dialogue, level, or character work. Facts marked `priority: locked` are stable project decisions and require explicit user confirmation before changing.

## How to Access Skills

**Claude Code / Cursor / Codex / Copilot CLI:** Use the `Skill` tool. When you invoke a skill, its content loads — follow it directly. Never use `Read` on a skill file.

**Gemini CLI:** Use `activate_skill`.

**OpenCode:** Skills are auto-discovered from the registered directory; load via OpenCode's native skill mechanism.

## The Rule

**Invoke the relevant skill BEFORE any response or action.** Even a 1% chance a skill might apply means you check. If the loaded skill turns out not to fit, you don't have to follow it — but you do have to load it first to know.

```
User message arrives.
  │
  ├── Does any Summer skill match?  ── No  ──▶  Respond directly.
  │                                  │
  │                                 Yes
  │                                  │
  ├── Invoke the Skill tool.
  ├── Announce: "Using summer:<skill> to <purpose>."
  ├── If the skill has a checklist, create a todo per item.
  └── Follow the skill exactly.
```

## Red Flags (You Are Rationalizing — Stop)

These thoughts mean STOP. Check skills first.

| Thought | Reality |
|---|---|
| "This is just a quick fix" | Quick fixes break games. Check the skill. |
| "I know how to add a node, I'll just call the MCP" | The skill encodes the order of operations. Check it. |
| "The user just wants me to start" | Route the game build to `make-game`; it invokes `brainstorm-game` only for a vague idea. |
| "I can read the .tscn file directly" | `summer_get_scene_tree` and `summer_inspect_node` are authoritative. Files lag the editor's in-memory state. |
| "I'll skip the soul file" | `.summer/GameSoul.md` is what every other skill reads. Honor it. |
| "This voice or canon fact is probably fine to change" | Check `.summer/memory` first. `priority: locked` facts require explicit user confirmation. |
| "They named the game and core loop, but I should still onboard them" | Do not repeat onboarding for a concrete brief. Extract acceptance criteria and invoke `make-game`. |
| "I'll write the GDScript myself, no skill" | `gdscript-patterns` encodes idioms that Claude/Codex/Cursor regularly get wrong (signal connection, type hints, `_ready` vs `_process`). |
| "The engine isn't running, I'll just edit files" | Editing scene files directly while the engine is running silently overwrites in-memory state. Check the skill. |
| "I remember this skill" | Skills evolve. Re-read the current version. |

## Skill Priority

When multiple Summer skills could apply, run them in this order:

1. **Route first** — new-game requests use `make-game`; it invokes
   `brainstorm-game` only for vague ideas. Bugs use `debug`; runtime requests
   use `play`.
2. **Discipline skills second** — `gdscript-patterns`, `scene-composition`, `art-direction`, `audio-direction`. These shape the content.
3. **Build skills third** — `fps-controller`, `design-mechanic`, `design-level`, `setup-multiplayer`. These produce the artifacts.

> "I want to make a game, but I do not know what" → `make-game`, then its
> `brainstorm-game` branch.
> "Make a 3D parkour game with jumping and respawn" → `make-game` directly.
> "Fix this crash" → `debug` first, then domain skills.
> "Add an FPS controller" → check `scene-composition` first, then `fps-controller`.

## Skill Types

- **Rigid skills** (`debug`, `gdscript-patterns`): follow exactly. Don't adapt away the discipline.
- **Flexible skills** (`art-direction`, `design-mechanic`): adapt the principles to the project.

The skill itself tells you which. Default to rigid when unsure.

## When the Engine Isn't Running

If an MCP tool returns "Summer Engine is not running":

1. Tell the user: `summer run` to start it (or open Summer Engine and load the project).
2. While waiting, do non-MCP work — read code, plan the next steps, draft GDScript.
3. Retry the tool. The MCP server lazy-reconnects on the next call.

Do NOT fall back to editing `.tscn` files directly. The engine reads them on disk but holds in-memory state that diverges, and saving from the editor will overwrite your file edits.

## When the User Hasn't Set Up Summer

If skills aren't found or the MCP server fails to start:

1. Check whether `summer` is on PATH: `which summer` / `where summer`.
2. If not, point them at: `npx -y summer-engine@latest setup <agent> --yes --force`.
3. If `summer doctor` is available, run it: `summer doctor` reports auth, engine, port, project memory, and skill state.

## User Instructions Trump Everything

A direct user instruction ("skip the brainstorm", "just write the code", "don't use the MCP, edit files") overrides this skill. Surface the trade-off in one sentence ("Skipping brainstorm — heads up, scope creep is the most common reason game projects die.") and proceed as instructed.
