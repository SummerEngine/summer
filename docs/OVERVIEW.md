# How Summer Works

Summer Engine is the AI game engine. **Summer** — this repo — is the open-source layer that makes any coding agent fluent in it.

Source: [github.com/SummerEngine/summer-engine-agent](https://github.com/SummerEngine/summer-engine-agent)

## What's in here

Three things, plus glue.

**Skills.** Markdown files. Each one is a discipline guide — debug, brainstorm, FPS controller, multiplayer, art direction, ship. They auto-fire on natural language. No slash command needed.

**MCP server.** A focused tool registry that talks to a running Summer Engine on `localhost:6550`. Scene mutation, asset import, runtime control, diagnostics, generation. Your agent calls them; the engine moves.

**CLI.** Install the engine, log in, scaffold projects, run them, run doctor — and `summer tool <name>` runs any MCP tool from the terminal. The complete command reference is in [`DEVELOPMENT.md`](DEVELOPMENT.md#cli-command-reference); `summer --help` is the source of truth.

The glue: **lifecycle hooks** (session-start orientation, opt-in pre-commit doctor), plugin manifests for plugin-capable harnesses, and `summer setup` targets for Claude Code, Cursor, Codex, Gemini, OpenCode, GitHub Copilot CLI, GitHub Copilot in VS Code, Cline, Roo Code, Kilo Code, LM Studio, and Devin Desktop (formerly Windsurf). The per-client map is [`../integrations/README.md`](../integrations/README.md).

## Quick start

Paste this into your AI environment:

```text
Install Summer Engine and let's make a game.
```

That is the preferred setup wizard. The agent reads the install playbook, runs `npx -y summer-engine@latest doctor --json`, downloads and logs in only if those checks need it, always runs `setup` (idempotent: MCP config + every skill in the library), and opens the engine.

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

Use **Summer MCP tools** for project file reads/writes and anything that needs the running engine: scene nodes, resources, project settings, asset import, play mode, console output, diagnostics.

Use the **host agent's native tools** for git, shell, and grep. Project file writes should use `summer_write_file`/`summer_replace_text` so the engine can enforce project identity and content guards.

For live scene hierarchy/inspector work, prefer scene tools. Guarded `.tscn` text writes are available for complete-file work and trigger engine reload handling.

## Scripting

Summer games use the Summer SDK. GDScript is the default creator language. Pick
one:

- **GDScript** (`.gd`) — default. Best supported by Summer skills (see the `gdscript-patterns` skill).
- **C#** (`.cs`) — supported by the engine. No `csharp-patterns` skill
  exists yet. Use the upstream C# API reference matching the current Summer
  technical base. C# has a different lifecycle, signal API, and export
  attributes, so do not blindly translate GDScript idioms.

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
