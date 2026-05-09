# Summer

**Summer Engine is the AI game engine.** Build real 2D and 3D games through conversation. No coding required. Export to Steam, desktop, mobile, and web. Built on the Godot team's work, customized and honed so AI agents and humans can collaborate on great games.

This repo is **Summer's open-source agent layer** — a skills framework that gives any coding agent superpowers for game dev. Install once, works everywhere: Claude Code, Cursor, Codex CLI / App, Gemini CLI, OpenCode, Factory Droid, GitHub Copilot CLI, Windsurf. MIT licensed.

It just works. Open your agent, say "let's make an FPS in Summer Engine," and it does.

---

## Install Summer in your agent

Pick your tool. If you use more than one, install for each.

| Agent | Command |
|---|---|
| **[Claude Code](#claude-code)** | `claude /plugin install summer@summer-marketplace` |
| **[Codex CLI](#codex-cli)** | `/plugins` → search `summer` → install |
| **[Codex App](#codex-app)** | Plugins → Coding → Summer → `+` |
| **[Cursor](#cursor)** | `/add-plugin summer` |
| **[Factory Droid](#factory-droid)** | `droid plugin install summer@summer-marketplace` |
| **[Gemini CLI](#gemini-cli)** | `gemini extensions install https://github.com/SummerEngine/summer` |
| **[GitHub Copilot CLI](#github-copilot-cli)** | `copilot plugin install summer@summer-marketplace` |
| **[OpenCode](#opencode)** | Tell it: *"Fetch and follow https://raw.githubusercontent.com/SummerEngine/summer/main/.opencode/INSTALL.md"* |
| **[Windsurf / others](#windsurf-and-others)** | `npm i -g summer-engine && summer setup <agent> --yes` |

Then talk to your agent:

> Let's make an FPS in Summer Engine.

It loads the right skills, asks what you want, and starts building. That's it.

---

## You'll also need Summer Engine

Most skills need the engine running locally.

```bash
npm install -g summer-engine
summer install        # downloads Summer Engine — see "What gets downloaded" below
summer login
summer create 3d-basic my-game
summer run my-game
```

Or download it directly: **[summerengine.com/download](https://summerengine.com/download)**.

You can install the agent plugin first and the engine later — most tools tell you what to do when the engine isn't running.

---

## What gets downloaded

We tell you before we touch your disk.

| What | Size | When | Source |
|---|---|---|---|
| `summer-engine` npm package | ~3 MB | `npm install -g summer-engine` | [npmjs.com/package/summer-engine](https://www.npmjs.com/package/summer-engine) |
| Summer Engine app | ~145 MB | `summer install` | Summer's signed releases |
| Auth token | ~1 KB | `summer login` | Browser → `~/.summer/auth-token` |
| Skill files | < 50 KB | bundled in the npm package | no network call |
| Generated assets (3D / image / audio / video) | varies | only on explicit `summer_generate_*` calls | Summer Engine Studio |
| URL imports | varies | only on explicit `summer_import_from_url` calls | the URL you provide |

Not downloaded:
- No background telemetry. Diagnostics stay local.
- No silent engine updates. You run `summer update` manually.
- No model weights or AI binaries. Generation runs in Summer Engine Studio.

Every install command takes `--dry-run`. Print the URL, target path, and SHA before anything moves.

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
claude /plugin marketplace add SummerEngine/summer-marketplace
claude /plugin install summer@summer-marketplace
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
droid plugin marketplace add https://github.com/SummerEngine/summer-marketplace
droid plugin install summer@summer-marketplace
```

### Gemini CLI

```bash
gemini extensions install https://github.com/SummerEngine/summer
```

Update later: `gemini extensions update summer`.

### GitHub Copilot CLI

```bash
copilot plugin marketplace add SummerEngine/summer-marketplace
copilot plugin install summer@summer-marketplace
```

### OpenCode

```bash
npm install --save-dev summer-engine
```

Add to `opencode.json`:

```json
{
  "plugin": ["summer-engine/.opencode/plugins/summer.js"],
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
