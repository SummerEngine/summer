# How Summer Works

Summer Engine is the AI game engine. **Summer** — this repo — is the open-source layer that makes any coding agent fluent in it.

## What's in here

Three things, plus glue.

**Skills (22).** Markdown files. Each one is a discipline guide — debug, brainstorm, FPS controller, multiplayer, art direction, ship. They auto-fire on natural language. No slash command needed.

**MCP server.** Thirty-seven tools that talk to a running Summer Engine on `localhost:6550`. Scene mutation, asset import, runtime control, diagnostics, generation. Your agent calls them; the engine moves.

**CLI.** Install the engine, log in, scaffold projects, run them, run doctor. The terminal side.

The glue: **lifecycle hooks** (session-start orientation, optional pre-commit doctor) and **per-agent plugin manifests** for Claude Code, Cursor, Codex, Gemini, OpenCode, Factory Droid, Copilot CLI, Windsurf.

## Quick start

Install the agent layer once:

```bash
npm install -g summer-engine
summer setup claude-code --yes      # or codex / cursor / gemini / opencode / windsurf
```

That writes the MCP config, installs the recommended skills, runs `summer doctor`. Done.

Get the engine:

```bash
summer install         # downloads Summer Engine — prints URL and size first
summer login
summer create 3d-basic my-game
summer run my-game
```

Or download from [summerengine.com/download](https://summerengine.com/download).

## Where skills live per agent

Each agent has its own home for SKILL.md files:

| Agent | User scope | Project scope |
|---|---|---|
| `summer` | `~/.summer/skills` | `.summer/skills` |
| `codex` | `~/.agents/skills` | `.agents/skills` |
| `claude-code` | `~/.claude/skills` | `.claude/skills` |
| `cursor` | `~/.cursor/rules` (as `summer-<skill>.mdc`) | `.cursor/rules` |
| `gemini` | `~/.gemini/extensions` | n/a |
| `opencode` | `node_modules/summer-engine/skills` (auto) | n/a |
| `windsurf` | `~/.windsurfrules` (managed blocks) | `.windsurfrules` |

Use `--scope project` when you want the skills committed with the game:

```bash
summer skills install --recommended --agent codex --scope project
summer skills install fps-controller --agent cursor --scope project
```

## The tool boundary

Use **Summer MCP tools** for anything that needs the running engine: scene nodes, resources, project settings, asset import, play mode, console output, diagnostics.

Use the **host agent's native tools** (Read, Write, Edit, Grep, Bash) for everything else — code files, git, shell.

Don't hand-edit `.tscn` files when Summer scene tools are available. The editor holds in-memory state that diverges from disk and silently overwrites direct edits when it saves.

## Scripting

Summer Engine is compatible with Godot 4.5. Pick one:

- **GDScript** (`.gd`) — default. Best supported by Summer skills (see `summer:gdscript-patterns`).
- **C#** (`.cs`) — fully supported by the engine. No `summer:csharp-patterns` skill yet — write from Godot 4.5 C# docs. Different lifecycle, different signal API, different export attributes. Don't blindly translate GDScript idioms.

Scenes are always `.tscn`/`.scn`. Resources are always `.tres`/`.res`.

## What's open, what's not

| | License |
|---|---|
| Summer (this repo: skills, MCP server, CLI, hooks, plugin manifests) | MIT |
| Summer Engine (binary, editor, runtime) | proprietary, free to use |
| Summer Engine Studio (asset generation, cloud) | proprietary, paid plans |

The agent layer is open so you can audit, fork, and extend. The engine is the moat.

## How the pieces fit

```
   ┌─────────────────────────────────────────────────────────┐
   │                    Your coding agent                    │
   │     Claude Code · Cursor · Codex · Gemini · …           │
   └────────────────┬────────────────────┬───────────────────┘
                    │                    │
              skills (md)          MCP tools (stdio)
                    │                    │
                    ▼                    ▼
   ┌─────────────────────────────────────────────────────────┐
   │                       Summer (CLI)                      │
   │   skills bundle + MCP server + setup + doctor           │
   └────────────────┬────────────────────────────────────────┘
                    │ HTTP localhost:6550
                    ▼
   ┌─────────────────────────────────────────────────────────┐
   │            Summer Engine (running locally)              │
   │   Editor, scene graph, asset pipeline, runtime          │
   └─────────────────────────────────────────────────────────┘
```

The left column — skills + MCP + CLI — is what this repo ships. The bottom box is Summer Engine, which you download and run separately.
