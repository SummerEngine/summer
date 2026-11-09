# Summer Engine for Claude

Summer Engine is the game engine built for AI. With this plugin, Claude makes a whole game in Summer Engine, plays and tests it, and publishes it on [summer.games](https://summer.games). Summer Engine is a free desktop app for macOS and Windows: [summerengine.com](https://www.summerengine.com).

## Install

Add Summer Engine from Anthropic's directory on claude.ai, or in Claude Code:

```
/plugin install summer --marketplace summerengine/summer
```

Then run `/summer:start`.

## What you get

- **`/summer:start`**: a first-run guide. It checks what you have, helps you install what is missing, and starts your first game.
- **`/summer`**: hands your request to the right game-dev skill.
- **Game-dev skills**: making a game, scenes, movement, combat, cameras, lighting, VFX, audio, UI, multiplayer, debugging, performance, publishing, store pages and analytics. Claude loads a skill only when the task needs it.
- **Two MCP servers**: `summer-engine` drives the Summer Engine app on your computer, and `summer-cloud` is Summer's hosted server for people without the app.

## What this plugin runs and connects to

- **`summer-engine`** runs `npx -y summer-engine@latest mcp`, the open-source `summer-engine` npm package (source: [github.com/summerengine/summer](https://github.com/summerengine/summer)). npx downloads it from the npm registry on first use. It talks to the Summer Engine app on your computer over localhost. When you sign in (`summer login`), it also calls Summer's API at `www.summerengine.com` for cloud work: assets, your games, the store, publishing and analytics.
- **`summer-cloud`** connects to `https://mcp.summerengine.com/mcp`. You sign in to your Summer account once in the browser (OAuth). It has no engine tools.
- **Credits:** asset generation (images, 3D models, sound effects, music, voices) spends the credits on your Summer account. The skills tell Claude to say what it will generate before it spends them.
- **Approvals:** publishing a game and changing prices wait for your approval in Summer Studio. Deleting for good and contacting people ask you first. Summer Studio > Settings > Agent permissions sets what Claude may do on its own.
- **Usage data:** Summer sends short usage lines to `www.summerengine.com`: which tools and commands ran, whether they worked, how long they took, and the agent app name. It never sends prompts, code, file contents, file paths, project names, tool arguments or results. Before you sign in, it sends one anonymous line per computer (a random install id, the command name, the agent app and the operating system). Turn it all off with `SUMMER_NO_TELEMETRY=1` or `DO_NOT_TRACK=1`. Every field: [Telemetry](https://github.com/summerengine/summer#telemetry).
- **No hooks.** The plugin does not run anything when a session starts or when Claude uses a tool.

## Requirements

- A Summer account (free) for cloud work: [summerengine.com](https://www.summerengine.com).
- For engine work: the Summer Engine app and Node.js 22 or newer.

## Links

- Documentation: [summerengine.com/mcp](https://www.summerengine.com/mcp)
- Support: [summer.games/support](https://summer.games/support), founders@summerengine.com
- Privacy policy: [summerengine.com/privacy](https://www.summerengine.com/privacy)
- Terms: [summerengine.com/terms](https://www.summerengine.com/terms)
- License: MIT (see `LICENSE`)
