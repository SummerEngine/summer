# Claude Code

Claude Code can use Summer skills from `.claude/skills`.

## Recommended Setup

Paste this into Claude Code:

```text
Install Summer Engine and let's make a game.
```

Claude should run the setup playbook with `npx -y summer-engine@latest`, install skills, configure MCP, run doctor, and open the engine.

## Install Skills

User-wide:

```bash
npx -y summer-engine@latest setup claude-code --yes --force
```

Project-local:

```bash
npx -y summer-engine@latest skills install --recommended --agent claude-code --scope project
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

> **Windows:** use `"command": "cmd.exe", "args": ["/c", "npx", "-y", "summer-engine@latest", "mcp"]` instead — `npx` is a `.cmd` shim on Windows and hosts that spawn it directly fail with ENOENT. `summer setup` writes the right form automatically.

Run the engine before asking Claude Code to modify scenes:

```bash
npx -y summer-engine@latest run path/to/project
```
