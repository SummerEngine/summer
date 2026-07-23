---
name: new-project
description: Use when the user wants a fresh blank Summer Engine project — not from a template. Asks one question (project name) and runs `summer create empty <name>`. Trigger on "new project", "blank project", "empty project", "from scratch", "start fresh", "create new game", "blank canvas", "scaffold a project".
license: MIT
compatibility: [Cursor, Claude Code, Codex, Windsurf, Gemini, OpenCode]
category: scene-and-project
user-invocable: true
allowed-tools: Bash Read summer_get_project_context
paths: ["**/project.godot"]
---

# /new-project — Scaffold a fresh empty project

When the user wants to start from a blank canvas — not a community template, not a built-in starter scene — this is the path.

## When to use this skill

- "Let's start a new project."
- "I want to make a [game type] from scratch."
- "Blank project."
- "Empty project."
- "I don't want a template, just a blank starting point."

## When NOT to use this skill

- "Show me templates" / "use a template" → `summer:browse-templates`.
- "Make me a game" with a defined idea → let `summer:make-game` invoke this as
  one internal setup step. Do not force `summer:brainstorm-game`.
- "I have an existing Godot project I want to import" → not this skill; have the user run `summer open <path>` directly.

## Steps

### 1. Resolve the project name

When invoked standalone, ask one question with no menu:

> "What do you want to call your project?"

Default: `my-game`. If they say "anything is fine" or similar, use `my-game` and move on. The directory name is reversible — they can always rename.

When invoked from `summer:make-game`, infer a short reversible name from the
brief or use `my-game`. Do not interrupt an otherwise concrete build only to
approve a directory name.

### 2. Pick the starting scene

Two built-in options:

- `empty` — root `Node3D` only. Pure blank canvas. Best for: experimentation, when the user knows exactly what they want to build.
- `3d-basic` — root `Node3D` with `Camera3D`, `DirectionalLight3D`, a floor `MeshInstance3D`, and a `WorldEnvironment`. Best for: first-time users, when "just give me something I can press play on" is the vibe.

If you're not sure which fits, ask:

> "Empty (just a root node) or 3d-basic (camera, light, and a floor — you can press play immediately)?"

If the user has clearly invoked `summer:brainstorm-game` already and the brief calls for 3D, default to `3d-basic` and mention you did. If 2D, use `empty` (we don't ship a 2D-basic yet).

### 3. Create

```
summer create empty my-game
```

or

```
summer create 3d-basic my-game
```

The command writes `project.godot` and the chosen `main.tscn`. No network call, fast, deterministic.

### 4. Open it

```
summer run my-game
```

Confirm the engine launched and the project loaded. If `summer run` fails, run `summer doctor` and surface the failure to the user.

### 5. Return to the caller

When invoked from `summer:make-game`, report the created path to the
orchestrator and return immediately to the build. The project scaffold is an
internal prerequisite, not a user-facing milestone.

When invoked standalone with no game brief, end with:

> Project is open. What do you want to build?

## Anti-patterns

| Don't | Why |
|---|---|
| Skip the name question and use `my-game` silently | The user has opinions about the directory name. Two seconds of asking saves a `mv` later. |
| Use `summer create 3d-basic` for a 2D game | Wrong starting scene. Use `empty` and let the user/agent build the 2D root from there. |
| Default to a community template | That's `summer:browse-templates`. This skill is specifically for "blank canvas." |
| Stop a running `summer:make-game` flow after project creation | The caller already owns the game brief; return control so it can continue to a playable result. |
| Run this when the user is in an existing project | Check `summer status` or `summer_get_project_context` first. If a project is already open, the user probably wanted to modify it, not create a new one. |

## Edge cases

- **Engine not running** → that's fine. `summer create` doesn't need the engine. After scaffolding, `summer run <name>` will start it.
- **User wants 2D but `empty` is the only 2D-friendly built-in** → use `empty`, then in the next breath set up a 2D scene root via `summer_replace_node` (Node3D → Node2D). Mention this — don't surprise the user.
- **Directory exists** → the CLI errors out. Ask for a different name; don't try to overwrite.

## Closing

Standalone: "Project `<name>` is created and open. What do you want to build first?"

Inside `summer:make-game`: return the path and starter type without asking a
new question.
