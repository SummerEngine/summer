# Summer Engine — the AI game engine

Build real 2D and 3D games through conversation. No coding required. Export to Steam, desktop, mobile, and web. Built on the Godot team's work, customized and honed so AI agents and humans can collaborate on great games.

**Summer** is the open-source plugin that connects your AI coding agent to Summer Engine. MIT licensed. Works in Claude Code, Cursor, Codex, Gemini CLI, OpenCode, Cline, Roo Code, Factory Droid, GitHub Copilot CLI, and Windsurf.

It just works. Open your agent, say *"let's make an FPS in Summer Engine,"* and it does.

---

## Get started — one prompt

Open Claude Code (or Cursor / Codex / Windsurf / etc.) and paste:

> Install Summer Engine and let's make a game.

That's it. The agent reads this README, detects what's already on your machine, and runs only what's missing via Bash. **No `/plugin` slash commands. No manual installs. One paste.**

The first run will:
1. Install the `summer-engine` npm package (~3 MB) if it's not on `PATH`.
2. Drop 60 skills into `~/.claude/skills/` (or your agent's user-skill directory) so the agent loads them next session.
3. Download the Summer Engine app (~1 GB — bundles the engine binary plus Git and other runtime tools so users without them aren't blocked) if it's not installed.
4. Open your browser for one-click sign-in.
5. Scaffold a starter project and open the engine.

At that point the agent has the skills, the MCP server, and your engine running. Ask it to build something.

---

## AGENTS READING THIS — the install playbook

You are an AI coding agent (Claude Code, Cursor, Codex, Windsurf). The user told you to install Summer Engine. **Run this playbook via your shell** — Bash on macOS/Linux or PowerShell on Windows; `npx -y` is shell-agnostic and works identically in both. Detection first, then only install what's missing — never double-install.

### Step −1 — Verify Node.js is on PATH

```bash
node --version
```

If this fails or returns a version below 18, **stop**. Tell the user: "Summer needs Node.js 18+. Install from https://nodejs.org and re-run the prompt." Do NOT try to install Node yourself.

### Step 0 — Pre-detection (no commits to disk, just check state)

```bash
npx -y summer-engine@latest doctor --json
```

The first invocation downloads the npm package transparently to npx's cache (~3 MB, ~5 sec). Subsequent calls are fast. The `-y` flag auto-confirms npx's "ok to install summer-engine?" prompt so the call doesn't hang in a non-interactive shell.

Parse the JSON output. Top-level `ok: true` means everything is installed and you can skip straight to Step 5. Otherwise iterate the `checks` array and skip any step whose check returned `status: "ok"`:

```json
{
  "ok": true | false,
  "checks": [
    { "id": "node-version",   "status": "ok" | "warning" | "fail", ... },
    { "id": "cli-version",    "status": "ok" | "warning" | "fail", ... },
    { "id": "login",          "status": "ok" | "warning" | "fail", ... },
    { "id": "engine-install", "status": "ok" | "warning" | "fail", ... },
    { "id": "local-api",      "status": "ok" | "warning" | "fail", ... },
    { "id": "mcp-server",     "status": "ok" | "warning" | "fail", ... }
  ]
}
```

| Check id | If `ok` | If not `ok` |
|---|---|---|
| `node-version` | continue | (Step −1 already covered this) |
| `cli-version` | (always ok via npx) | — |
| `engine-install` | skip Step 2 | run Step 2 |
| `login` | skip Step 3 | run Step 3 |
| `local-api` | skip Step 5b wait-loop | run wait-loop after `summer run` |
| `mcp-server` | skip Step 1 | run Step 1 |
| (skills installed) | skip Step 1 | run Step 1 |

(There's no doctor check for "skills installed" yet — run Step 1 unconditionally on first install. It's idempotent.)

### Step 1 — Install user-level skills (idempotent, fast)

```bash
npx -y summer-engine@latest setup claude-code --yes
```

Replace `claude-code` with the user's actual agent: `codex`, `cursor`, `windsurf`, `cline`, `roo-code`, `gemini`, or `opencode`. (Factory Droid and Copilot CLI use different install paths — see [`docs/`](docs/) per harness.) This writes 60 skill files to `~/.claude/skills/<name>/SKILL.md` (or the agent's equivalent user-skill directory) AND writes the MCP server config so the agent can talk to the engine.

**First-install detection:** if `~/.claude/skills/` didn't exist before this command, Claude Code wasn't watching it and won't auto-detect the new files this session. Tell the user **once**: "Skills installed — restart your agent so they load." On subsequent installs (directory already existed), skills auto-detect mid-session and no restart is needed. **You can detect first-install vs upgrade by checking if `~/.claude/skills/` existed before Step 1; record the result before running setup.**

**Do NOT run `/plugin install` or any slash command.** The CLI path is the canonical install. The marketplace path is an alternative for users who specifically prefer the official plugin TUI; we don't route agents there.

### Step 2 — Install the engine app (only if `engine-install` check failed)

```bash
npx -y summer-engine@latest install
```

~1 GB. Downloads from Summer's signed releases. The bundle includes the engine binary plus Git and a handful of other runtime tools so users who don't already have them aren't blocked. The CLI prints the URL and size before touching disk. Tell the user **"downloading the engine app, ~1 GB — this takes a couple minutes"** so they don't bail thinking it stalled.

**Linux note:** the engine app currently supports macOS and Windows only. On Linux, `summer install` exits with a "Linux support coming soon" message. Surface the manual download URL to the user (https://summerengine.com/download) and stop — the rest of the playbook still works once they've installed manually.

### Step 3 — Sign in (only if `login` check failed)

```bash
npx -y summer-engine@latest login
```

This opens the user's default browser. **Tell the user**: "Your browser is opening now. Click sign-in once and come back to this terminal." The CLI waits up to 120 seconds for the auth callback, writes the token to `~/.summer/auth-token`, and returns. **If the user takes longer than 120s, the command exits with an error — just re-run `npx -y summer-engine@latest login` and tell them to be quicker.** Don't loop indefinitely. The same token is shared with the engine — they sign in once, both surfaces accept it.

### Step 4 — Re-run doctor to confirm

```bash
npx -y summer-engine@latest doctor --json
```

Should now return `ok: true` for `cli-version`, `login`, and `engine-install`. (`local-api` will still be `warning` — that's expected; the engine isn't running yet.) If a setup check still fails, surface the specific message to the user — don't loop or paper over it.

### Step 5 — Scaffold a project and run

**Important:** `summer create` writes the project into the current working directory. **Pick a stable parent directory first** — the user's home, a Projects folder, etc. — and `cd` there before running `create`. Don't let it land in a temp dir or wherever the agent happened to start.

```bash
cd ~/Projects   # or wherever the user keeps code
```

If the user said "let's make a game" without specifying a template, default to `3d-basic`. Pick a sensible project name from the user's request (e.g. "FPS" → `my-fps-game`). Avoid spaces in the name.

```bash
npx -y summer-engine@latest create 3d-basic my-fps-game
npx -y summer-engine@latest run my-fps-game
```

`summer run` launches the engine app with the project loaded and polls the engine's local API for up to 20 seconds before returning.

### Step 5b — Wait for the engine to be reachable (only if `summer run` printed "API not responding yet")

If the engine takes longer than 20s to boot (cold start, slow disk, etc.), `summer run` returns successfully but the local API isn't up yet. Calling `summer_get_scene_tree` or any other MCP tool will fail. Wait for it:

```bash
# Poll doctor until local-api flips to ok (max ~30s):
for i in 1 2 3 4 5 6; do
  result=$(npx -y summer-engine@latest doctor --json)
  echo "$result" | grep -q '"id":"local-api","status":"ok"' && break
  sleep 5
done
```

(Equivalent PowerShell: `for ($i=0; $i -lt 6; $i++) { $r = npx -y summer-engine@latest doctor --json; if ($r -match '"id":"local-api","status":"ok"') { break }; Start-Sleep 5 }`)

Once `local-api` is `ok`, MCP tools are safe to call.

### Step 6 — Brainstorm the game, then build

Now you have skills + MCP. **Don't jump into `summer create` content from a vague prompt** — invoke the `summer:brainstorm-game` skill via the `Skill` tool first. It scopes mechanics, art direction, and the V1 cut list, and writes the result to `.summer/GameSoul.md`. Every other Summer skill reads from that file.

Only skip brainstorm if the user explicitly said "skip brainstorm" or "just build the X already." After brainstorm, the appropriate build skills (`fps-controller`, `design-mechanic`, `design-level`, `make-game`, etc.) auto-trigger from natural language.

### Anti-patterns (do NOT do these)

- **Don't run `npm install -g summer-engine`.** Use `npx -y summer-engine@latest ...` instead. `-g` requires `sudo` on most Mac/Linux setups — the user will get permission errors and you'll get stuck. `npx` works without root and the MCP config we ship already points at `npx summer-engine mcp`.
- **Don't try to install Node.js for the user.** If `node --version` fails, point them at https://nodejs.org and stop.
- **Don't ask the user "do you want the engine too?" or "do you also want the CLI?"** — there is one product, three pieces, all installed by this playbook.
- **Don't double-install.** Always run `npx -y summer-engine@latest doctor --json` first. Skip steps that already returned `status: ok`.
- **Don't tell the user to type `/plugin marketplace add` or `/plugin install`.** The CLI path is the canonical install — those slash commands are an alternative for the marketplace TUI, not the primary flow.
- **Don't run `summer install` or `summer login` in the background.** They print user-facing output (engine download progress, browser-opening notice). Run them in the foreground so the user sees what's happening.
- **Don't skip the `--json` flag on `summer doctor`** — text output is fragile to parse and changes per version.
- **Don't skip the `-y` flag on `npx`** — without it, npx prompts "ok to install summer-engine?" interactively and the call hangs in a non-interactive shell.
- **Don't drop `@latest` from the npx commands.** `npx -y summer-engine` (no version pin) serves whatever's in npx's local cache, which can be a stale older version. The `@latest` tag forces npm to re-resolve from the registry. If a user reports "unknown command 'doctor'" or sees a much smaller skill list than expected, they got cache-served — tell them to run `npx clear-npx-cache` then retry with `@latest`.
- **Don't call MCP tools (`summer_get_scene_tree`, etc.) until `local-api` is `ok`.** The engine takes a few seconds to boot after `summer run`. Use Step 5b's wait-loop.
- **Don't `summer create` without `cd`'ing to a stable parent directory first.** It writes into CWD; agents that start in a temp dir will leave the project there.
- **Don't loop `summer login` if it times out at 120s.** Re-run it once and tell the user to be quicker; loop forever and the user is stuck.
- **Don't jump straight into `summer create` from a vague prompt.** Invoke `summer:brainstorm-game` first (Step 6). The build skills assume `.summer/GameSoul.md` exists.

**Using a different agent?** Replace `claude-code` with any supported agent in Step 1: `codex`, `cursor`, `windsurf`, `cline`, `roo-code`, `gemini`, or `opencode`. Skill targets vary per agent (Cursor uses `.cursor/rules/`, Windsurf uses `.windsurfrules`, Cline + Roo use `.clinerules/`, OpenCode uses agent definitions, etc.). The CLI handles the difference. After install, **Cline and Roo Code users should restart VS Code** so the extension reloads its MCP config. **Gemini users** may need to run `gemini extensions enable summer-engine` after the first install. **Factory Droid and Copilot CLI** still have their own install paths — see [`docs/`](docs/).

**Power-user note:** if the user specifically wants `summer` on their `PATH` for everyday terminal use (outside the AI agent), they can run `npm install -g summer-engine` themselves later. The agent flow doesn't need it.

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
| Summer Engine app | ~1 GB (engine + bundled Git/runtime tools) | `summer install` | Summer's signed releases |
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

### Cline (VS Code)

```bash
npx -y summer-engine@latest setup cline --yes
```

Writes the MCP server config to VS Code's globalStorage for the Cline extension and drops project rules into `.clinerules/`. **Restart VS Code** so Cline reloads its MCP config.

### Roo Code (VS Code)

```bash
npx -y summer-engine@latest setup roo-code --yes
```

Same shape as Cline (Roo Code is a Cline fork) — writes globalStorage MCP config and `.clinerules/` files. **Restart VS Code** afterward.

### Gemini CLI

```bash
npx -y summer-engine@latest setup gemini --yes
```

Drops a Summer extension manifest at `~/.gemini/extensions/summer-engine/`. If the extension isn't auto-enabled on next launch, run `gemini extensions enable summer-engine`. The marketplace path (`gemini extensions install https://github.com/SummerEngine/summer`) still works for users who prefer it — both end up at the same place.

### GitHub Copilot CLI

```bash
copilot plugin marketplace add SummerEngine/summer
copilot plugin install summer@summer-engine
```

### OpenCode

```bash
npx -y summer-engine@latest setup opencode --yes
```

Writes the MCP server entry into `opencode.json` (`~/.config/opencode/opencode.json` for user scope, `./opencode.json` for project) using the array-shaped `command: ["npx", "-y", "summer-engine@latest", "mcp"]` format. Restart OpenCode. Full guide: [`.opencode/INSTALL.md`](./.opencode/INSTALL.md).

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

Agents: `claude-code`, `codex`, `cursor`, `windsurf`, `cline`, `roo-code`, `gemini`, `opencode`. Scopes: `--scope user` (default), `--scope project`.

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
