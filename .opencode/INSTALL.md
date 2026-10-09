# Installing Summer in OpenCode

OpenCode loads plugins as JavaScript modules from `node_modules`, so you install this package into your OpenCode project with npm.

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

OpenCode resolves `summer-engine` through the package's `main` field, which points to the Summer plugin entry. To try unreleased changes, pin to git:

```json
{
  "plugin": ["summer-engine@git+https://github.com/SummerEngine/summer.git"]
}
```

Restart OpenCode. The plugin prepends a short orientation ("Summer Engine is loaded. …") to the first user message of every new session, and registers `node_modules/summer-engine/library/skills/` in `skills.paths` so OpenCode finds every Summer skill by its plain name (`using-summer`, `fps-controller`).

## What this gives you

- **Summer skills**, including `using-summer`, `brainstorm-game`, `debug`, `play`, `fps-controller`, `gdscript-patterns`, `scene-composition`, `art-direction`, and more.
- **The `summer-engine` MCP server** (configured below), which connects OpenCode to the Summer Engine editor running on your machine for scene, diagnostics and asset tools.
- **Session-start orientation**: the first user message of each session gets the orientation, so the model checks for a skill before it answers.

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

`npx -y summer-engine@latest setup opencode --yes` writes this same block (to `~/.config/opencode/opencode.json`, or `./opencode.json` with `--scope project`). OpenCode's local MCP entries take `type: "local"` and an array `command`; the older `{ "command": "npx", "args": [...] }` shape is not accepted.

## Verify

In a fresh OpenCode session, ask:

> Let's make an FPS in Summer Engine.

The model should load the `fps-controller` skill (via its `skill` tool) before writing any code. If it doesn't, the plugin isn't loaded — check `opencode.json` and your `node_modules/summer-engine/` install.

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
