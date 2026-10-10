# Claude Code

Claude Code can use Summer skills from `.claude/skills`.

## Recommended Setup

Paste this into Claude Code:

```text
Install Summer Engine and let's make a game.
```

Claude Code runs the install playbook from the README: it installs the skills, configures MCP, runs doctor, and opens the engine.

## Install Skills

User-wide:

```bash
npx -y summer-engine@latest setup claude-code --yes --force
```

Project-local:

```bash
npx -y summer-engine@latest skills install --recommended --agent claude-code --scope project
```

Single skill:

```bash
summer skills install fps-controller --agent claude-code
```

Paths:

- User scope: `~/.claude/skills/<skill>/SKILL.md`
- Project scope: `.claude/skills/<skill>/SKILL.md`

## MCP

`summer setup claude-code` writes this entry for you. To add it by hand:

```json
{
  "mcpServers": {
    "summer-engine": {
      "command": "npx",
      "args": ["-y", "summer-engine@latest", "mcp"]
    }
  }
}
```

> **Windows:** use `"command": "cmd.exe", "args": ["/c", "npx", "-y", "summer-engine@latest", "mcp"]` instead — `npx` is a `.cmd` shim on Windows and hosts that spawn it directly fail with ENOENT. `summer setup` writes the right form automatically.

Run the engine before asking Claude Code to modify scenes:

```bash
npx -y summer-engine@latest run path/to/project
```
