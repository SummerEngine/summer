# How Summer Works

Summer Engine is the AI game engine. **Summer**, this repo, is the open-source layer that lets any coding agent use it.

Source: [github.com/summerengine/summer](https://github.com/summerengine/summer)

## What's in here

Three things, plus glue.

**Skills.** Markdown guides: debug, brainstorm, FPS controller, multiplayer, art direction, ship. The host loads the right one from what the user asks; no slash command needed.

**MCP server.** Tools that talk to a running Summer Engine over its local API (port 6550 by default): scene edits, asset import, runtime control, diagnostics, generation.

**CLI.** Install the engine, log in, scaffold projects, run them, run doctor — and `summer tool <name>` runs any MCP tool from the terminal. The complete command reference is in [`DEVELOPMENT.md`](DEVELOPMENT.md#cli-command-reference); `summer --help` is the source of truth.

The glue: **lifecycle hooks** (session-start orientation, opt-in pre-commit doctor), plugin manifests for plugin-capable harnesses, and `summer setup` targets for Claude Code, Claude Desktop, Codex, Cursor, Devin Desktop, Antigravity, Cline (VS Code), Cline CLI, Kilo Code, GitHub Copilot CLI, GitHub Copilot in VS Code, GitHub Copilot in Visual Studio, GitHub Copilot in JetBrains IDEs, OpenCode, Zed, Kiro, Goose, Hermes Agent, Trae, Qwen Code, Kimi Code CLI, Crush, Amp, Factory Droid, Junie, Warp, Rovo Dev CLI, Qoder CLI, Grok Build, Mistral Vibe, LM Studio. The per-client map is [`../integrations/README.md`](../integrations/README.md).

## Quick start

Paste this into your AI environment:

```text
Install Summer Engine and let's make a game.
```

The agent reads the install playbook, runs `npx -y summer-engine@latest doctor --json`, downloads and logs in only if those checks need it, always runs `setup` (idempotent: MCP config + every skill in the library), and opens the engine.

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

Skills install as `<skill>/SKILL.md`. Agents whose docs read the agentskills.io folder (`~/.agents/skills`, `.agents/skills`) share it, so one install covers Codex, Cursor, Zed, OpenCode, Copilot in VS Code, Devin Desktop, Amp, Crush, Warp, Kimi, Factory, Rovo Dev and Grok Build; the rest keep their own folder. Agents with no skills folder (Claude Desktop, Copilot in Visual Studio and JetBrains, Trae, Junie, LM Studio) get the MCP server only and pull guidance in-chat via `summer_get_agent_playbook`.

| Agent | User scope | Project scope |
|---|---|---|
| `summer` | `~/.summer/skills` | `.summer/skills` |
| `claude-code` | `~/.claude/skills` | `.claude/skills` |
| `codex` | `~/.agents/skills` | `.agents/skills` |
| `cursor` | `~/.agents/skills` | `.agents/skills` |
| `windsurf` | `~/.agents/skills` | `.agents/skills` |
| `antigravity` | `~/.gemini/config/skills` | `.agents/skills` |
| `gemini` (legacy) | `~/.gemini/extensions/summer-engine/skills` | n/a |
| `cline` | `~/.cline/skills` | `.cline/skills` |
| `cline-cli` | `~/.cline/skills` | `.cline/skills` |
| `roo-code` (legacy) | `~/Documents/Roo/Rules` (rule files `summer-<skill>.md`) | `.clinerules` |
| `kilo-code` | `~/.kilo/skills` | `.kilo/skills` |
| `github-copilot` | `~/.copilot/skills` | `.github/skills` |
| `vscode-copilot` | `~/.agents/skills` | `.agents/skills` |
| `opencode` | `~/.agents/skills` | `.agents/skills` |
| `zed` | `~/.agents/skills` | `.agents/skills` |
| `kiro` | `~/.kiro/skills` | `.kiro/skills` |
| `goose` | `~/.config/agents/skills` | `.agents/skills` |
| `hermes` | `~/.hermes/skills` | `.agents/skills` |
| `qwen-code` | `~/.qwen/skills` | `.qwen/skills` |
| `kimi-code` | `~/.agents/skills` | `.agents/skills` |
| `crush` | `~/.agents/skills` | `.agents/skills` |
| `amp` | `~/.agents/skills` | `.agents/skills` |
| `factory` | `~/.agents/skills` | `.agents/skills` |
| `warp` | `~/.agents/skills` | `.agents/skills` |
| `rovo-dev` | `~/.agents/skills` | `.agents/skills` |
| `qoder` | `~/.qoder/skills` | `.qoder/skills` |
| `grok-build` | `~/.agents/skills` | `.agents/skills` |
| `mistral-vibe` | `~/.vibe/skills` | `.agents/skills` |

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

This repo is open so you can audit, fork, and extend it.

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
                    │ HTTP localhost (6550+)
                    ▼
   ┌─────────────────────────────────────────────────────────┐
   │            Summer Engine (running locally)              │
   │   Editor, scene graph, asset pipeline, runtime          │
   └─────────────────────────────────────────────────────────┘
```

The left column — skills + MCP + CLI — is what this repo ships. The bottom box is Summer Engine, which you download and run separately.
