# Summer Agent Kit

Summer Agent Kit is the public path for using external agents with Summer Engine. It has three pieces:

- CLI commands to install, run, and inspect Summer Engine.
- MCP tools for scene, editor, asset, play, and diagnostics operations.
- Skills and templates that give agents repeatable game-building patterns.

## Quick Start

```bash
npm install -g summer-engine
summer install
summer login
summer create 3d-basic my-game
summer run my-game
```

Start the MCP server from any MCP-compatible client:

```bash
npx summer-engine mcp
```

Install the recommended public skills for your agent:

```bash
summer skills install --recommended --agent codex
summer skills install --recommended --agent claude-code
summer skills install --recommended --agent cursor
```

`make-game` is available as an optional broad workflow, but it is excluded from the recommended set.

## Agent Targets

| Agent | User scope | Project scope | Install shape |
|-------|------------|---------------|---------------|
| `summer` | `~/.summer/skills` | `.summer/skills` | Skill folders |
| `codex` | `~/.agents/skills` | `.agents/skills` | Skill folders |
| `claude-code` | `~/.claude/skills` | `.claude/skills` | Skill folders |
| `cursor` | `~/.cursor/rules` | `.cursor/rules` | `summer-<skill>.mdc` rules |
| `windsurf` | `~/.windsurfrules` | `.windsurfrules` | Managed rule blocks |

Use `--scope project` when you want the guidance committed with a game project:

```bash
summer skills install --recommended --agent codex --scope project
summer skills install fps-controller --agent cursor --scope project
```

## Tool Boundary

Use Summer MCP tools for things that need the running engine or editor state: scene nodes, resources, project settings, asset import, play mode, console output, and diagnostics.

Use the host agent's normal file-editing tools for scripts and other text files. Do not handwrite `.tscn` files as the preferred scene workflow when Summer scene tools are available.

