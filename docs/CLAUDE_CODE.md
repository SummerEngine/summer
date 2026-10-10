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

### Summer Games

`summer setup claude-code` also adds Summer Games, so Claude Code can see your friends, start parties and send messages as you:

```json
{
  "mcpServers": {
    "summer-games": { "type": "http", "url": "https://mcp.summer.games/mcp" }
  }
}
```

Sign in once: run `/mcp` in Claude Code and choose `summer-games`. A summer.games page opens in your browser; sign in and choose Allow. No key or password is stored in the file. If you already added the same URL under another name, setup keeps yours. `--no-games` skips it.

To remove Summer: `claude mcp remove summer-engine -s user` and `claude mcp remove summer-games -s user`.

Run the engine before asking Claude Code to modify scenes:

```bash
npx -y summer-engine@latest run path/to/project
```
