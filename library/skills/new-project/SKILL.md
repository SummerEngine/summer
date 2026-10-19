---
name: new-project
description: "Create a blank Summer Engine project: ask for the project name and run summer create empty."
license: MIT
compatibility: [Cursor, Claude Code, Codex, Windsurf, Gemini, OpenCode]
category: scene-and-project
user-invocable: true
allowed-tools: Bash Read summer_get_project_context
paths: ["**/project.godot"]
---

# /new-project — Scaffold a fresh empty project

Use this when the user wants a blank project instead of a template.

## When to use this skill

- "Let's start a new project."
- "I want to make a [game type] from scratch."
- "Blank project."
- "Empty project."
- "I don't want a template, just a blank starting point."

## When NOT to use this skill

- "Show me templates" / "use a template" → `browse-templates`.
- "Make me a game" with a defined idea → run `brainstorm-game` first to scope, then come back here once the user knows what they want.
- "I have an existing Godot project I want to import" → not this skill; have the user run `summer open <path>` directly.

## Steps

### 1. Ask the project name

One question, no menu:

> "What do you want to call your project?"

Default: `my-game`. If they say "anything is fine" or similar, use `my-game` and move on. The directory name is reversible — they can always rename.

### 2. Pick the starting scene

Two built-in options:

- `empty` — root `Node3D` only. Pure blank canvas. Best for: experimentation, when the user knows exactly what they want to build.
- `3d-basic` — root `Node3D` with a procedural sky on a `WorldEnvironment`, a sun with soft shadows, a tinted ground, one hero mesh and a `Camera3D` that frames it. Best for: first-time users who want something they can press Play on.

If you're not sure which fits, ask:

> "Empty (just a root node) or 3d-basic (camera, light, and a floor — you can press play immediately)?"

If the user has clearly invoked `brainstorm-game` already and the brief calls for 3D, default to `3d-basic` and mention you did. If 2D or 2.5D, use `empty`, keep its `Node3D` root and build the world with `painted-25d-world` (a painted 3D blockout under a fixed orthographic camera with sprite characters).

### 3. Create and open it

One command creates the project and opens it. When Summer Engine is missing it also installs it (about 660 MB): ask the user first, and pass `--yes` only with their OK (without it nothing is installed):

```
summer dev --yes 3d-basic my-game
```

or `summer dev --yes empty my-game`. It writes `project.godot` and the chosen `main.tscn` (no network call for these two), opens the editor and waits until it answers.

No shell in this session (a chat app)? Call `projects.create_local` with `template` and `name`, then `projects.open_local` with its `projectPath` (and `install: true` only after the user said yes to installing the engine).

Confirm the project loaded with `summer_get_project_context`. If it fails, run `summer doctor` and surface the failure to the user.

### 4. Don't keep going automatically

After scaffolding, **stop and let the user direct.** A common mistake: fire `fps-controller` or `design-mechanic` automatically because "now we make a game." Wait. The user might want to:

- Brainstorm what to build (`brainstorm-game`)
- Set the visual direction (`art-direction`)
- Jump straight into a known mechanic (`design-mechanic`)
- Build a specific controller (`fps-controller`)

Ask: "Project is open. What do you want to build?"

## Anti-patterns

| Don't | Why |
|---|---|
| Skip the name question and use `my-game` silently | The user has opinions about the directory name. Two seconds of asking saves a `mv` later. |
| Use `summer create 3d-basic` for a 2D game | Its light and floor fight the painted look. Use `empty` and follow `painted-25d-world`. |
| Default to a community template | That's `browse-templates`. This skill is specifically for "blank canvas." |
| Continue into `fps-controller` automatically | Most users want to brainstorm or set art direction first. Stop and ask. |
| Run this when the user is in an existing project | Check `summer status` or `summer_get_project_context` first. If a project is already open, the user probably wanted to modify it, not create a new one. |

## Edge cases

- **Engine not running** → that's fine. `summer dev` (or `projects.open_local`) starts it; `summer create` alone doesn't need it.
- **User wants 2D or 2.5D** → use `empty`, keep the `Node3D` root and follow `painted-25d-world`. Use a `Node2D` root only when the user asks for a classic 2D tile or pixel game.
- **Directory exists** → a folder that already holds `project.godot` is just opened; one with other files is refused. Ask for a different name; don't try to overwrite.

## Closing

End with: "Project `<name>` is created and open. What do you want to build first?"

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@latest` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `summer_get_project_context` | `summer engine get-project-context` |
| `projects.create_local` | `summer projects create-local` |
| `projects.open_local` | `summer projects open-local` |
<!-- /shell-commands -->
