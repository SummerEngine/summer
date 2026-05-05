# Cursor

Cursor uses Summer skills as generated project rules.

## Install Rules

Project rules:

```bash
summer skills install --recommended --agent cursor --scope project
```

This creates:

```text
.cursor/rules/summer-<skill>.mdc
```

User rules:

```bash
summer skills install --recommended --agent cursor --scope user
```

The legacy alias still works:

```bash
summer skills install fps-controller --as-cursor-skill
```

## MCP

Add Summer to `.cursor/mcp.json`:

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

Keep the engine open on the project:

```bash
summer run path/to/project
```

Cursor should use Summer MCP tools for scene/editor operations and its native editor for scripts and text files.

