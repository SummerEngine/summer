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

**Scripting language:** The user is making a Summer game with the Summer SDK.
GDScript is the default creator language. Summer currently uses the 4.6.1
upstream technical base, plans to adopt 4.7.1 next, and follows upstream
continuously. Confirm version-sensitive behavior from the engine's own version
string rather than turning that base into the product identity. You can write
game code in either:

- **GDScript** (`.gd`) — the default. Best supported by Summer skills (see `gdscript-patterns`). Use this unless the user has explicitly chosen C#.
- **C#** (`.cs`) — supported by the shipped Mono build. The GDScript
  conventions in `gdscript-patterns` have no C# counterpart yet. When writing C#, use the upstream C# API
  reference matching the current Summer technical base. The lifecycle, signal
  API, and export attributes differ, so do not blindly translate GDScript
  idioms. Confirm that the user wants C# before producing it; switching
  languages mid-project is painful.

Scenes are always `.tscn`/`.scn`. Resources are always `.tres`/`.res`. Drive the engine through `summer_*` tools — do not hand-edit `.tscn` files; the editor holds in-memory state that diverges from disk.

The engine must be running for MCP tools that touch scenes or diagnostics. If it isn't, the tool returns an error pointing the user at `summer run`.

`.summer/` is the project's durable memory. `summer_get_project_context` surfaces a lightweight `projectMemory` summary; use it to read only the relevant Markdown before creative, audio, dialogue, level, or character work. Facts marked `priority: locked` are stable project decisions and require explicit user confirmation before changing.

## How to Access Skills

**Claude Code / Cursor / Codex / Copilot CLI:** Use the `Skill` tool. When you invoke a skill, its content loads — follow it directly. Never use `Read` on a skill file.

**Gemini CLI:** Use `activate_skill`.

**OpenCode:** Skills are auto-discovered from the registered directory; load via OpenCode's native skill mechanism.

## Finding the Right Entry

Not sure which skill, tool, template, or reference covers the task? Ask the library before guessing: call `summer_search_library` with the task in plain words ("make stylized water", "the player falls through the floor"), then `summer_read_library` with the id you pick — it returns the entry itself (a skill's body and metadata, a tool's call recipe, a template's pin) and ends with the `entry_id` line to report through `summer_library_feedback` once the outcome is verified. From a shell the same two are `summer tool search-library --args '{"query":"…"}'` and `summer tool read-library --args '{"id":"…"}'`; neither needs the engine. When search names a skill, invoke it by its bare slug through your host's skill mechanism (`vfx-water-ripple`, `fps-controller`, `design-mechanic`) rather than paraphrasing the body from the read.

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
  ├── Announce: "Using <skill> to <purpose>."
  ├── If the skill has a checklist, create a todo per item.
  └── Follow the skill exactly.
```

## Red Flags (You Are Rationalizing — Stop)

These thoughts mean STOP. Check skills first.

| Thought | Reality |
|---|---|
| "This is just a quick fix" | Quick fixes break games. Check the skill. |
| "I know how to add a node, I'll just call the MCP" | The skill encodes the order of operations. Check it. |
| "The user just wants me to start" | Most "just build it" requests still benefit from the brainstorm-game skill. Offer it. |
| "I can read the .tscn file directly" | `summer_get_scene_tree` and `summer_inspect_node` are authoritative. Files lag the editor's in-memory state. |
| "I'll skip the soul file" | `.summer/GameSoul.md` is what every other skill reads. Honor it. |
| "This voice or canon fact is probably fine to change" | Check `.summer/memory` first. `priority: locked` facts require explicit user confirmation. |
| "I don't need to brainstorm — they said FPS" | Even with the genre named, brainstorm-game scopes mechanics, art direction, and the cut list. Skip only if explicitly told to. |
| "I'll write the GDScript myself, no skill" | `gdscript-patterns` encodes idioms that Claude/Codex/Cursor regularly get wrong (signal connection, type hints, `_ready` vs `_process`). |
| "The engine isn't running, I'll just edit files" | Editing scene files directly while the engine is running silently overwrites in-memory state. Check the skill. |
| "I remember this skill" | Skills evolve. Re-read the current version. |

## Skill Priority

When multiple Summer skills could apply, run them in this order:

1. **Process skills first** — `brainstorm-game`, `debug`, `play`. These determine HOW to approach the task.
2. **Discipline skills second** — `gdscript-patterns`, `scene-composition`, `art-direction`, `audio-direction`. These shape the content.
3. **Build skills third** — `fps-controller`, `design-mechanic`, `design-level`, `setup-multiplayer`. These produce the artifacts.

> "I want to make a game" → `brainstorm-game` first, then build skills.
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

## When Summer Is Stale

Run `summer doctor` early in a fresh Summer session when setup, MCP tools, slash commands, or skills behave oddly. If doctor reports `cli-version-current` or `skills-version-stale` as warning/fail, refresh before continuing:

```
npx clear-npx-cache && npx -y summer-engine@latest setup <agent> --yes --force
```

Use the real agent slug from doctor or the current environment (`claude-code`, `codex`, `cursor`, `gemini`, `github-copilot`, `vscode-copilot`, `opencode`, etc.).

Why this exact command matters:

- `@latest` forces npm/npx to resolve the current published Summer CLI instead of reusing a stale cached package.
- `clear-npx-cache` clears old npx package material on machines that keep serving an older Summer.
- `setup ... --force` rewrites copied skill/slash-command files, which do not update just because the MCP server restarted.

After the refresh, restart or reload the agent/MCP session if tools were missing. MCP tool changes load on MCP reconnect; copied skills and slash commands load when the agent notices the rewritten files or starts a fresh session.

## User Instructions Trump Everything

A direct user instruction ("skip the brainstorm", "just write the code", "don't use the MCP, edit files") overrides this skill. Surface the trade-off in one sentence ("Skipping brainstorm — heads up, scope creep is the most common reason game projects die.") and proceed as instructed.
