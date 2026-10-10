# Summer: MCP server, CLI and skills for Summer Engine

<div align="center">

<img src="docs/brand/sun.png" alt="" width="128">

### Let any AI coding agent build games in Summer Engine.

**MCP server · game-dev skills · `summer` CLI. One npm package: `summer-engine`.**

[![npm](https://img.shields.io/npm/v/summer-engine?label=npm&color=f7b731)](https://www.npmjs.com/package/summer-engine)
[![downloads](https://img.shields.io/npm/dm/summer-engine?label=installs&color=f7b731)](https://www.npmjs.com/package/summer-engine)
[![license](https://img.shields.io/badge/license-MIT-1a1a1a)](LICENSE)

[**Website**](https://www.summerengine.com) · [**Docs**](https://docs.summerengine.com) · [**CLI setup**](https://www.summerengine.com/cli) · [**MCP setup**](https://www.summerengine.com/mcp)

</div>

---

## What this is

[Summer Engine](https://www.summerengine.com) is a desktop game engine. This repo connects your AI coding agent (Claude Code, Cursor, Codex, Copilot and many more) to it, the way an MCP server for Blender connects an agent to Blender, but for making whole games.

| Part | What it does |
|---|---|
| **MCP server** (`summer mcp`) | Tools your agent calls to drive the running editor: build scenes, write scripts, play the game, take screenshots, read errors. |
| **Skills** | Game-dev know-how your agent loads: movement, combat, multiplayer, VFX, audio, UI, level design and more. |
| **CLI** (`summer`) | Installs the engine, signs you in, sets up your agent, creates projects from templates and publishes games. |

This repo is not the engine itself. The CLI downloads the Summer Engine app for you.

With Summer installed, your agent can:

- **Build real games**: scenes, scripts, physics and UI, through live MCP tools.
- **Build multiplayer games** on Summer's own networking: matchmaking, parties, leaderboards, player data and world saves.
- **Add analytics** to see how players play.
- **Publish games** to the [summer.games](https://summer.games) store.
- **Use proven recipes**: skills, templates and references, all searchable through one index.
- **Check its own work**: play the game, take screenshots, read the debugger, press real keys.
- **Resume any project**: `.summer/` project memory lets a fresh agent pick up where the last one stopped.

You stay in control of every change and release. Summer never publishes, installs, or spends without your explicit confirmation, and library entries are structurally prevented (by a capability lint in CI) from instructing agents to touch the network, credentials, or package managers.

## Get started: one prompt

Open your AI agent (Claude Code, Cursor, Codex, Copilot, Devin Desktop, etc.) and paste:

> Install Summer Engine and let's make a game. Read github.com/summerengine/summer, check what I already have installed, install whatever is missing, log me in, and scaffold a starter project so we can start building.

The agent reads this README, checks what is already on your machine, and runs only the missing steps in its shell.

The first run will:
1. Fetch the `summer-engine` npm package (~2 MB) through npx.
2. Install Summer's game-dev skills into `~/.claude/skills/` (or your agent's user-skill directory) so the agent loads them next session.
3. Download the Summer Engine app (~1 GB, including Git and other runtime tools) if it's not installed.
4. Open your browser for one-click sign-in.
5. Scaffold a starter project and open the engine.

Then ask the agent to build something.

---

## AGENTS READING THIS: install playbook

You are an AI coding agent. The user told you to install Summer Engine. **Run this playbook via your shell**: Bash on macOS/Linux or PowerShell on Windows. Detection first, then only install what's missing. (Once installed, your working guide is [`AGENTS.md`](AGENTS.md).)

**Windows PowerShell: type `npx.cmd` wherever this playbook says `npx`.** Plain `npx` in PowerShell runs `npx.ps1`, which Windows blocks by default ("running scripts is disabled on this system"). `npx.cmd` is the same command without that block. Never change the execution policy or turn off Windows Defender to work around it. Bash (including Git Bash on Windows) can use plain `npx`.

### Step -1: Verify Node.js is on PATH

```bash
node --version
```

If this prints Node.js 20 or newer, continue to Step 0.

**Windows, Node missing or older than 20:** a clean Windows machine has no Node, and the whole CLI and MCP server run through it. Ask the user once: "Summer needs Node.js. OK if I install the LTS version with winget?" On yes, run:

```powershell
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
node --version
```

The second line makes the new Node visible to this shell without a restart. Windows may show an administrator prompt; tell the user to accept it. Then continue the playbook in the same shell. When setup finishes, tell the user: "Restart <your agent app> once so it sees Node, then the Summer MCP connects." An app that was already open when Node was installed cannot start the MCP server until it restarts. If `winget` itself is not available, tell the user: "Install Node.js LTS from https://nodejs.org, then restart this app and re-run the prompt," and stop.

**macOS/Linux, Node missing or older than 20:** stop and tell the user: "Summer needs Node.js 20+. Install from https://nodejs.org and re-run the prompt."

### Step 0: Check what is installed (read-only)

```bash
npx -y summer-engine@latest doctor --json
```

The first call downloads the package into npx's cache (~2 MB, a few seconds); later calls are fast. `-y` answers npx's "ok to install summer-engine?" prompt so the call doesn't hang in a non-interactive shell.

Read the JSON output. **Top-level `ok: true` means "no check failed" — it does NOT mean Summer is installed.** A machine with no skills, no MCP config, and no login can report `ok: true` (those checks warn, they do not fail). So never skip Step 1 on `ok`: it is idempotent and fast. Use the `checks` array (each entry: `id`, `label`, `status` of `ok` / `warning` / `fail`, `message`, optional `details`) only to decide whether the expensive steps — engine download (Step 2) and browser login (Step 3) — are needed.

The check ids are `node-version`, `cli-version`, `cli-version-current`, `skills-version-stale`, `login`, `store-access`, `engine-install`, `local-api`, `project-memory`, `mcp-boot`, and `mcp-tools-list`. For any check whose `status` is not `ok`, run the action in the table below, then re-run doctor.

| Check id | If `status` is `ok` | Action when attention is needed |
|---|---|---|
| `node-version` | continue | Step -1 already covered this |
| `cli-version` | always ok via npx | no action |
| `cli-version-current` | continue | run `npx clear-npx-cache && npx -y summer-engine@latest doctor --json` (forces a fresh resolve) |
| `skills-version-stale` | run Step 1 anyway (idempotent) | run Step 1 (`--force` is already in the command) |
| `login` | skip Step 3 | run Step 3 |
| `store-access` | continue | only for publishing: surface the `message` (it carries the store's own reason); signing in again does not fix a refusal the store gives a valid sign-in |
| `engine-install` | skip Step 2 | run Step 2 |
| `local-api` | skip Step 5b wait-loop | expected before `summer run`; run the wait-loop after it |
| `project-memory` | continue | if a project is open, use the `brainstorm-game` skill before building |
| `mcp-boot` | continue | the MCP server failed to start locally — surface the `message` to the user |
| `mcp-tools-list` | continue | the MCP server started but listed no tools — surface the `message`; usually a stale npx cache (`npx clear-npx-cache`) |

**On version drift:** if either `cli-version-current` or `skills-version-stale` needs attention, refresh before proceeding. Tell the user once: "There's a newer Summer (X.Y.Z to A.B.C); updating before we start." Then run the command in that check's `details.recommendedAction` (a fresh `npx clear-npx-cache && npx -y summer-engine@latest ...`) and re-run doctor. Don't ask the user to choose; they paste "install" and want the latest.

### Step 1: Install skills + MCP config (always run it — idempotent, fast)

```bash
npx -y summer-engine@latest setup claude-code --yes --force
```

Replace `claude-code` with the user's actual agent: `claude-desktop`, `codex`, `cursor`, `windsurf`, `antigravity`, `cline`, `cline-cli`, `kilo-code`, `github-copilot`, `vscode-copilot`, `visual-studio`, `copilot-jetbrains`, `opencode`, `zed`, `kiro`, `goose`, `hermes`, `trae`, `qwen-code`, `kimi-code`, `crush`, `amp`, `factory`, `junie`, `warp`, `rovo-dev`, `qoder`, `grok-build`, `mistral-vibe`, `lm-studio`. Use `github-copilot` for Copilot CLI, `vscode-copilot` for GitHub Copilot Chat/Agent in VS Code, `visual-studio` for Copilot in Visual Studio, and `copilot-jetbrains` for Copilot in JetBrains IDEs. Legacy targets `gemini` and `roo-code` still work; for Google's agent use `antigravity`. This installs **every skill in the library** to `~/.claude/skills/<slug>/SKILL.md` (or the agent's own skill directory), writes the MCP server config, runs doctor, and prints what it installed and where. Preview skills are included and labelled; `--stable-only` skips them. `--force` wipes stale skill copies first. Don't use `--recommended` from this playbook; it installs only a subset.

**First-install detection:** if `~/.claude/skills/` didn't exist before this command, Claude Code wasn't watching it and won't auto-detect the new files this session. Tell the user **once**: "Skills installed - restart your agent so they load." On subsequent installs (directory already existed), skills auto-detect mid-session and no restart is needed. **You can detect first-install vs upgrade by checking if `~/.claude/skills/` existed before Step 1; record the result before running setup.**

**Do NOT run `/plugin install` or any slash command.** The CLI is the supported install path; the plugin marketplace is only for users who ask for it.

### Step 2: Install the engine app (only if `engine-install` needs attention)

```bash
npx -y summer-engine@latest install
```

~1 GB from Summer's signed releases, including Git and other runtime tools. The CLI prints the URL and size before it writes anything. Tell the user **"downloading the engine app, ~1 GB, this takes a couple minutes"** so they don't bail thinking it stalled.

**Already installed?** `summer install` never silently replaces an engine. An equal version exits 0 as "up to date"; a different version is replaced only with `--yes` or a TTY confirmation, and the new bundle is swapped in only after it copied completely, so a failed download leaves the old engine in place.

**Linux note:** on Linux (x86_64) `summer install` places the engine binary under `~/.summer/engine/` (or symlinks a local build via `--path`). There is no desktop app bundle; the editor runs from that binary. Other architectures: point the user at https://summerengine.com/download and stop.

### Step 3: Sign in (only if `login` needs attention)

```bash
npx -y summer-engine@latest login
```

This opens the user's default browser. **Tell the user**: "Your browser is opening now. Click sign-in once and come back to this terminal." The CLI waits up to 120 seconds for the sign-in, checks the returned identity, and stores the session in `~/.summer/`, which the engine shares. **If the user takes longer than 120 seconds, re-run `npx -y summer-engine@latest login` once and tell them to come back to the terminal quickly.** Don't loop.

### Step 4: Re-run doctor to confirm

```bash
npx -y summer-engine@latest doctor --json
```

`cli-version`, `login`, `engine-install`, `mcp-boot`, and `mcp-tools-list` should now have `status: "ok"`. `local-api` may still need attention because the engine is not running yet. If a setup check still needs attention, surface the specific `message` to the user and do not loop or paper over it.

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

If the engine takes longer than 20 seconds to boot, `summer run` returns before the local API is up, and MCP tools cannot connect yet. Wait for it:

`doctor --json` is pretty-printed (one field per line: `"id"`, `"label"`, `"status"`, …), so match across lines:

```bash
# Poll doctor until local-api flips to ok (max ~30s):
for i in 1 2 3 4 5 6; do
  npx -y summer-engine@latest doctor --json | grep -A2 '"id": "local-api"' | grep -q '"status": "ok"' && break
  sleep 5
done
```

(Equivalent PowerShell: `for ($i=0; $i -lt 6; $i++) { $r = (npx -y summer-engine@latest doctor --json) -join "`n"; if ($r -match '"id": "local-api",\s*"label": "[^"]*",\s*"status": "ok"') { break }; Start-Sleep 5 }`)

Once `local-api` is `ok`, MCP tools are safe to call.

### Step 6: Brainstorm the game, then build

Now you have skills + MCP. **Don't jump into `summer create` content from a vague prompt**. Call `summer_start_game_task` with the user's goal, then invoke the recommended skill. For vague "make a game" requests, that should usually be the `brainstorm-game` skill (installed skills are invoked by their bare slug — there is no `summer:` prefix). It scopes mechanics, art direction, and the V1 cut list, and writes the result to `.summer/GameSoul.md`. Every other Summer skill reads from that file.

Project memory lives in `.summer/` as readable Markdown. Use `.summer/memory/` for locked facts that should not drift across sessions, such as character voice IDs, world canon, and provider bindings. Users can inspect it with `summer memory`; agents should read relevant memory surfaced by `summer_get_project_context` before changing creative/audio/dialogue/level/character work.

Only skip brainstorm if the user explicitly said "skip brainstorm" or "just build the X already." After brainstorm, the appropriate build skills (`fps-controller`, `design-mechanic`, `design-level`, `make-game`, etc.) auto-trigger from natural language.

### Anti-patterns (do NOT do these)

- **Don't run `npm install -g summer-engine`.** Use `npx -y summer-engine@latest ...` instead. `-g` requires `sudo` on most Mac/Linux setups, so the user will get permission errors and you'll get stuck. `npx` works without root and the MCP config we ship already points at `npx summer-engine mcp`.
- **Don't install Node.js without asking, and don't use anything but winget for it.** On Windows, Step -1 installs Node LTS with winget after the user says yes. On macOS/Linux, point them at https://nodejs.org and stop.
- **Don't run plain `npx` in Windows PowerShell, and don't change the execution policy or Defender to make it work.** Use `npx.cmd`.
- **Don't ask the user "do you want the engine too?" or "do you also want the CLI?"** This playbook installs all of it.
- **Don't double-download.** Always run `npx -y summer-engine@latest doctor --json` first and skip the engine download and the browser login when their checks are `status: "ok"`. Step 1 (`setup`) is the exception: run it every time — it is idempotent, and doctor's top-level `ok` cannot tell you whether skills or the MCP config are installed.
- **Don't run `summer install` or `summer login` in the background.** They print user-facing output (engine download progress, browser-opening notice). Run them in the foreground so the user sees what's happening.
- **Don't skip the `--json` flag on `summer doctor`.** Text output is fragile to parse and changes per version.
- **Don't skip the `-y` flag on `npx`.** Without it, npx prompts "ok to install summer-engine?" interactively and the call hangs in a non-interactive shell.
- **Don't drop `@latest` from the npx commands.** `npx -y summer-engine` (no version pin) serves whatever's in npx's local cache, which can be a stale older version. The `@latest` tag forces npm to re-resolve from the registry. If a user reports "unknown command 'doctor'" or sees a much smaller skill list than expected, they got cache-served. Tell them to run `npx clear-npx-cache` then retry with `@latest`.
- **Don't call MCP tools (`summer_get_scene_tree`, etc.) until `local-api` is `ok`.** The engine takes a few seconds to boot after `summer run`. Use Step 5b's wait-loop.
- **Don't `summer create` without `cd`'ing to a stable parent directory first.** It writes into CWD; agents that start in a temp dir will leave the project there.
- **Don't loop `summer login` if it times out at 120s.** Re-run it once and tell the user to be quicker; loop forever and the user is stuck.
- **Don't jump straight into `summer create` from a vague prompt.** Invoke the `brainstorm-game` skill first (Step 6). The build skills assume `.summer/GameSoul.md` exists.

**Using a different agent?** Use its id from Step 1 (aliases such as `devin`, `agy` and `droid` also work; see the [CLI reference](#cli-reference)). Skill folders vary per agent; the CLI handles the difference, and [`integrations/README.md`](integrations/README.md) documents exactly what gets written where for every client. After install, **Cline users should restart VS Code** so the extension reloads its MCP config. **VS Code Copilot users** should start the `summer-engine` MCP server from Agent mode if VS Code does not autostart it.

If the user wants `summer` on their `PATH` for everyday terminal use, a global npm install works too. The agent flow doesn't need it.

---

## The lifecycle: create → test → publish → grow

| Stage | Status | What it means today |
|---|---|---|
| **Create** | Available | Scaffold from a pinned template, build scenes and scripts through MCP, generate 2D/3D/audio/video assets, guided by the library. |
| **Test** | Available | The verification ladder: compile checks, screenshots, live play with debugger reads, and input-driven probes (`RunVerification`) that press real keys and assert on real frames. |
| **Publish** | Preview | `summer_export_game` exports the game with the installed engine (headless); `summer_publish_build` uploads it to your game's summer.games store listing after you confirm the exact game, file and version (sign in once with `summer login --store`). Nothing is submitted silently. |
| **Grow** | Planned | Analytics, retention and live-ops tooling will arrive as new library entries. Not part of this package yet. |

## What's in this repo

```
summer/
├── README.md          # you are here: overview + the install playbook
├── AGENTS.md          # the agent guide: trust, the library, navigation, engine rules
├── src/               # the Summer software (TypeScript)
│   ├── core/          #   shared implementations (capabilities used by both CLI and MCP)
│   ├── cli/           #   the `summer` command surface
│   ├── mcp/           #   the MCP server and tool adapters
│   ├── project-memory/#   .summer/ read/write
│   └── installer/     #   agent detection and config writing for every supported client
├── library/           # the Library: tools, skills, templates, references
├── registry/          # schemas + generated/ (the compiled index everything reads; never hand-edited)
├── evals/             # evidence the library works: routing, skills, examples, templates, tools, end-to-end
├── integrations/      # one folder per supported agent: what gets installed where
├── scripts/           # generate-registry (the compiler), validate-library (schema + capability lint)
└── docs/              # development guide, migration notes, design contract
```

One rule ties it together: **every entry is described once** (a `resource.yaml` in `library/`), and the registry compiler generates everything else — the searchable index, every agent plugin manifest, the skill installer data, counts, and legacy aliases. CI fails on any drift. See [`docs/design/CONTRACT.md`](docs/design/CONTRACT.md).

## The library

Six kinds of entry, all searchable through the same generated index:

- **Skills** — how to do something well (FPS controllers, scene composition, debugging discipline, VFX recipes, audio direction…). Open [Agent Skills](https://agentskills.io) format, so any conformant tool picks them up.
- **Examples** — proven working instances with required evidence (screenshots, verification receipts) — an example that can't show it works doesn't ship.
- **Templates** — complete project foundations (platformers, FPS, racing, roguelikes, multiplayer starters…), each pinned to an exact commit with a verified tree digest. `summer create <slug>` fetches exactly that commit, recomputes the digest and refuses on mismatch, then records the pin into the project's `.summer/project.json` — never whatever a branch happens to contain today. Two small templates (`3d-basic`, `empty`) are built in and generate offline. Browse with `summer list templates`; pinning rules and the digest formula in [`library/templates/README.md`](library/templates/README.md).
- **Collections** — curated, compatible creative materials: asset sets with style rules and presets. None ship yet.
- **References** — facts: engine version compatibility, GDScript style, tool references.
- **Tools** — the executable capabilities themselves, described in the same registry so agents can discover what they can do.

Agents don't browse folders; they search the compiled index (`registry/generated/index.json`) through `summer_search_library` (or `summer tool search-library`) by summary, use-cases, and facets, then load the hit with `summer_read_library`. IDs are permanent, so feedback and evidence follow an entry across any reorganization.

## The ecosystem

```
 Claude Code · Codex · Cursor · Gemini · Copilot · OpenCode · …
        │            (any AI coding agent)
        ▼
 ┌──────────────────────────────────────────────┐
 │  Summer (this repo, npm: summer-engine)      │
 │  library · registry · MCP tools · CLI        │
 │  project memory (.summer/) · evals           │
 └──────────────────────────────────────────────┘
        │ MCP / local API
        ▼
 Summer Engine (desktop app: editor + runtime)
        │
        ▼
 summer.games store · your players
```

Summer works with any agent: `integrations/` adapts one generated system to each. The map of what gets installed where is [`integrations/README.md`](integrations/README.md).

## Project memory: `.summer/`

Every Summer project carries its own memory, as readable Markdown and JSON:

- `GameSoul.md` — the game's promise, written at brainstorm, read by every build skill.
- `memory/` — locked facts that must not drift: character voices, world canon, provider bindings.
- `project.json` — the template pin (`id`, `version`, `repo` + `commit` + `tree_digest`, or `builtin: true`), the `toolkit_version` that scaffolded it, and `created_at`: exactly which template, at which commit, started this project.

The point: a fresh agent — any agent, any session — can answer *what game is this, what's done, what's verified, what's next* without the original conversation. Inspect it yourself with `summer memory`.

## Bring your own skills

Two ways to extend Summer with your own material:

1. **Drop skills into your agent** the normal way (`~/.claude/skills/`, `.cursor/rules/`, etc.) — Summer's skills are standard Agent Skills format and coexist with yours.
2. **Give them to Summer** (planned): external Summer-format resources will install project-, user-, or studio-scoped and be recorded in `.summer/project.json`, so every agent on the project sees them. The schema side is in place — external entries are namespaced (`<publisher>/<kind>/<slug>`) and can never silently shadow an official ID — the installer is not built yet.

Official entries land in this repo by PR, gated by schema validation and the capability lint.

## Library feedback

- Agents can report how an entry worked (`summer_library_feedback`): worked / worked with fixes / wrong / outdated / incomplete / did not apply / misrouted. What is sent, in full: the entry ids, one outcome word each, an optional note and deviation (280 characters max, about the entry), the engine version, the agent's self-reported model id, this CLI's version, the host app name/version, a random per-process session id, and — only when logged out — a random install uuid (when logged in, the account token is sent instead). **The schema cannot carry your code, files, or chat.** The very first call on a machine sends nothing and returns a notice; `SUMMER_NO_TELEMETRY=1` or `DO_NOT_TRACK=1` turns it off entirely.
- Today those reports land in a write-only mailbox that maintainers read. Only verified outcomes count; popularity never ranks an entry.

## What gets downloaded

We tell you before we touch your disk.

| What | Size | When | Source |
|---|---|---|---|
| `summer-engine` npm package (CLI + MCP + library) | ~2 MB download, ~6 MB unpacked | first `npx -y summer-engine@latest ...` call | [npmjs.com/package/summer-engine](https://www.npmjs.com/package/summer-engine) |
| Summer Engine app | ~1 GB (engine + bundled Git/runtime tools) | `npx -y summer-engine@latest install` | Summer's signed releases |
| Auth token | ~1 KB | `npx -y summer-engine@latest login` | Browser to `~/.summer/auth-token` |
| Creator token | ~50 bytes | only when you run `summer login --creator` and mint one | One-time browser value to `~/.summer/creator-token`; never replaces the auth token |
| Store sign-in | ~2 KB | only when you run `summer login --store` | Browser OAuth (PKCE, loopback port 47615-47617) to `~/.summer/oauth-token` with its refresh token, plus this machine's public client id in `~/.summer/oauth-client`; never replaces the auth token |
| Skill files | small, bundled | in the npm package | no extra network call |
| Generated assets (3D / image / audio / video) | varies | only on explicit `summer_generate_*` calls when that provider route is enabled for the account | Summer Engine Studio |
| URL imports | varies | only on explicit `summer_import_from_url` calls | the URL you provide |

Not downloaded, not collected:
- No background telemetry. Diagnostics stay local. The only network report is the opt-out library feedback mailbox described above.
- No silent engine updates. `summer install` checks the installed version and asks before replacing it (or needs `--yes`); nothing updates the engine behind your back.
- No model weights. AI generation runs in Summer Engine Studio (cloud), never on your machine.

## What's open and what's not

| Thing | License | Source |
|---|---|---|
| **Summer** (this repo: CLI, MCP server, library, integrations) | **MIT** | [summerengine/summer](https://github.com/summerengine/summer) |
| **Summer Engine app** (the desktop editor and runtime) | free to download, closed source for now | [summerengine.com/download](https://summerengine.com/download) |
| **Hosted Summer integrations** | availability and terms vary by rollout; preview features are labeled in the CLI | [summerengine.com/pricing](https://summerengine.com/pricing) |

A command, tool contract, or roadmap entry does not by itself mean a hosted
service is production-ready. Managed publishing, hosting, store submission, and
matchmaking are not promised by this package.

## CLI reference

| Command | What it does |
|---|---|
| `summer install [--yes]` | Download Summer Engine. Prints URL and size first; never replaces an installed engine without confirmation. |
| `summer login` | Browser-based core Summer sign-in. |
| `summer login --store` | Browser sign-in to the Summer store so agents can upload builds (`summer_publish_build`). |
| `summer login --creator` | Deprecated: connect a creator token for the legacy `summer publish`. |
| `summer logout` | Clear auth tokens. |
| `summer config [get\|set\|unset]` | Read or update the shared non-secret `~/.summer/config.json`. |
| `summer publish [project] --artifact <game.pck> --version <value> [--confirm]` | Deprecated: use `summer tool export-game`, then `summer tool publish-build`. |
| `summer releases [--cursor <value>]` | List your creator release history. |
| `summer status` | Engine state, port, auth. |
| `summer doctor` | Diagnose Node, login, engine, project memory, MCP. |
| `summer plan <goal>` | Route a game-building goal into skills, MCP tools, gates, and verification. |
| `summer memory` | Inspect project memory in `.summer`. |
| `summer memory show <file>` | Print a project memory Markdown file. |
| `summer run [path] [--background\|--focus] [--bin <executable>]` | Launch the engine. Agents (no TTY) launch in the background by default so the window never steals focus; `--focus` brings it to the front. `--bin` (env `SUMMER_BIN`) launches a build that is not installed. |
| `summer open <path \| target> [--print] [--list]` | A project directory opens in the running engine. Anything else is a navigation target — `billing`, `my-games`, `mcp-guide`, `scene`, `inspector`, an intent phrase, a `res://` path — opened in the browser or sent to the editor; `--print` resolves without opening. |
| `summer create <template> [name]` | Scaffold a project from a pinned template. |
| `summer list templates` / `projects` | Browse. |
| `summer events [--follow] [--kinds <csv>] [--since <seq>] [--json]` | The engine events channel (engine 0.5.66+): newest events, or stream them live. |
| `summer debug [issue…]` | Support-ready Markdown debug report. |
| `summer skills list` | Show all skills (`--by-domain` groups them; the same grouping is in [`library/skills/README.md`](library/skills/README.md)). |
| `summer skills install <name>` | Install one. |
| `summer skills install --all --agent <agent>` / `--recommended` [`--stable-only`] | Install every skill (preview included and labelled), or only the recommended subset; `--stable-only` skips preview skills. |
| `summer tool <name> --args '<json>'` | Run any Summer tool from the shell — the same implementation the MCP tool uses. `summer tool --list` prints them all. |
| `summer mcp [--project <path> \| --instance <id>]` | Start MCP; normally auto-binds from the agent's project directory. |
| `summer mcp setup <agent>` | Deprecated alias of `summer setup <agent>`. |
| `summer setup <agent> [--yes] [--force] [--recommended] [--stable-only]` | One shot: MCP config + all skills, preview included (`--recommended` for the subset, `--stable-only` to skip preview) + doctor. Idempotent. |

Agents: `claude-code`, `claude-desktop`, `codex`, `cursor`, `windsurf`, `antigravity`, `cline`, `cline-cli`, `kilo-code`, `github-copilot`, `vscode-copilot`, `visual-studio`, `copilot-jetbrains`, `opencode`, `zed`, `kiro`, `goose`, `hermes`, `trae`, `qwen-code`, `kimi-code`, `crush`, `amp`, `factory`, `junie`, `warp`, `rovo-dev`, `qoder`, `grok-build`, `mistral-vibe`, `lm-studio`. Legacy (still accepted, warn on use): `gemini`, `roo-code`. Aliases: `devin`/`devin-desktop` → `windsurf`, `agy` → `antigravity`, `droid` → `factory`, `copilot` → `github-copilot`, `vscode` → `vscode-copilot`, `kilo` → `kilo-code`, `qwen` → `qwen-code`, `kimi` → `kimi-code`. Scopes: `--scope user` (default), `--scope project`.

## Contributing

The library grows by PR, and CI holds the line:

1. **Report a bad entry.** Open an issue quoting the prompt and the response — or, if you're an agent, file `summer_library_feedback` after a verified failure.
2. **Improve or add an entry.** Add `library/<kind>/<slug>/` with a `resource.yaml` (plus `SKILL.md` for skills). Run `npm run validate:library`, regenerate with `node scripts/generate-registry/cli.ts`, and commit both. Schema, capability lint, and registry parity are enforced in CI.

[`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md) is the contributor guide; [`docs/design/CONTRACT.md`](./docs/design/CONTRACT.md) is the rulebook.
Testing an unpublished build end to end against the real engine and a real agent: [`docs/TESTING.md`](./docs/TESTING.md).

## Docs

- [Agent guide (AGENTS.md)](AGENTS.md) — how agents use Summer, including the verification ladder
- [Development guide](docs/DEVELOPMENT.md) · [v2 → v3 migration](docs/MIGRATION-V2-V3.md)
- [Design: contract](docs/design/CONTRACT.md) · [decisions](docs/design/DECISIONS.md)
- [Agent support map](integrations/README.md) · [Template pinning](library/templates/README.md) · [Evals](evals/README.md)
- Per-host notes: [Claude Code](docs/CLAUDE_CODE.md) · [Codex](docs/CODEX.md) · [Cursor](docs/CURSOR.md) · [OpenCode](.opencode/INSTALL.md)

## License

MIT for everything in this repo. Summer Engine itself is proprietary. See [What's open and what's not](#whats-open-and-whats-not).

Some process skills (brainstorming, writing-plans, writing-skills, investigating-bugs) are adapted from [obra/superpowers](https://github.com/obra/superpowers), MIT licensed. Attribution is in [NOTICE](NOTICE).

## Links

- [Website](https://summerengine.com)
- [Download Summer Engine](https://summerengine.com/download)
- [Documentation](https://docs.summerengine.com)
- [Issues](https://github.com/summerengine/summer/issues)
