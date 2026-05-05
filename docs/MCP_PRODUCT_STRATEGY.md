# Summer Engine MCP — Product Strategy

> Superseded for the current rebuild by [Summer Agent Kit PRD](./AGENT_EXPERIENCE_PRD.md). Keep this file as legacy context only.

SUMMER ENGINE MCP & CLI IS OPENSOURCE MIT. Think of that when making changes. And when you make commits, don't attribute cursor or claude.

Why the MCP exists, where it shines, what to build, what not to build.

---

## The One-Line Pitch

The MCP lets AI coding tools (Cursor, Claude Code, Windsurf) do things with Summer Engine that they literally cannot do on their own — manipulate scenes, run games, take screenshots, and read engine state.

## What AI Tools Can Already Do (Without Us)

Every AI coding tool already has:
- **File read/write** — can create and edit .gd, .cs, .json, any text file
- **Shell commands** — can run `godot --export`, install packages, etc.
- **Git** — full commit/branch/push/pull
- **Code search** — grep, ripgrep, semantic search
- **Text editing** — find and replace, refactoring

We do NOT need to duplicate these. An AI model using Claude Code already has these capabilities built in. Wrapping them in our MCP tools adds zero value and clutters the tool list.

## What ONLY Summer Engine Can Do (Our Unique Value)

These are things that require the engine to be running. No amount of file editing can replicate them:

### 1. Scene Manipulation (The Core Win)

Godot scenes (.tscn) have binary UIDs, resource references, sub-resource IDs, and node path dependencies. Editing them as text files is fragile and error-prone. The engine's scene API handles all of this correctly.

- **AddNode** — creates a node in the live scene graph with correct UIDs
- **SetProp** — sets typed properties using Godot's `str_to_var()` (Vector3, Color, Resources)
- **SetResourceProperty** — sets nested resource properties (e.g., CollisionShape size)
- **RemoveNode** — safely removes with undo/redo support
- **ConnectSignal** — wires signals between nodes (requires live scene graph)
- **InstantiateScene** — adds a .tscn/.glb as a child (triggers import pipeline)
- **ReplaceNode** — swaps a node type in-place preserving children
- **SaveScene** — saves with correct resource serialization
- **OpenScene** — switches the active scene in the editor

**Why this matters:** An AI model can write GDScript easily. But it can't build a scene — it can't add a Camera3D, position it, attach a script, and connect signals. That's all scene API. This is the #1 reason MCP exists.

### 2. Visual Feedback (The Second Big Win)

AI models are blind. They can write code but can't see what it produces. Our engine can show them.

- **ViewportSnapshot** — screenshot of the 3D/2D editor view (what the scene looks like)
- **GameSnapshot** — screenshot of the running game (what the player sees)
- **Play / Stop** — run and stop the game from the AI tool
- **IsGameRunning** — check if the game is currently running

**Why this matters:** The AI builds a level, runs it, takes a screenshot, sees "the player is falling through the floor", fixes the collision shape — all without the user doing anything. This feedback loop is the key differentiator.

### 3. Engine Diagnostics

The engine knows things that files on disk don't:

- **GetDiagnosticsSummary** — how many errors/warnings, from console and debugger
- **GetConsoleOutput** — what the engine's Output panel says
- **GetDebuggerErrors** — runtime errors with stack traces
- **GetSceneTree** — the full scene graph structure (nodes, types, paths)

**Why this matters:** After the AI makes changes, it needs to know "did it break anything?" These tools give it that information.

### 4. Import Pipeline

Godot's import system converts raw assets (images, 3D models) into engine-ready resources:

- **ImportFromUrl** — downloads a .glb/.png/etc and triggers Godot's full import pipeline
- **ImportFromUrlBatch** — batch import with single filesystem scan

**Why this matters:** Just downloading a .glb file to `res://` doesn't make it usable in Godot. The import pipeline generates .import files, extracts textures, creates materials. This only happens through the engine.

### 5. Project Settings

Settings that affect the project at a global level:

- **ProjectSetting** — modify project.godot settings (rendering, physics, etc.)
- **InputMapAddAction / InputMapBind** — set up input controls

---

## What We Should NOT Build As MCP Tools

**Anything the AI tool already does better natively:**

- File write/read/delete/rename/move — Claude Code writes files directly to disk
- Shell commands — Claude Code runs commands natively
- Git operations — Claude Code has built-in Git
- Text search (grep) — Claude Code has built-in search
- Text replacement — Claude Code edits files directly

**Why not keep them "just in case"?** Because every tool in the MCP list consumes AI context. 48 tools means the model has to read 48 descriptions to decide which to use. 24 focused tools means clearer decisions, fewer mistakes, better results. Less is more.

---

## Tools We Should Keep (24 Tools)

### Scene (10 tools)
- `summer_add_node`
- `summer_set_prop`
- `summer_set_resource_property`
- `summer_remove_node`
- `summer_connect_signal`
- `summer_instantiate_scene`
- `summer_replace_node`
- `summer_save_scene`
- `summer_open_scene`
- `summer_select_node`

### Visual Feedback (5 tools)
- `summer_play`
- `summer_stop`
- `summer_is_running`
- `summer_viewport_snapshot` *(Summer Agent only; MCP planned when clients support image content)*
- `summer_game_snapshot` *(Summer Agent only; MCP planned when clients support image content)*

### Diagnostics (5 tools)
- `summer_get_diagnostics`
- `summer_get_console`
- `summer_clear_console`
- `summer_get_debugger_errors`
- `summer_get_scene_tree`

### Import & Project (4 tools)
- `summer_import_from_url`
- `summer_import_from_url_batch`
- `summer_project_setting`
- `summer_input_map_bind`

### Asset (2 tools)
- `summer_search_assets`
- `summer_import_asset`

## Tools To Remove (24 tools)

These duplicate what AI tools already have:
- `summer_write_file`, `summer_delete_file`, `summer_rename_file`, `summer_move_file`, `summer_make_directory`
- `summer_grep`, `summer_search_in_files`
- `summer_run_command`, `summer_kill_command`
- `summer_git_detect`, `summer_git_status`, `summer_git_restore_files`, `summer_git_add`, `summer_git_commit`, `summer_git_revert`, `summer_git_init`, `summer_git_restore_tree`, `summer_git_ensure_branch`, `summer_save_dirty_scenes`
- `summer_replace_text`
- `summer_open_resource`, `summer_undo`
- `summer_input_map_add_action` (fold into `summer_input_map_bind`)
- `summer_get_project_info`, `summer_get_file_tree` (AI can read project.godot and list files)

Also removed from MCP (available in Summer Agent only; MCP planned when clients support image content):
- `summer_viewport_snapshot`, `summer_game_snapshot`

---

## Future Tools To Build (High Value)

### Asset Generation
- `summer_generate_texture` — AI generates a texture for a material
- `summer_generate_mesh` — AI generates a 3D model
- `summer_generate_sound` — AI generates a sound effect

These are compute-bound (GPU inference) and can't be done locally. Huge differentiator. Revenue opportunity (pay per generation).

### Scene Intelligence
- `summer_analyze_scene` — "What's wrong with this scene?" (missing colliders, overlapping nodes, performance issues)
- `summer_suggest_improvements` — "How can this level be better?"

### Game Testing
- `summer_run_test` — run the game and automatically test a scenario
- `summer_playtest` — AI plays the game and reports issues (stuck spots, impossible jumps, etc.)

### Skills & Knowledge Packs
- `summer_download_skill` — download a best-practices guide (e.g., "how to build a good FPS", "how to optimize 3D performance")
- Skills are markdown/json files that get injected into the AI's context
- Hosted in a public repo, downloadable via CLI
- This makes the AI smarter at game development, not just at calling tools
- Examples: GDScript patterns, scene composition guidelines, physics setup checklists

---

## Gating Strategy

### Free (always available)
- All scene manipulation tools
- Play / Stop
- Basic diagnostics (error count, summary)

### Consider gating (Pro tier)
- ViewportSnapshot / GameSnapshot (compute for image capture)
- Detailed console output and debugger errors
- Asset generation (when built)
- Premium skills/knowledge packs

### The principle
Gate things that cost us compute or provide premium intelligence. Never gate basic scene manipulation — that's what makes the free tier useful enough to adopt.

---

## How To Think About New Tool Proposals

Before adding a new MCP tool, ask:

1. **Can the AI tool already do this natively?** (file ops, shell, git, search) → Don't build it
2. **Does it require the engine to be running?** (scene graph, visual feedback, import pipeline) → Build it
3. **Does it give the AI information it can't get from files?** (runtime errors, scene state, screenshots) → Build it
4. **Is it compute-bound on our side?** (asset generation, AI analysis) → Build it, consider gating
5. **Does it make the AI smarter at game dev?** (skills, knowledge packs, examples) → Build it, huge differentiator

---

## The North Star

An AI model, working in Cursor or Claude Code, can build a complete, polished game in Summer Engine — creating scenes, writing code, importing assets, running and debugging, iterating on visual feedback — without the user touching the engine at all.

The user opens Summer Engine to SEE their game. The AI builds it.

That's the product.

---

## Reserved npm Package Names

All registered under the `summer-engine` npm account. Placeholders published to prevent squatting.

### Already in use
- `summer-engine` — the main CLI/MCP package

### Reserved (unscoped)
- `summer-mcp`
- `summerengine`
- `summer-engine-cli`
- `summer-engine-mcp`
- `summer-game-engine`

### Reserved (@summerengine scope)
- `@summerengine/cli`
- `@summerengine/mcp`
- `@summerengine/sdk`
- `@summerengine/tools`
- `@summerengine/core`
- `@summerengine/engine`

### Reserved (@summer-engine scope)
- `@summer-engine/cli`
- `@summer-engine/mcp`
- `@summer-engine/sdk`
- `@summer-engine/tools`
- `@summer-engine/core`

### Taken by others (not ours)
- `summer-cli` — unrelated project, inactive since ~2020
