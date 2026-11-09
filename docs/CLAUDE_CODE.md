# Claude Code

Claude Code can use Summer skills from `.claude/skills`.

## Recommended Setup

Paste this into Claude Code:

```text
Install Summer Engine and let's make a game. Read github.com/summerengine/summer, check what I already have installed, install whatever is missing, log me in, and scaffold a starter project so we can start building.
```

Claude Code runs the install playbook from the README: it installs the skills, configures MCP, runs doctor, and opens the engine.

## The Summer plugin

The plugin is the one-step install for Claude Code (2.1.275 or later):

```text
/plugin install summer --marketplace summerengine/summer
```

Older versions: `/plugin marketplace add summerengine/summer`, then `/plugin install summer@summer-engine`.

Then type `/summer:start` for the first-run guide. The plugin brings:

- every Summer skill, as `/summer:<skill>` (for example `/summer:make-game`);
- `/summer` (routes a request to the right skill) and `/summer:start`;
- the `summer-engine` MCP server, which drives the Summer Engine desktop app and runs Summer's cloud tools after `summer login` (needs Node 22 or later);
- the `summer-cloud` MCP server, Summer's hosted server at `https://mcp.summerengine.com/mcp`, for people without the desktop app or Node. Sign in once: type `/mcp`, choose `summer-cloud`, then **Authenticate**;
- a session-start hook that adds one or two lines of context and never waits on the network.

Turn either server off in `/mcp`. Use the plugin or `summer setup claude-code`, not both: they install the same skills.

## Install Skills

User-wide:

```bash
npx -y summer-engine@latest setup claude-code --yes --force
```

Project-local:

```bash
npx -y summer-engine@latest skills install --all --agent claude-code --scope project
```

`--recommended` instead of `--all` installs a smaller starter set.

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

Without the plugin, cloud work (assets, plans, the store, publishing, prices, analytics) needs no install: `claude mcp add --transport http summer-cloud https://mcp.summerengine.com/mcp`, then `/mcp` to sign in.

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

## See the game in the Browser pane

Claude Code Desktop's Browser pane can show the running game, so Claude screenshots and checks it after each edit, as it does for a web app. In the project folder:

```bash
npx -y summer-engine@latest preview
```

Run it in the folder the Desktop session started in (the project, or the folder above it). It serves `http://127.0.0.1:5199`: the running game, or the editor viewport when no game runs. It also adds a `summer-preview` entry to `.claude/launch.json` in that folder (other entries stay as they are), so Desktop starts the preview by itself next time and verifies changes with it. Game frames come about every 20 s so the game keeps running smoothly; the Refresh button takes one now. Clicks and keys on the frame go to the running game.
