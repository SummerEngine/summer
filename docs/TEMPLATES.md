# Templates

Templates create starter Summer Engine projects. They are separate from skills: templates create files, while skills guide the agent after the project exists.

## Commands

```bash
summer list templates
summer create empty my-game
summer create 3d-basic my-game
```

## Built-In Templates

| Template | Use |
|----------|-----|
| `empty` | Minimal 3D project with a root node |
| `3d-basic` | 3D scene with camera, light, and floor |

## Agent Flow

Start with `3d-basic` for most first 3D prototypes:

```bash
summer create 3d-basic my-game
summer run my-game
summer skills install --recommended --agent codex --scope project
```

Ask the agent to inspect the project, use the installed skills, and use Summer MCP tools for scene changes.

