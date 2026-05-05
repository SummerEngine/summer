# Claude Code

Claude Code can use Summer skills from `.claude/skills`.

## Install Skills

User-wide:

```bash
summer skills install --recommended --agent claude-code --scope user
```

Project-local:

```bash
summer skills install --recommended --agent claude-code --scope project
```

The legacy alias still works:

```bash
summer skills install fps-controller --as-claude-skill
```

Paths:

- User scope: `~/.claude/skills/<skill>/SKILL.md`
- Project scope: `.claude/skills/<skill>/SKILL.md`

## MCP

Add Summer as an MCP server using your Claude Code MCP configuration:

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

Run the engine before asking Claude Code to modify scenes:

```bash
summer run path/to/project
```

