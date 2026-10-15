# Cursor

Cursor reads Summer skills from the shared `.agents/skills` folders.

## Recommended Setup

Paste this into Cursor:

```text
Install Summer Engine and let's make a game. Read github.com/summerengine/summer, check what I already have installed, install whatever is missing, log me in, and scaffold a starter project so we can start building.
```

Cursor runs the install playbook from the README: it installs the skills, configures MCP, runs doctor, and opens the engine.

## Install Skills

User-wide:

```bash
npx -y summer-engine@latest setup cursor --yes --force
```

Project-local:

```bash
npx -y summer-engine@latest skills install --all --agent cursor --scope project
```

`--recommended` instead of `--all` installs a smaller starter set.

Single skill:

```bash
summer skills install fps-controller --agent cursor
```

Paths:

- User scope: `~/.agents/skills/<skill>/SKILL.md`
- Project scope: `.agents/skills/<skill>/SKILL.md`

Older Summer versions wrote `.cursor/rules/summer-<skill>.mdc` or `.cursor/skills/`; `setup cursor --force` removes both.

## Summer Games

`summer setup cursor` also adds Summer Games to `~/.cursor/mcp.json`, so Cursor can see your friends, start parties and send messages as you:

```json
{
  "mcpServers": {
    "summer-games": { "url": "https://mcp.summer.games/mcp" }
  }
}
```

Sign in once: in Cursor Settings, open MCP and click Connect (or Authenticate) next to `summer-games`. A summer.games page opens in your browser; sign in and choose Allow. No key or password is stored in the file. If you already added the same URL under another name, setup keeps yours. `--no-games` skips it.

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

After `summer login` it also runs Summer's cloud operations, so Cursor needs one server. For assets, plans, the store, publishing, prices and analytics only, nothing needs installing: add `"summer-cloud": {"url": "https://mcp.summerengine.com/mcp"}` under `mcpServers` and sign in once with Connect in Cursor's MCP settings.

Keep the engine open on the project:

```bash
npx -y summer-engine@latest run path/to/project
```

Cursor should use Summer MCP tools for project files and scene/editor operations. Native file edits bypass project identity and content guards; use them only when MCP is unavailable.
