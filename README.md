# Summer Engine — the AI game engine

Build real 2D and 3D games through conversation. No coding required. Export to Steam, desktop, mobile, and web. Built on the Godot team's work, customized and honed so AI agents and humans can collaborate on great games.

**Summer** is the open-source plugin that connects your AI coding agent to Summer Engine. MIT licensed. Works in Claude Code, Cursor, Codex, Gemini CLI, OpenCode, Factory Droid, GitHub Copilot CLI, and Windsurf.

It just works. Open your agent, say *"let's make an FPS in Summer Engine,"* and it does.

---

## Get started — one prompt

Open Claude Code (or Cursor / Codex / Windsurf / etc.) and paste:

> Install Summer Engine and let's make a game.

That's it. The agent reads this README, detects what's already on your machine, and runs only what's missing via Bash. **No `/plugin` slash commands. No manual installs. One paste.**

The first run will:
1. Install the `summer-engine` npm package (~3 MB) if it's not on `PATH`.
2. Drop 60 skills into `~/.claude/skills/` (or your agent's user-skill directory) so the agent loads them next session.
3. Download the Summer Engine app (~145 MB) if it's not installed.
4. Open your browser for one-click sign-in.
5. Scaffold a starter project and open the engine.

At that point the agent has the skills, the MCP server, and your engine running. Ask it to build something.

---

## AGENTS READING THIS — the install playbook

You are an AI coding agent (Claude Code, Cursor, Codex, etc.). The user told you to install Summer Engine. **Run this playbook via Bash exactly as written.** Detection first, then only install what's missing — never double-install.

### Step 0 — Pre-detection (no installs, just check state)

Try `summer doctor --json` first. If it succeeds, parse the JSON and skip Steps 1-4 for any check that returned `status: ok`. If `summer` isn't on PATH, you'll get "command not found" — that's the signal to start at Step 1.

```bash
summer doctor --json 2>/dev/null || echo "MISSING:cli"
```

Expected JSON shape (when CLI is installed):

```json
{
  "ok": true | false,
  "checks": [
    { "id": "cli-version",    "status": "ok" | "warning" | "error", ... },
    { "id": "login",          "status": "ok" | "warning" | "error", ... },
    { "id": "engine-install", "status": "ok" | "warning" | "error", ... },
    { "id": "mcp-server",     "status": "ok" | "warning" | "error", ... }
  ]
}
```

If `ok: true`, the user already has everything. Skip to Step 5 (scaffold a project).

### Step 1 — Install the npm package (only if `summer` is missing from PATH)

```bash
npm install -g summer-engine
```

~3 MB. After this, `summer` is on PATH.

### Step 2 — Install the user-level skills (only if not already installed)

```bash
summer setup claude-code --yes
```

Replace `claude-code` with `codex`, `cursor`, `windsurf`, etc. for other agents. This writes 60 skill files to `~/.claude/skills/<name>/SKILL.md` (or the agent's equivalent user-skill directory). Claude Code auto-detects new skill files mid-session — **no restart needed unless `~/.claude/skills/` didn't exist before**, in which case prompt the user to restart their agent once.

**Do NOT run `/plugin install` or any slash command.** The CLI path is the canonical install. The marketplace path is an alternative for users who specifically prefer the official plugin TUI; it requires manual user action and we don't go there from agent flows.

### Step 3 — Install the engine app (only if `engine-install` check failed)

```bash
summer install
```

~145 MB. Downloads from Summer's signed releases. The CLI prints the URL and size before touching disk.

### Step 4 — Sign in (only if `login` check failed)

```bash
summer login
```

This opens the user's default browser. **Tell the user**: "Your browser is opening now. Click sign-in once and come back to this terminal." The CLI waits for the auth callback, writes the token to `~/.summer/auth-token`, and returns. The same token is shared with the engine — they sign in once, both surfaces accept it.

### Step 5 — Scaffold a project and run

If the user said "let's make a game" without specifying a template, default to `3d-basic`. Pick a sensible project name from the user's request (e.g. "FPS" → `my-fps-game`).

```bash
summer create 3d-basic my-fps-game
summer run my-fps-game
```

`summer run` launches the engine app with the project loaded. The agent's MCP server connects to `localhost:6550` automatically.

### Step 6 — Now you have skills + MCP. Proceed with the user's actual request.

The skills auto-trigger on natural language. Don't paraphrase them — when a relevant skill applies (`brainstorm-game`, `fps-controller`, `debug`, etc.), invoke it via the `Skill` tool and follow it exactly.

### Anti-patterns (do NOT do these)

- **Don't ask the user "do you want the engine too?" or "do you also want the CLI?"** — there is one product, three pieces, all installed by this playbook.
- **Don't double-install.** Always run `summer doctor --json` first. Skip steps that already returned `status: ok`.
- **Don't tell the user to type `/plugin marketplace add` or `/plugin install`.** The CLI path is the canonical install — those slash commands are an alternative for the marketplace TUI, not the primary flow.
- **Don't run `summer install` or `summer login` in the background.** They print user-facing prompts (engine URL confirmation, browser opening). Run them in the foreground.
- **Don't skip the `--json` flag on `summer doctor`** — text output is fragile to parse and changes per version.

**Using a different agent?** Replace `claude-code` with `codex`, `cursor`, `windsurf`, `gemini`, `opencode` etc. Skill targets vary per agent (Cursor uses `.cursor/rules/`, Windsurf uses `.windsurfrules`, etc.). The CLI handles the difference.

---

## Get started — alternative (manual install via plugin marketplace)

If you specifically prefer the official Claude Code plugin marketplace UI, you can install via:

```
/plugin marketplace add SummerEngine/summer
/plugin install summer@summer-engine
```

This is functionally equivalent to `summer setup claude-code --yes` for the skill install. You'll still need `summer install` and `summer login` to get the engine running. The agent-driven path above is faster and idempotent; this exists for users who want everything in the plugin TUI.

---

## What just happened (the three pieces)

You installed one product. It has three parts. You don't have to think about them — Summer wires them up — but here's what each does:

- **Summer Engine** — the game engine app. Where you see, play, and debug your game. Installed by `summer install`. Proprietary, free to use.
- **Summer plugin** — what Claude Code (or your agent) uses to know what game-dev skills to apply and which tools to call. Installed via `/plugin install`. MIT, open source.
- **Summer CLI** — the terminal command (`summer ...`) that installs the engine, scaffolds projects, runs them, signs you in. Installed via `npm install -g summer-engine`. MIT, open source.

The plugin gives the agent the skills. The CLI gives it hands to install and launch the engine. The engine is where the game actually lives.

---

## What gets downloaded

We tell you before we touch your disk.

| What | Size | When | Source |
|---|---|---|---|
| `summer-engine` npm package (CLI + plugin source) | ~3 MB | `npm install -g summer-engine` | [npmjs.com/package/summer-engine](https://www.npmjs.com/package/summer-engine) |
| Summer Engine app | ~145 MB | `summer install` | Summer's signed releases |
| Auth token | ~1 KB | `summer login` | Browser → `~/.summer/auth-token` |
| Skill files | < 50 KB | bundled in the npm package | no extra network call |
| Generated assets (3D / image / audio / video) | varies | only on explicit `summer_generate_*` calls | Summer Engine Studio |
| URL imports | varies | only on explicit `summer_import_from_url` calls | the URL you provide |

Not downloaded:
- No background telemetry. Diagnostics stay local.
- No silent engine updates. You run `summer update` manually.
- No model weights. AI generation runs in Summer Engine Studio (cloud), never on your machine.

---

## What's open and what's not

| Thing | License | Source |
|---|---|---|
| **Summer** (this repo: skills, MCP server, CLI, hooks, plugin manifests) | **MIT** | [SummerEngine/summer](https://github.com/SummerEngine/summer) |
| **Summer Engine** (the engine binary, editor, runtime) | proprietary, free to use | [summerengine.com/download](https://summerengine.com/download) |
| **Summer Engine Studio** (asset generation, cloud) | proprietary, paid plans | [summerengine.com/pricing](https://summerengine.com/pricing) |

The engine is the moat. The agent layer is open so you can audit it, fork it, extend the skills, and contribute back.

---

## How it works

Two pieces, plus the glue.

**Skills.** Twenty-four markdown files. Each one is a discipline guide for the agent. They auto-fire on natural language:

- "Let's brainstorm a game" → `summer:brainstorm-game`
- "It crashes when I press play" → `summer:debug`
- "Add an FPS controller" → `summer:fps-controller`
- "Make it look prettier" → `summer:art-direction`
- "Set up multiplayer" → `summer:setup-multiplayer` → `summer:host-authoritative-state`

Skills don't list steps. They encode the **order of operations**: diagnose before editing, scope before building, ask before guessing. [Agent Skills](https://agentskills.io) format, so any conformant tool picks them up.

**MCP bridge.** The `summer-engine` MCP server gives the agent 37 tools that talk to your local engine on `localhost:6550`:

| | |
|---|---|
| Scene | `summer_add_node`, `summer_set_prop`, `summer_replace_node`, `summer_get_scene_tree`, `summer_inspect_node`, `summer_batch` |
| Diagnostics | `summer_get_script_errors`, `summer_get_diagnostics`, `summer_get_console`, `summer_get_debugger_errors` |
| Runtime | `summer_play`, `summer_stop`, `summer_is_running` |
| Project | `summer_get_project_context`, `summer_open_main_scene`, `summer_project_setting`, `summer_input_map_bind` |
| Assets | `summer_search_assets`, `summer_import_asset`, `summer_import_from_url`, `summer_generate_image`, `summer_generate_3d`, `summer_generate_audio`, `summer_generate_video` |

File ops, git, shell, grep — your agent already has those. We don't shadow them.

**Lifecycle hooks.** A `session-start` hook detects whether you're in a Summer Engine project and feeds the agent a one-line orientation. An opt-in `pre-commit doctor` runs `summer doctor` before `git commit` and blocks on failure.

For the full architecture, see [docs/OVERVIEW.md](docs/OVERVIEW.md).

---

## The basic workflow

1. **using-summer** loads on session start. Sets workflow priority and the red-flag list.
2. **brainstorm-game** scopes a new project. One question, one page, one direction.
3. **scene-composition** picks the right hierarchy before any node lands.
4. **fps-controller / design-mechanic / design-level / setup-multiplayer / vfx** produce the artifact.
5. **gdscript-patterns** guides every `.gd` write.
6. **play** runs the game and reports clean or broken.
7. **debug** runs the cheapest diagnostic, forms one specific hypothesis, asks before editing, re-verifies after the fix.
8. **export-and-ship** runs the pre-flight checklist before producing a release build.

Twenty-four skills replace "agent flailing through tutorials" with measurable craft.

---

## What's inside

**Process** — `using-summer`, `brainstorm-game`, `debug`, `play`

**Project setup** — `new-project`, `browse-templates`, `make-game`, `scene-composition`

**Build** — `fps-controller`, `design-mechanic`, `design-level`, `design-npc`

**Multiplayer** — `setup-multiplayer`, `host-authoritative-state`, `peer-to-peer-multiplayer`

**Look & feel** — `art-direction`, `audio-direction`, `3d-lighting`, `vfx`, `ui-basics`

**Code & assets** — `gdscript-patterns`, `asset-strategy`

**Performance & ship** — `tune-performance`, `export-and-ship`

**Skill authoring** — `skill-create`, `skill-improve`, `skill-test`

C# is supported by the engine. A `summer:csharp-patterns` skill is on the roadmap; for now write C# from Godot 4.5 docs.

Full catalog with HAVE / NEXT / LATER status: [`skills/catalog.yaml`](./skills/catalog.yaml).

## Philosophy

- Skills auto-fire on natural language. No slash command required.
- Diagnose before guessing. Read the error before grepping the code.
- Process skills run before build skills.
- Fewer tools, sharper tools.
- The user owns decisions. The agent diagnoses and proposes.

---

## Install — full instructions per harness

### Claude Code

```bash
claude /plugin marketplace add SummerEngine/summer
claude /plugin install summer@summer-engine
```

When Summer lands on Anthropic's official marketplace, also:

```bash
claude /plugin install summer@claude-plugins-official
```

### Codex CLI

```
/plugins
```

Search `summer`, install.

### Codex App

Sidebar → **Plugins** → **Coding** → click `+` next to **Summer**.

### Cursor

```
/add-plugin summer
```

Or search `summer` in the Cursor plugin marketplace.

### Factory Droid

```bash
droid plugin marketplace add https://github.com/SummerEngine/summer
droid plugin install summer@summer-engine
```

### Gemini CLI

```bash
gemini extensions install https://github.com/SummerEngine/summer
```

Update later: `gemini extensions update summer`.

### GitHub Copilot CLI

```bash
copilot plugin marketplace add SummerEngine/summer
copilot plugin install summer@summer-engine
```

### OpenCode

```bash
npm install --save-dev summer-engine
```

Add to `opencode.json`:

```json
{
  "plugin": ["summer-engine"],
  "mcp": {
    "summer-engine": {
      "command": "npx",
      "args": ["summer-engine", "mcp"]
    }
  }
}
```

Restart. Full guide: [`.opencode/INSTALL.md`](./.opencode/INSTALL.md).

### Windsurf and others

```bash
npm install -g summer-engine
summer setup <agent> --yes
summer doctor
```

---

## CLI reference

| Command | What it does |
|---|---|
| `summer install` | Download Summer Engine. Transparent — prints URL + size first. |
| `summer login` | Browser-based sign-in. |
| `summer logout` | Clear auth tokens. |
| `summer status` | Engine state, port, auth. |
| `summer doctor` | Diagnose Node, login, engine, MCP. |
| `summer run [path]` | Launch the engine. |
| `summer open <path>` | Open a project in a running engine. |
| `summer create <template> [name]` | Scaffold a project. |
| `summer list templates` / `projects` | Browse. |
| `summer skills list` | Show all skills. |
| `summer skills install <name>` | Install one. |
| `summer skills install --recommended --agent <agent>` | Install the recommended set. |
| `summer mcp` | Start the MCP server. |
| `summer mcp setup <agent>` | Write MCP config for an agent. |
| `summer setup <agent> [--yes]` | One shot: MCP config + recommended skills + doctor. |

Agents: `claude-code`, `codex`, `cursor`, `gemini`, `opencode`, `windsurf`. Scopes: `--scope user` (default), `--scope project`.

---

## Verify

In a fresh agent session:

> Let's make an FPS in Summer Engine.

The agent should auto-load `summer:fps-controller` before writing code. If it doesn't, run `summer doctor`.

---

## Templates

| Template | What you get |
|---|---|
| `empty` | Empty 3D project with a root node |
| `3d-basic` | 3D scene with camera, light, floor |

More coming.

---

## Contributing

Skills evolve fast. Two ways to help:

1. **Open an issue** if a skill misfires. Quote the prompt and the response.
2. **Submit a SKILL.md** for one of the `NEXT` entries in [`skills/catalog.yaml`](./skills/catalog.yaml). Run `summer:skill-test` against it before opening the PR.

[`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md) is the contributor guide.

---

## Per-harness docs

- [Claude Code](docs/CLAUDE_CODE.md)
- [Codex](docs/CODEX.md)
- [Cursor](docs/CURSOR.md)
- [OpenCode](.opencode/INSTALL.md)
- [Skills overview](docs/SKILLS.md)
- [Templates](docs/TEMPLATES.md)
- [Architecture overview](docs/OVERVIEW.md)

---

## License

MIT for everything in this repo. Summer Engine itself is proprietary. See [What's open and what's not](#whats-open-and-whats-not).

## Links

- [Website](https://summerengine.com)
- [Download Summer Engine](https://summerengine.com/download)
- [Documentation](https://summerengine.com/docs)
- [Community](https://summerengine.com/community)
- [Issues](https://github.com/SummerEngine/summer/issues)
