# Cursor

Cursor reads Summer skills from the shared `.agents/skills` folders.

## Recommended Setup

Paste this into Cursor:

```text
Install Summer Engine and let's make a game.
```

Cursor runs the install playbook from the README: it installs the skills, configures MCP, runs doctor, and opens the engine.

## Install Skills

User-wide:

```bash
npx -y summer-engine@latest setup cursor --yes --force
```

Project-local:

```bash
npx -y summer-engine@latest skills install --recommended --agent cursor --scope project
```

Single skill:

```bash
summer skills install fps-controller --agent cursor
```

Paths:

- User scope: `~/.agents/skills/<skill>/SKILL.md`
- Project scope: `.agents/skills/<skill>/SKILL.md`

Older Summer versions wrote `.cursor/rules/summer-<skill>.mdc` or `.cursor/skills/`; `setup cursor --force` removes both.

## MCP

`summer setup cursor` writes this entry to `~/.cursor/mcp.json` (or `.cursor/mcp.json` with `--scope project`):

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

Keep the engine open on the project:

```bash
npx -y summer-engine@latest run path/to/project
```

Cursor should use Summer MCP tools for project files and scene/editor operations. Native file edits bypass project identity and content guards; use them only when MCP is unavailable.
