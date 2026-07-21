# Cursor

Cursor uses Summer skills as generated project rules.

## Recommended Setup

Paste this into Cursor:

```text
Install Summer Engine and let's make a game.
```

Cursor should run the setup playbook with `npx -y summer-engine@latest`, install project rules, configure MCP, run doctor, and open the engine.

## Install Rules

Project rules:

```bash
npx -y summer-engine@latest setup cursor --yes --force
```

This creates:

```text
.cursor/rules/summer-<skill>.mdc
```

User rules:

```bash
npx -y summer-engine@latest skills install --recommended --agent cursor --scope user
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
npx -y summer-engine@latest run path/to/project
```

Cursor should use Summer MCP tools for project files and scene/editor operations. Native file edits bypass project identity and content guards and should be reserved for when MCP is unavailable.
