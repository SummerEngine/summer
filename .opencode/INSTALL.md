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
  "plugin": [
    "summer-engine/.opencode/plugins/summer.js"
  ]
}
```

Restart OpenCode. The orientation banner ("Summer Engine is loaded. N skills available…") will appear at the top of every new session, and skills will auto-discover from `node_modules/summer-engine/skills/`.

## What this gives you

- **24 auto-trigger skills** under the `summer:` namespace, including `using-summer`, `brainstorm-game`, `debug`, `play`, `fps-controller`, `gdscript-patterns`, `scene-composition`, `art-direction`, and more.
- **A `summer-engine` MCP server** — start it with `npx summer-engine mcp` and OpenCode will route scene/diagnostics/asset tools to your local Summer Engine running on `localhost:6550`.
- **Session-start orientation** — first user message of every session is prefixed with the using-summer primer so the model invokes skills before responding.

## Configure the MCP server

Add this block to your `opencode.json` so OpenCode launches the MCP server on demand:

```json
{
  "mcp": {
    "summer-engine": {
      "command": "npx",
      "args": ["summer-engine", "mcp"]
    }
  }
}
```

## Verify

In a fresh OpenCode session, ask:

> Let's make an FPS in Summer Engine.

The model should auto-invoke the `summer:fps-controller` skill before writing any code. If it doesn't, the plugin isn't loaded — check `opencode.json` and your `node_modules/summer-engine/` install.

## Troubleshooting

| Symptom | Fix |
|---|---|
| No orientation banner appears | Verify `plugin` array in `opencode.json` and that `summer-engine` is installed in `node_modules/`. |
| MCP tools return "not connected" | Run `summer run` to launch the engine. The MCP server lazy-connects on the first tool call. |
| `summer` command not found | `npm install -g summer-engine` for the global CLI. |
| Skills don't auto-trigger | The using-summer skill loads on first user message; if that message is empty (e.g. a startup probe), they'll trigger on the second. |

## Uninstall

```bash
npm uninstall summer-engine
```

Remove the `plugin` and `mcp` entries from `opencode.json`.
