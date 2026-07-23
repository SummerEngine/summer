# Summer Engine: the AI game engine

Build real 2D and 3D games through conversation. No coding required. Export to Steam, desktop, mobile, and web. Built on the Godot team's work, customized and honed so AI agents and humans can collaborate on great games.

**Summer** is the MIT open-source agent layer that connects your AI coding agent to Summer Engine. It is the **Summer CLI**, the **Summer MCP** server, and the **Summer agent** skills, hooks, and plugin manifests, all in one package. First-class setup works in Claude Code, Cursor, Codex, Devin Desktop (formerly Windsurf), Cline, Roo Code, Gemini CLI, GitHub Copilot CLI, GitHub Copilot in VS Code, and OpenCode. Factory Droid uses the plugin marketplace path.

- **Source:** [github.com/SummerEngine/summer-engine-agent](https://github.com/SummerEngine/summer-engine-agent)
- **CLI setup:** [www.summerengine.com/cli](https://www.summerengine.com/cli)
- **MCP setup:** [www.summerengine.com/mcp](https://www.summerengine.com/mcp)
- **Docs:** [docs.summerengine.com](https://docs.summerengine.com)

It just works. Open your agent, say *"let's make an FPS in Summer Engine,"* and it does.

---

## Summer CLI, Summer MCP, and the Summer agent

Three names, one npm package (`summer-engine`):

- **Summer CLI** (`npx -y summer-engine@latest`): installs the engine, signs you in, scaffolds and runs projects, and writes your agent's config. See [www.summerengine.com/cli](https://www.summerengine.com/cli).
- **Summer MCP**: the local MCP server that gives your agent 52 engine tools to build, run, and debug a real game. See [www.summerengine.com/mcp](https://www.summerengine.com/mcp).
- **Summer agent layer**: the game-dev skills, hooks, and plugin manifests that give your AI agent judgment, not just a chat box.

All MIT, all free to use. One paste sets up all three.

## Get started: one prompt

Open your AI agent (Claude Code, Cursor, Codex, Copilot, Devin Desktop, etc.) and paste:

> Install Summer Engine and let's make a game. Read github.com/SummerEngine/summer-engine-agent, check what I already have installed, install whatever is missing, log me in, and scaffold a starter project so we can start building.

That's it. The agent reads this README, detects what's already on your machine, and runs only what's missing via Bash. **No `/plugin` slash commands. No manual installs. One paste.**

The first run will:
1. Install the `summer-engine` npm package (~3 MB) if it's not on `PATH`.
2. Install Summer's game-dev skills into `~/.claude/skills/` (or your agent's user-skill directory) so the agent loads them next session.
3. Download the Summer Engine app (~1 GB, including the engine binary, Git, and other runtime tools so users without them aren't blocked) if it's not installed.
4. Open your browser for one-click sign-in.
5. Scaffold a starter project and open the engine.

At that point the agent has the skills, the MCP server, and your engine running. Ask it to build something.

---

## AGENTS READING THIS: install playbook

You are an AI coding agent. The user told you to install Summer Engine. **Run this playbook via your shell**: Bash on macOS/Linux or PowerShell on Windows. `npx -y` is shell-agnostic and works identically in both. Detection first, then only install what's missing.

### Step -1: Verify Node.js is on PATH

```bash
node --version
```

If this command does not print Node.js 18 or newer, **stop**. Tell the user: "Summer needs Node.js 18+. Install from https://nodejs.org and re-run the prompt." Do NOT try to install Node yourself.

### Step 0: Pre-detection (no commits to disk, just check state)

```bash
npx -y summer-engine@latest doctor --json
```

The first invocation downloads the npm package transparently to npx's cache (~3 MB, ~5 sec). Subsequent calls are fast. The `-y` flag auto-confirms npx's "ok to install summer-engine?" prompt so the call doesn't hang in a non-interactive shell.

Read the JSON output. If top-level `ok` is `true`, everything is installed and you can skip straight to Step 5. Otherwise use the `checks` array to run only the remediation steps that need attention.

The relevant check ids are `node-version`, `cli-version`, `cli-version-current`, `skills-version-stale`, `login`, `engine-install`, `local-api`, `project-memory`, and `mcp-server`. For any check that is not `ok`, run the action in the table below, then re-run doctor.

| Check id | If `ok` | Action when attention is needed |
|---|---|---|
| `node-version` | continue | Step -1 already covered this |
| `cli-version` | always ok via npx | no action |
| `cli-version-current` | continue | run `npx clear-npx-cache && npx -y summer-engine@latest doctor --json` (forces a fresh resolve) |
| `skills-version-stale` | skip Step 1 | run Step 1 with `--force` |
| `engine-install` | skip Step 2 | run Step 2 |
| `login` | skip Step 3 | run Step 3 |
| `local-api` | skip Step 5b wait-loop | run wait-loop after `summer run` |
| `project-memory` | continue | if a project is open, run `summer:brainstorm-game` before building |
| `mcp-server` | skip Step 1 | run Step 1 |

**On version drift:** if either `cli-version-current` or `skills-version-stale` needs attention, refresh before proceeding. Tell the user once: "There's a newer Summer (X.Y.Z to A.B.C); updating before we start." Then run the recommended action from `details.recommendedAction` and re-run doctor. Don't ask the user to choose; they paste "install" and want the latest.

### Step 1: Install user-level skills (idempotent, fast)

```bash
npx -y summer-engine@latest setup claude-code --yes --force
```

Replace `claude-code` with the user's actual agent: `codex`, `cursor`, `windsurf`, `cline`, `roo-code`, `kilo-code`, `gemini`, `github-copilot`, `vscode-copilot`, `opencode`, or `lm-studio`. Use `github-copilot` for Copilot CLI and `vscode-copilot` for GitHub Copilot Chat/Agent in VS Code. Factory Droid still uses the plugin marketplace path in the install section below. This writes the current Summer skill bundle to `~/.claude/skills/<name>/SKILL.md` (or the agent's equivalent user-skill directory) AND writes the MCP server config so the agent can talk to the engine. The `--force` flag wipes any stale skill content first, so re-runs always end up with the latest copy.

**First-install detection:** if `~/.claude/skills/` didn't exist before this command, Claude Code wasn't watching it and won't auto-detect the new files this session. Tell the user **once**: "Skills installed - restart your agent so they load." On subsequent installs (directory already existed), skills auto-detect mid-session and no restart is needed. **You can detect first-install vs upgrade by checking if `~/.claude/skills/` existed before Step 1; record the result before running setup.**

**Do NOT run `/plugin install` or any slash command.** The CLI path is the canonical install. The marketplace path is an alternative for users who specifically prefer the official plugin TUI; we don't route agents there.

### Step 2: Install the engine app (only if `engine-install` needs attention)

```bash
npx -y summer-engine@latest install
```

~1 GB. Downloads from Summer's signed releases. The bundle includes the engine binary plus Git and a handful of other runtime tools so users who don't already have them aren't blocked. The CLI prints the URL and size before touching disk. Tell the user **"downloading the engine app, ~1 GB, this takes a couple minutes"** so they don't bail thinking it stalled.

**Linux note:** the engine app currently supports macOS and Windows only. On Linux, `summer install` exits with a "Linux support coming soon" message. Surface the manual download URL to the user (https://summerengine.com/download) and stop. The rest of the playbook still works once they've installed manually.

### Step 3: Sign in (only if `login` needs attention)

```bash
npx -y summer-engine@latest login
```

This opens the user's default browser. **Tell the user**: "Your browser is opening now. Click sign-in once and come back to this terminal." The CLI waits up to 120 seconds for the auth callback, writes the token to `~/.summer/auth-token`, and returns. **If the user takes longer than 120 seconds, re-run `npx -y summer-engine@latest login` and tell them to come back to the terminal quickly.** Don't loop indefinitely. The same token is shared with the engine; they sign in once, both surfaces accept it.

### Step 4: Re-run doctor to confirm

```bash
npx -y summer-engine@latest doctor --json
```

Should now return `ok: true` for `cli-version`, `login`, and `engine-install`. `local-api` may still need attention because the engine is not running yet. If a setup check still needs attention, surface the specific message to the user and do not loop or paper over it.

### Step 5: Scaffold a project and run

**Important:** `summer create` writes the project into the current working directory. **Pick a stable parent directory first**, such as the user's home or a Projects folder, and `cd` there before running `create`. Don't let it land in a temp dir or wherever the agent happened to start.

```bash
cd ~/Projects   # or wherever the user keeps code
```

If the user said "let's make a game" without specifying a template, default to `3d-basic`. Pick a sensible project name from the user's request, for example "FPS" to `my-fps-game`. Avoid spaces in the name.

```bash
npx -y summer-engine@latest create 3d-basic my-fps-game
npx -y summer-engine@latest run my-fps-game
```

`summer run` launches the engine app with the project loaded and polls the engine's local API for up to 20 seconds before returning.

### Step 5b: Wait for the engine to be reachable (only if `summer run` printed "API not responding yet")

If the engine takes longer than 20s to boot (cold start, slow disk, etc.), `summer run` returns successfully but the local API isn't up yet. MCP tools may not connect until the local API is ready. Wait for it:

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

### Step 6: Brainstorm the game, then build

Now you have skills + MCP. **Don't jump into `summer create` content from a vague prompt**. Call `summer_start_game_task` with the user's goal, then invoke the recommended skill. For vague "make a game" requests, that should usually be `summer:brainstorm-game`. It scopes mechanics, art direction, and the V1 cut list, and writes the result to `.summer/GameSoul.md`. Every other Summer skill reads from that file.

Project memory lives in `.summer/` as readable Markdown. Use `.summer/memory/` for locked facts that should not drift across sessions, such as character voice IDs, world canon, and provider bindings. Users can inspect it with `summer memory`; agents should read relevant memory surfaced by `summer_get_project_context` before changing creative/audio/dialogue/level/character work.

Only skip brainstorm if the user explicitly said "skip brainstorm" or "just build the X already." After brainstorm, the appropriate build skills (`fps-controller`, `design-mechanic`, `design-level`, `make-game`, etc.) auto-trigger from natural language.

### Anti-patterns (do NOT do these)

- **Don't run `npm install -g summer-engine`.** Use `npx -y summer-engine@latest ...` instead. `-g` requires `sudo` on most Mac/Linux setups, so the user will get permission errors and you'll get stuck. `npx` works without root and the MCP config we ship already points at `npx summer-engine mcp`.
- **Don't try to install Node.js for the user.** If `node --version` is unavailable, point them at https://nodejs.org and stop.
- **Don't ask the user "do you want the engine too?" or "do you also want the CLI?"** There is one product, three pieces, all installed by this playbook.
- **Don't double-install.** Always run `npx -y summer-engine@latest doctor --json` first. Skip steps that already returned `status: ok`.
- **Don't tell the user to type `/plugin marketplace add` or `/plugin install`.** The CLI path is the canonical install. Those slash commands are an alternative for the marketplace TUI, not the primary flow.
- **Don't run `summer install` or `summer login` in the background.** They print user-facing output (engine download progress, browser-opening notice). Run them in the foreground so the user sees what's happening.
- **Don't skip the `--json` flag on `summer doctor`.** Text output is fragile to parse and changes per version.
- **Don't skip the `-y` flag on `npx`.** Without it, npx prompts "ok to install summer-engine?" interactively and the call hangs in a non-interactive shell.
- **Don't drop `@latest` from the npx commands.** `npx -y summer-engine` (no version pin) serves whatever's in npx's local cache, which can be a stale older version. The `@latest` tag forces npm to re-resolve from the registry. If a user reports "unknown command 'doctor'" or sees a much smaller skill list than expected, they got cache-served. Tell them to run `npx clear-npx-cache` then retry with `@latest`.
- **Don't call MCP tools (`summer_get_scene_tree`, etc.) until `local-api` is `ok`.** The engine takes a few seconds to boot after `summer run`. Use Step 5b's wait-loop.
- **Don't `summer create` without `cd`'ing to a stable parent directory first.** It writes into CWD; agents that start in a temp dir will leave the project there.
- **Don't loop `summer login` if it times out at 120s.** Re-run it once and tell the user to be quicker; loop forever and the user is stuck.
- **Don't jump straight into `summer create` from a vague prompt.** Invoke `summer:brainstorm-game` first (Step 6). The build skills assume `.summer/GameSoul.md` exists.

**Using a different agent?** Replace `claude-code` with any supported agent in Step 1: `codex`, `cursor`, `windsurf`, `cline`, `roo-code`, `kilo-code`, `gemini`, `github-copilot`, `vscode-copilot`, `opencode`, or `lm-studio`. (`devin` is also accepted as an alias for `windsurf`.) Skill targets vary per agent (Cursor uses `.cursor/rules/`, Devin Desktop uses `.windsurfrules`, Cline + Roo use `.clinerules/`, Copilot uses `~/.copilot/skills` or `.github/skills`, OpenCode uses agent definitions, etc.). The CLI handles the difference. After install, **Cline and Roo Code users should restart VS Code** so the extension reloads its MCP config. **Gemini users** may need to run `gemini extensions enable summer-engine` after the first install. **VS Code Copilot users** should start the `summer-engine` MCP server from Agent mode if VS Code does not autostart it. **Factory Droid** still has its own plugin path below.

**Power-user note:** if the user specifically wants `summer` on their `PATH` for everyday terminal use outside the AI agent, a global npm install is still possible. The agent flow doesn't need it.

---

## Get started: alternative manual install via plugin marketplace

If you specifically prefer the official Claude Code plugin marketplace UI, you can install via:

```
/plugin marketplace add SummerEngine/summer-engine-agent
/plugin install summer@summer-engine
```

This is functionally equivalent to `npx -y summer-engine@latest setup claude-code --yes` for the skill install. You'll still need `npx -y summer-engine@latest install` and `npx -y summer-engine@latest login` to get the engine running. The agent-driven path above is faster and idempotent; this exists for users who want everything in the plugin TUI.

---

## What just happened (the three pieces)

You installed one product. It has three parts. You don't have to think about them because Summer wires them up, but here's what each does:

- **Summer Engine**: the game engine app. Where you see, play, and debug your game. Installed by the agent via `npx -y summer-engine@latest install`. Proprietary, free to use.
- **Summer agent layer**: the skills, hooks, and plugin manifests that tell Claude Code, Codex, Cursor, and other agents how to build games. Installed by `summer setup` or the marketplace path. MIT, open source.
- **Summer CLI and MCP bridge**: the terminal command and local tool server that install the engine, scaffold projects, run them, sign you in, and let agents talk to the running engine. Usually invoked through `npx -y summer-engine@latest ...`, so no global install is needed. MIT, open source.

The agent layer gives the agent judgment. The CLI and MCP bridge give it hands. The engine is where the game actually lives.

---

## What gets downloaded

We tell you before we touch your disk.

| What | Size | When | Source |
|---|---|---|---|
| `summer-engine` npm package (CLI + plugin source) | ~3 MB | first `npx -y summer-engine@latest ...` call | [npmjs.com/package/summer-engine](https://www.npmjs.com/package/summer-engine) |
| Summer Engine app | ~1 GB (engine + bundled Git/runtime tools) | `npx -y summer-engine@latest install` | Summer's signed releases |
| Auth token | ~1 KB | `npx -y summer-engine@latest login` | Browser to `~/.summer/auth-token` |
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
| **Summer** (this repo: CLI, MCP server, skills, hooks, plugin manifests) | **MIT** | [SummerEngine/summer-engine-agent](https://github.com/SummerEngine/summer-engine-agent) |
| **Summer Engine app** (the desktop editor and runtime) | free to download, closed source for now | [summerengine.com/download](https://summerengine.com/download) |
| **Hosted Summer AI and cloud services** (asset generation, storage, multiplayer, orchestration) | paid Summer services | [summerengine.com/pricing](https://summerengine.com/pricing) |

The desktop app is free to download. The AI-agent layer, meaning the CLI, MCP server, skills, and plugin manifests, is MIT open source. Hosted Summer AI, asset generation, storage, multiplayer, and cloud features are paid Summer services.

---

## How it works

Two pieces, plus the glue.

**Skills.** A bundled set of markdown playbooks. Each one is a discipline guide for the agent. They auto-fire on natural language:

- "Let's brainstorm a game" -> `summer:brainstorm-game`
- "It crashes when I press play" -> `summer:debug`
- "Add an FPS controller" -> `summer:fps-controller`
- "Make it look prettier" -> `summer:art-direction`
- "Set up multiplayer" -> `summer:setup-multiplayer` -> `summer:host-authoritative-state`

Skills don't list steps. They encode the **order of operations**: diagnose before editing, scope before building, ask before guessing. [Agent Skills](https://agentskills.io) format, so any conformant tool picks them up.

**MCP bridge.** The `summer-engine` MCP server gives the agent 52 tools that talk to your local engine on `localhost:6550`:

| | |
|---|---|
| Scene | `summer_add_node`, `summer_set_prop`, `summer_instantiate_scene`, `summer_replace_node`, `summer_get_scene_tree`, `summer_inspect_node`, `summer_batch` |
| Diagnostics | `summer_get_script_errors`, `summer_get_diagnostics`, `summer_get_console`, `summer_get_debugger_errors`, `summer_get_debugger_warnings` |
| Runtime | `summer_play`, `summer_stop`, `summer_is_running` |
| Visual | `summer_screenshot` (see the editor viewport, an offscreen scene render, or the running game) |
| Project | `summer_get_project_context`, `summer_open_main_scene`, `summer_project_setting`, `summer_input_map_bind` |
| Assets | `summer_search_assets`, `summer_import_asset`, `summer_import_from_url`, `summer_generate_image`, `summer_generate_3d`, `summer_generate_audio`, `summer_generate_video` |

File ops, git, shell, and grep already belong to your agent. We don't shadow them.

`summer_batch` is limited to at most 50 allowlisted scene mutations:
`AddNode`, `SetProp`, `SetResourceProperty`, `RemoveNode`, `InstantiateScene`,
`ConnectSignal`, and `ReplaceNode`. The complete batch is rejected before any
engine request when it contains a file, Git, shell, restore, live-input,
verification, internal-diff, or unknown operation. It is not a raw native
executor escape hatch.

**Lifecycle hooks.** A `session-start` hook detects whether you're in a Summer Engine project and feeds the agent a one-line orientation. An opt-in `pre-commit doctor` runs `summer doctor` before `git commit` and blocks when the setup needs attention.

For the full architecture, see [docs/OVERVIEW.md](docs/OVERVIEW.md).

### Using Summer via MCP: the verification loop

There is no single "verify" tool. You **compose** the checks, climbing only as high as the change demands. Call `summer_get_agent_playbook` for the full ladder; the short version:

**1. Does it compile?** After writing a `.gd`, call `summer_get_script_errors res://scripts/player.gd` — no game boot. For a project-wide sweep, `summer_get_diagnostics` (it tells you whether to then read `summer_get_console` / `summer_get_debugger_errors`).

**2. Does it look right?** `summer_screenshot` returns the actual pixels — you see them, no description layer. Pick the target on purpose:
- `viewport` (default) — the editor's current tab, as it looks now.
- `scene` — an offscreen render of a scene *file* (`scenePath`). No boot; **static at t=0**. Confesses if the scene has no `Camera3D` (renders grey/black when played) or no light — read those warnings.
- `game` — a frame from the **running** game (`summer_play` first). Over plain local HTTP this returns an honest failure until the desktop bridge is present; when it fails, drop to `viewport`/`scene` or ask the user.

**3. Does it run?** Compose the loop:

```
summer_clear_console            # clean slate
summer_play                     # boot the game (or a specific scene)
summer_get_debugger_errors      # runtime errors: null refs, missing nodes, physics
summer_screenshot target:game   # optional: look at the live frame
summer_stop                     # ALWAYS stop — scene edits are refused while running
```

**4. Does the interaction work?** Summer MCP does not expose live input
injection or arbitrary verification probes. Use `summer_play`, diagnostics, and
a game screenshot for observable runtime evidence. When behavior still requires
player input, **ask the user to try it** and report what they see — don't fake it.
A typed verification-probe tool can be added only after it has an explicit,
tested source-size and duration contract; it is unavailable today.

**Honesty.** Never describe an image you didn't receive; a failed capture is a *result* — report it and climb down (`scene`→`viewport`) or ask the user. Pass structured failures (`failure_reason`, `terminalState`, `identity_mismatch`) through verbatim. `summer_get_project_context` binds the session to the open project; a `projectMismatch` warning on a screenshot means the engine switched projects and the frame may be from the wrong one — rebind before trusting it.

**Debugging the MCP itself.** Set `SUMMER_MCP_DEBUG=1` in the server's environment to log a structured stderr line per tool call (`tool`, `ok`, `durationMs`, `terminalState`, `errorClass`, `failureReason`, `retried`). With the flag off, only failures are logged.

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

The skill bundle replaces "agent flailing through tutorials" with measurable craft.

---

## What's inside

**Process**: `using-summer`, `brainstorm-game`, `debug`, `play`

**Project setup**: `new-project`, `browse-templates`, `make-game`, `scene-composition`

**Build**: `fps-controller`, `design-mechanic`, `design-level`, `design-npc`

**Multiplayer**: `setup-multiplayer`, `host-authoritative-state`, `peer-to-peer-multiplayer`

**Look & feel**: `art-direction`, `audio-direction`, `3d-lighting`, `vfx`, `ui-basics`

**Code & assets**: `gdscript-patterns`, `asset-strategy`

**Performance & ship**: `tune-performance`, `export-and-ship`

**Skill authoring**: `skill-create`, `skill-improve`, `skill-test`

C# is supported by the engine. A `summer:csharp-patterns` skill is on the roadmap; for now write C# from Godot 4.5 docs.

Full list of shipping skills: the `skills:` array in [`.claude-plugin/plugin.json`](./.claude-plugin/plugin.json).

## Philosophy

- Skills auto-fire on natural language. No slash command required.
- Diagnose before guessing. Read the error before grepping the code.
- Process skills run before build skills.
- Fewer tools, sharper tools.
- The user owns decisions. The agent diagnoses and proposes.

---

## Install: full instructions per harness

### Claude Code

```bash
claude /plugin marketplace add SummerEngine/summer-engine-agent
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

Sidebar to **Plugins** to **Coding**, then click `+` next to **Summer**.

### Cursor

```
/add-plugin summer
```

Or search `summer` in the Cursor plugin marketplace.

### Factory Droid

```bash
droid plugin marketplace add https://github.com/SummerEngine/summer-engine-agent
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

Same shape as Cline (Roo Code is a Cline fork): writes globalStorage MCP config and `.clinerules/` files. **Restart VS Code** afterward. Note: Roo Code shut down in May 2026 — prefer Kilo Code, its maintained successor.

### Kilo Code (VS Code)

```bash
npx -y summer-engine@latest setup kilo-code --yes
```

Writes the MCP server config to VS Code's globalStorage for the Kilo Code extension (project scope writes `.kilocode/mcp.json`) and drops rules into `.kilocode/rules/`. **Restart VS Code** so Kilo reloads its MCP config.

### Gemini CLI

```bash
npx -y summer-engine@latest setup gemini --yes
```

Drops a Summer extension manifest at `~/.gemini/extensions/summer-engine/`. If the extension isn't auto-enabled on next launch, run `gemini extensions enable summer-engine`. The marketplace path (`gemini extensions install https://github.com/SummerEngine/summer-engine-agent`) still works for users who prefer it. Both end up at the same place.

### GitHub Copilot CLI

```bash
npx -y summer-engine@latest setup github-copilot --yes
```

Writes MCP config to `~/.copilot/mcp-config.json` and skills to `~/.copilot/skills/`. In an active Copilot CLI session, run `/mcp reload` and `/skills reload`; otherwise restart Copilot CLI.

### GitHub Copilot in VS Code

```bash
npx -y summer-engine@latest setup vscode-copilot --yes
```

Writes MCP config to VS Code's user `mcp.json` and skills to `~/.copilot/skills/`. Restart VS Code or run **MCP: List Servers**, then use Copilot Agent mode.

### OpenCode

```bash
npx -y summer-engine@latest setup opencode --yes
```

Writes the MCP server entry into `opencode.json` (`~/.config/opencode/opencode.json` for user scope, `./opencode.json` for project) using the array-shaped `command: ["npx", "-y", "summer-engine@latest", "mcp"]` format. Restart OpenCode. Full guide: [`.opencode/INSTALL.md`](./.opencode/INSTALL.md).

### LM Studio (local models)

```bash
npx -y summer-engine@latest setup lm-studio --yes
```

Writes the MCP server entry into `~/.lmstudio/mcp.json` (app-global; there is no project scope). In LM Studio, toggle the `summer-engine` server on in the **Program** tab, and raise the loaded model's context length to **32k or higher** — MCP tool schemas overflow small contexts silently. LM Studio has no rules/skills folder; the MCP server's `summer_get_agent_playbook` tool covers in-chat guidance. Pair with a tool-calling-reliable local model (gpt-oss-20b on 12–16 GB VRAM, Qwen3-Coder-30B on 24 GB).

### Ollama (local models)

Ollama is the model backend, not an MCP client — pair it with OpenCode, Kilo Code, or Goose and point that agent's provider at `http://localhost:11434/v1`. Before connecting MCP, raise Ollama's context window (defaults to 4k under 24 GB VRAM): start with `OLLAMA_CONTEXT_LENGTH=65536 ollama serve`, then `ollama ps` to confirm the model still fits on the GPU.

### Devin Desktop (formerly Windsurf) and others

```bash
npx -y summer-engine@latest setup <agent> --yes --force
npx -y summer-engine@latest doctor
```

---

## CLI reference

| Command | What it does |
|---|---|
| `summer install` | Download Summer Engine. Prints URL and size first. |
| `summer login` | Browser-based sign-in. |
| `summer logout` | Clear auth tokens. |
| `summer status` | Engine state, port, auth. |
| `summer doctor` | Diagnose Node, login, engine, project memory, MCP. |
| `summer plan <goal>` | Route a game-building goal into skills, MCP tools, gates, and verification. |
| `summer memory` | Inspect project memory in `.summer`. |
| `summer memory show <file>` | Print a project memory Markdown file. |
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

Agents: `claude-code`, `codex`, `cursor`, `windsurf`, `cline`, `roo-code`, `kilo-code`, `gemini`, `github-copilot`, `vscode-copilot`, `opencode`, `lm-studio`. (`devin` and `devin-desktop` are accepted as aliases for `windsurf`.) Scopes: `--scope user` (default), `--scope project`.

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
2. **Submit a new SKILL.md** under `skills/<category>/<name>/`. Register it in `.claude-plugin/plugin.json` and `src/lib/skills-registry.ts`. Run `summer:skill-test` against it before opening the PR.

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

## Research Preview: Summer Cloud

Summer Cloud is an experimental R&D preview. It is optional, it may change or break, and it is **not** the core Summer CLI or MCP workflow. You do not need it to install or run Summer Engine, work with local projects, or use the local MCP server. The stable workflow is the local engine, CLI, MCP bridge, and agent skills described above.

The preview explores content-addressed project sync across machines, including large assets that do not fit comfortably in git:

```bash
summer cloud init
summer cloud status
summer cloud push
summer cloud pull
summer cloud restore
```

Matching `summer_cloud_*` MCP tools are also experimental. Keep an independent backup and do not use this preview as the only recovery path for an important project. See [www.summerengine.com/cloud](https://www.summerengine.com/cloud).

---

## License

MIT for everything in this repo. Summer Engine itself is proprietary. See [What's open and what's not](#whats-open-and-whats-not).

## Links

- [Website](https://summerengine.com)
- [Download Summer Engine](https://summerengine.com/download)
- [Documentation](https://summerengine.com/docs)
- [Community](https://summerengine.com/community)
- [Issues](https://github.com/SummerEngine/summer-engine-agent/issues)
