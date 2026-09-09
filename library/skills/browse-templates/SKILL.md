---
name: browse-templates
description: Use when the user wants to see available Summer Engine project templates, start from an existing template, or asks "what templates exist?" — lists the pinned template registry via `summer list templates`, presents the choices, and creates a project from the chosen template via `summer create <slug> <project-name>`. Trigger on "templates", "starter", "boilerplate", "from a template", "what's available", "show me templates", "third-person", "platformer", "multiplayer starter".
license: MIT
compatibility: [Cursor, Claude Code, Codex, Windsurf, Gemini, OpenCode]
category: scene-and-project
user-invocable: true
allowed-tools: Bash Read summer_get_project_context
paths: ["**/project.godot"]
---

# /browse-templates — Pick a registry template and create a project from it

Summer's templates are the pin manifests in `library/templates/<slug>/resource.yaml`, compiled into `registry/generated/templates-registry.json`: `3d-third-person-controller`, `3d-lan-multiplayer-starter`, `2d-platformer`, and so on. Each pinned template names a repo, an exact commit, and a tree digest; the two built-ins (`empty`, `3d-basic`) are generated locally. They're working starter projects — open in Summer Engine and play immediately.

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

That prints the template registry — built-ins and pinned templates with status, systems, and preview notes. It reads the registry only; it does not query GitHub. **Always run this first — never recommend a template from memory.** The list evolves; what you remember may be stale, retired, or renamed.

If the command errors out, tell the user and offer the built-ins (`empty`, `3d-basic`), which need no network.

### 2. Help the user pick

If the user has a specific game shape in mind, narrow before showing all options:

> "Looking for a third-person 3D template — `3d-third-person-controller` looks right. Want me to create it as `my-game`?"

If they're undecided, show 3–5 options grouped by genre, with a one-line description each. **Don't dump the full list.** A long menu freezes decisions.

### 3. Confirm the project name

Default is the template slug (so `3d-third-person-controller` → directory `3d-third-person-controller`). Almost always wrong. **Always ask:**

> "What do you want to call your project? (default: `3d-third-person-controller`)"

### 4. Create

```
summer create <template-slug> <project-name>
```

Example:

```
summer create 3d-third-person-controller hero-game
```

This:
- Fetches the exact commit pinned in the registry entry — never a default branch — and refuses if the tree digest does not match
- Drops the `.git` directory so the user starts with their own history
- Records the template pin into the project's `.summer/project.json` and prints the source for transparency

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
| Skip `summer run` after creating | Verify the user has a working baseline before they edit. |
| Create into an existing directory | The CLI errors out; respect that and ask for a different name. |

## Edge cases

- **`git` not installed** → `summer create` errors with a clear message. Tell the user to install git, or fall back to a built-in template.
- **Template retired or renamed** → it leaves the registry (renames leave an alias). If a user names one explicitly that's gone, the create command lists what's currently available.
- **Network down** → pinned templates cannot be fetched; fall back to `empty` or `3d-basic`, which are generated locally.

## After the user is in

Once the project is created and running, hand off cleanly. The next skill that fires depends on the template:

- Third-person controller → likely `scene-composition` or `gdscript-patterns` next.
- Multiplayer starter → `setup-multiplayer` or `host-authoritative-state`.
- 2D platformer → `design-mechanic` for the platforming feel, then `design-level`.

Don't auto-fire the next skill — wait for the user to say what they want to change first.
