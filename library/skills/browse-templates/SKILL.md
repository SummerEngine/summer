---
name: browse-templates
description: Use when the user wants to see available Summer Engine project templates, start from an existing template, or asks "what templates exist?" — fetches the live list from github.com/SummerEngine, presents the choices, and creates a project from the chosen template via `summer create <slug> <project-name>`. Trigger on "templates", "starter", "boilerplate", "from a template", "what's available", "show me templates", "third-person", "platformer", "multiplayer starter".
license: MIT
compatibility: [Cursor, Claude Code, Codex, Windsurf, Gemini, OpenCode]
category: scene-and-project
user-invocable: true
allowed-tools: Bash Read summer_get_project_context
paths: ["**/project.godot"]
---

# /browse-templates — Pick a community template and clone it

Summer's community templates live in [github.com/SummerEngine](https://github.com/orgs/SummerEngine/repositories) under `template-*` repos: `template-3d-third-person-controller`, `template-3d-lan-multiplayer-starter`, `template-2d-platformer`, and so on. They're working starter projects — open in Summer Engine and play immediately.

## When to use this skill

- User asks "what templates do you have?" / "what starter projects exist?"
- User says "start from a template" / "use the X template" / "is there a Y starter?"
- User describes a game shape that maps to a known template (third-person 3D, multiplayer, 2D platformer)
- User asks for a specific known template by name

## When NOT to use this skill

- User says "blank project" / "empty project" / "from scratch" → use `new-project`.
- User wants to *make* a new template (contribute one) → that's not this skill; point them at the README's contributing section.

## Steps

### 1. Fetch the live list

```
summer list templates
```

That hits the GitHub org API and prints both built-in templates (offline-friendly) and community templates with descriptions. **Always run this first — never recommend a template from memory.** The list evolves; what you remember may be stale, archived, or renamed.

If the command errors out (rate-limit, offline), tell the user and offer the built-ins (`empty`, `3d-basic`) plus the canonical URL: [github.com/SummerEngine](https://github.com/orgs/SummerEngine/repositories).

### 2. Help the user pick

If the user has a specific game shape in mind, narrow before showing all options:

> "Looking for a third-person 3D template — `3d-third-person-controller` looks right. Want me to clone it as `my-game`?"

If they're undecided, show 3–5 options grouped by genre, with a one-line description each. **Don't dump the full list.** A long menu freezes decisions.

### 3. Confirm the project name

Default is the template slug (so `3d-third-person-controller` → directory `3d-third-person-controller`). Almost always wrong. **Always ask:**

> "What do you want to call your project? (default: `3d-third-person-controller`)"

### 4. Clone

```
summer create <template-slug> <project-name>
```

Example:

```
summer create 3d-third-person-controller hero-game
```

This:
- Clones the latest `main` (or default branch) of `template-3d-third-person-controller`
- Drops the `.git` directory so the user starts with their own history
- Prints the source URL for transparency

Pass `--keep-git` if the user wants the upstream history (rare).

### 5. Open it in the engine

```
summer run <project-name>
```

Confirm it opens. Then invoke `play` to verify the template runs as expected before doing any custom work on top.

## Anti-patterns

| Don't | Why |
|---|---|
| Recommend a template from memory | List evolves. `summer list templates` is the source of truth. |
| Dump the full template list as a wall of text | 5 curated picks beats 20 generic ones. Match to user intent. |
| Default the project name to the slug | `3d-third-person-controller/` is a UX-hostile directory name. Always ask. |
| Skip `summer run` after cloning | Templates can break upstream — verify the user has a working baseline before they edit. |
| Clone into an existing directory | The CLI errors out; respect that and ask for a different name. |

## Edge cases

- **`git` not installed** → `summer create` errors with a clear message. Tell the user to install git, or fall back to a built-in template.
- **Template archived or moved** → the API filter excludes archived repos. If a user names one explicitly that's gone, the create command lists what's currently available.
- **Network down** → fall back to `empty` or `3d-basic`. Don't pretend the remote ones exist.

## After the user is in

Once the project is created and running, hand off cleanly. The next skill that fires depends on the template:

- Third-person controller → likely `scene-composition` or `gdscript-patterns` next.
- Multiplayer starter → `setup-multiplayer` or `host-authoritative-state`.
- 2D platformer → `design-mechanic` for the platforming feel, then `design-level`.

Don't auto-fire the next skill — wait for the user to say what they want to change first.
