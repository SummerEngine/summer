# Summer Engine CLI

CLI and MCP tools for [Summer Engine](https://summerengine.com) — the AI-native game engine. MIT licensed.

## Install

```bash
npm install -g summer-engine
```

Or use without installing:

```bash
npx summer-engine <command>
```

## Quickstart (under 2 minutes)

```bash
summer install                       # Download the engine
summer login                         # Sign in via browser
summer create 3d-basic my-game       # Create a starter project
summer run my-game                   # Open it in the engine
summer setup claude-code --yes       # Configure MCP + install recommended skills
```

Replace `claude-code` with `codex`, `cursor`, or `windsurf`. Add `--scope project` to keep the configuration inside the project.

Verify:

```bash
summer doctor
```

Then open your agent and try one of the slash commands:

| Command | What it does |
|---|---|
| `/debug` | Triage and fix a bug end-to-end (reads engine errors, locates code, proposes fix) |
| `/play` | Run the game and report state (clean run, warnings, or crash) |

Or just describe what you want — the specialist skills (FPS controller, lighting, GDScript patterns, scene composition, UI, asset strategy) auto-trigger on natural language: "make me an FPS", "add lighting", "I need a HUD".

## Commands

| Command | Description |
|---------|-------------|
| `summer install` | Download and install Summer Engine |
| `summer login` | Sign in via browser (Google/GitHub) |
| `summer logout` | Clear auth tokens |
| `summer status` | Check engine status, port, auth state |
| `summer doctor` | Diagnose Node, login, engine, local API, MCP boot |
| `summer run [path]` | Launch engine (optionally with a project) |
| `summer open <path>` | Open a project in the running engine |
| `summer create <template> [name]` | Create new project from template |
| `summer list templates \| projects` | List available templates or local projects |
| `summer skills list` | Show available skills |
| `summer skills install <name>` | Install one skill |
| `summer skills install --recommended --agent <agent>` | Install the recommended set |
| `summer mcp` | Start the MCP server (used by Codex/Cursor/Claude Code/Windsurf) |
| `summer mcp setup <agent>` | Write MCP config for an agent |
| `summer setup <agent>` | One shot: MCP config + recommended skills + doctor |

Supported agents: `codex`, `claude-code`, `cursor`, `windsurf`. Supported scopes: `user` (default), `project`.

## Plugin install (Claude Code)

```bash
claude /plugin install summer-engine
```

That registers Summer as a plugin under the `summer:` namespace. Skills appear in the slash menu as `summer:brainstorm-game`, `summer:debug`, `summer:play`, etc. The plugin also bundles:

- A `summer-engine` MCP server (configured automatically — no manual `~/.claude.json` edit needed).
- Lifecycle hooks: a `session-start` greeter that detects Godot/Summer projects and reads `.summer/GameSoul.md`; a `pre-commit-doctor` hook (opt-in) that runs `summer doctor` before commits.

For Cursor, Codex, OpenCode, and Gemini, see [docs/CURSOR.md](docs/CURSOR.md), [docs/CODEX.md](docs/CODEX.md), and the manifests at `.cursor-plugin/`, `.codex-plugin/`, `.opencode/`, `gemini-extension.json` respectively.

## MCP Integration

`summer setup <agent>` writes the right config in the right place. If you need to do it by hand:

**Cursor** (`.cursor/mcp.json` per project, or `~/.cursor/mcp.json` user-wide):

```json
{
  "mcpServers": {
    "summer-engine": {
      "command": "npx",
      "args": ["summer-engine", "mcp"]
    }
  }
}
```

**Claude Code** (`~/.claude.json` user-wide, or `.mcp.json` per project):

```json
{
  "mcpServers": {
    "summer-engine": {
      "command": "npx",
      "args": ["summer-engine", "mcp"]
    }
  }
}
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.summer-engine]
command = "npx"
args = ["summer-engine", "mcp"]
```

The MCP server exposes focused tools for scene manipulation, inspector/resource ops, project settings, asset import, play/stop, diagnostics, and asset search/generation. Tools the host agent already has natively (file ops, git, shell, grep) are intentionally not exposed.

**Visual feedback** (viewport and game screenshots) is currently available in the Summer Engine app via the built-in Summer Agent. MCP support for screenshots is on the MVP2 roadmap, gated on host clients reliably consuming image content.

## How It Works

1. Summer Engine runs a local API server on `localhost:6550`.
2. The MCP server (`npx summer-engine mcp`) connects to that local API via a per-machine auth token (`~/.summer/api-token`) and exposes engine ops as MCP tools.
3. Agents call the MCP tools and edit `.gd`/`.cs`/`.json`/`.md` files directly with their own file tools. Scenes (`.tscn`) flow through MCP.

The engine must be running for MCP tools that touch scenes/assets/diagnostics. If it isn't, tools return a clear error pointing at `summer run`.

## Per-Agent Docs

- [Agent Kit overview](docs/AGENT_KIT.md)
- [Claude Code](docs/CLAUDE_CODE.md)
- [Codex](docs/CODEX.md)
- [Cursor](docs/CURSOR.md)
- [Skills overview](docs/SKILLS.md)
- [Templates overview](docs/TEMPLATES.md)

## Templates

Built-in templates:

- `empty` — Empty 3D project with a root node
- `3d-basic` — 3D scene with camera, light, and floor

More templates coming soon.

## Links

- [Website](https://summerengine.com)
- [Documentation](https://summerengine.com/docs)
- [Community](https://summerengine.com/community)
