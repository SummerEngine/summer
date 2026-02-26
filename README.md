# Summer Engine CLI

CLI and MCP tools for [Summer Engine](https://summerengine.com) — the AI-native game engine.

## Install

```bash
npm install -g summer-engine
```

Or use without installing:

```bash
npx summer-engine <command>
```

## Commands

| Command | Description |
|---------|-------------|
| `summer install` | Download and install Summer Engine |
| `summer login` | Sign in via browser (Google/GitHub) |
| `summer logout` | Clear auth tokens |
| `summer status` | Check engine status, port, auth state |
| `summer run [path]` | Launch engine (optionally with a project) |
| `summer open <path>` | Open a project in the running engine |
| `summer create <template> [name]` | Create new project from template |
| `summer list templates` | Show available templates |
| `summer list projects` | Show local projects |
| `summer mcp` | Start MCP server (used by Cursor/Claude Code) |

## Quick Start

```bash
summer install          # Download the engine
summer login            # Sign in
summer create 3d-basic my-game   # Create a project
summer run my-game      # Open it in the engine
```

## MCP Integration

The MCP server lets AI coding tools manipulate scenes, run games, take screenshots, and read engine diagnostics — things they can't do through file editing alone.

**23 tools** across four categories:

- **Scene** (10) — AddNode, SetProp, RemoveNode, ConnectSignal, SaveScene, etc.
- **Visual Feedback** (5) — Play, Stop, ViewportSnapshot, GameSnapshot
- **Diagnostics** (4) — GetDiagnostics, GetConsole, GetDebuggerErrors, GetSceneTree
- **Import & Project** (4) — ImportFromUrl, ProjectSetting, InputMapBind

### Setup

**Cursor** — add to `.cursor/mcp.json`:

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

**Claude Code** — add to `~/.claude/claude_code_config.json`:

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

### How It Works

1. Summer Engine runs a local API server on `localhost:6550`
2. The MCP server connects via a local auth token (`~/.summer/api-token`)
3. AI tools call MCP tools → translated to API requests → engine executes
4. The engine must be running for MCP tools to work

## Templates

Built-in project templates:

- `empty` — Empty 3D project with a root node
- `3d-basic` — 3D scene with camera, light, and floor

More templates at [github.com/SummerEngine](https://github.com/SummerEngine).

## Contributing

Issues and PRs welcome. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for architecture and [docs/ADDING_TOOLS.md](docs/ADDING_TOOLS.md) for adding MCP tools.

## License

MIT — see [LICENSE](LICENSE).

## Links

- [Website](https://summerengine.com)
- [Documentation](https://summerengine.com/docs)
- [Community](https://summerengine.com/community)
