# Installing Summer in OpenCode

OpenCode loads plugins as JavaScript modules from `node_modules`, so installation = `npm install` of this package into your OpenCode project.

## Quick install

From your OpenCode project root, run:

```bash
npm install --save-dev summer-engine
```

Then add the plugin to your `opencode.json`:

```json
{
  "plugin": ["summer-engine"]
}
```

OpenCode resolves `summer-engine` via the package's `main` field, which points to the Summer plugin entry. You can also pin to git for unreleased changes:

```json
{
  "plugin": ["summer-engine@git+https://github.com/SummerEngine/summer.git"]
}
```

Restart OpenCode. The orientation primer ("Summer Engine is loaded. …") is prepended to the first user message of every new session, and the plugin registers `node_modules/summer-engine/library/skills/` in `skills.paths` so every `summer:<slug>` skill is discoverable.

## What this gives you

- **Summer skills** under the `summer:` namespace, including `using-summer`, `brainstorm-game`, `debug`, `play`, `fps-controller`, `gdscript-patterns`, `scene-composition`, `art-direction`, and more.
- **A `summer-engine` MCP server** — start it with `npx summer-engine mcp` and OpenCode will route scene/diagnostics/asset tools to your local Summer Engine running on `localhost:6550`.
- **Session-start orientation** — first user message of every session is prefixed with the using-summer primer so the model invokes skills before responding.

## Configure the MCP server

Add this block to your `opencode.json` so OpenCode launches the MCP server on demand:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "summer-engine": {
      "type": "local",
      "command": ["npx", "-y", "summer-engine@latest", "mcp"]
    }
  }
}
```

This is exactly what `npx -y summer-engine@latest setup opencode --yes` writes (to `~/.config/opencode/opencode.json`, or `./opencode.json` with `--scope project`). OpenCode's local MCP entries take `type: "local"` and an array `command`; the older `{ "command": "npx", "args": [...] }` shape is not accepted.

## Verify

In a fresh OpenCode session, ask:

> Let's make an FPS in Summer Engine.

The model should load the `summer:fps-controller` skill (via its `skill` tool) before writing any code. If it doesn't, the plugin isn't loaded — check `opencode.json` and your `node_modules/summer-engine/` install.

## Troubleshooting

| Symptom | Fix |
|---|---|
| No orientation banner appears | Verify `plugin` array in `opencode.json` and that `summer-engine` is installed in `node_modules/`. |
| MCP tools return "not connected" | Run `summer run` to launch the engine. The MCP server lazy-connects on the first tool call. |
| `summer` command not found | Use `npx -y summer-engine@latest <command>` or install the CLI globally only if you want a persistent `summer` command. |
| Skills don't auto-trigger | The using-summer skill loads on first user message; if that message is empty (e.g. a startup probe), they'll trigger on the second. |

## Uninstall

```bash
npm uninstall summer-engine
```

Remove the `plugin` and `mcp` entries from `opencode.json`.
