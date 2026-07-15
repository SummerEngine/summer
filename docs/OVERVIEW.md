# How Summer Works

Summer Engine is the AI game engine. **Summer** — this repo — is the open-source layer that makes any coding agent fluent in it.

Source: [github.com/SummerEngine/summer-engine-agent](https://github.com/SummerEngine/summer-engine-agent)

## What's in here

Three things, plus glue.

**Skills (60).** Markdown files. Each one is a discipline guide — debug, brainstorm, FPS controller, multiplayer, art direction, ship. They auto-fire on natural language. No slash command needed.

**MCP server.** Thirty-seven tools that talk to a running Summer Engine on `localhost:6550`. Scene mutation, asset import, runtime control, diagnostics, generation. Your agent calls them; the engine moves.

**CLI.** Install the engine, log in, scaffold projects, run them, run doctor. The terminal side.

The glue: **lifecycle hooks** (session-start orientation, optional pre-commit doctor), plugin manifests for plugin-capable harnesses, and `summer setup` targets for Claude Code, Cursor, Codex, Gemini, OpenCode, GitHub Copilot CLI, GitHub Copilot in VS Code, Cline, Roo Code, and Devin Desktop (formerly Windsurf).

## Quick start

Paste this into your AI environment:

```text
Install Summer Engine and let's make a game.
```

That is the preferred setup wizard. The agent reads the install playbook, runs `npx -y summer-engine@latest doctor --json`, installs only what is missing, writes the MCP config, installs the recommended skills, and opens the engine.

Manual fallback:

```bash
npx -y summer-engine@latest setup claude-code --yes --force
```

Get the engine:

```bash
npx -y summer-engine@latest install
npx -y summer-engine@latest login
npx -y summer-engine@latest create 3d-basic my-game
npx -y summer-engine@latest run my-game
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
| `cline` | `~/Documents/Cline/Rules` | `.clinerules` |
| `roo-code` | `~/Documents/Roo/Rules` | `.clinerules` |
| `gemini` | `~/.gemini/extensions/summer-engine/skills` | n/a |
| `github-copilot` | `~/.copilot/skills` | `.github/skills` |
| `vscode-copilot` | `~/.copilot/skills` | `.github/skills` |
| `opencode` | `~/.config/opencode/agents/summer` | `.opencode/agents/summer` |
| `windsurf` (Devin Desktop) | `~/.windsurfrules` (managed blocks) | `.windsurfrules` |

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

## Research previews

`summer cloud` and the matching `summer_cloud_*` MCP tools are an experimental R&D preview. They are optional and are not part of the core local CLI, engine, skills, or MCP workflow shown above. Expect the preview surface and behavior to change, and keep an independent backup for important projects.
