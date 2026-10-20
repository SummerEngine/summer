# Summer Engine: MCP server, CLI and skills

<div align="center">

<img src="docs/brand/sun.png" alt="" width="128">

### The game engine built for AI.

**Any agent builds, tests and publishes a full multiplayer game. MCP server · game-dev skills · `summer` CLI, in one npm package: `summer-engine`.**

[![npm](https://img.shields.io/npm/v/summer-engine?label=npm&color=f7b731)](https://www.npmjs.com/package/summer-engine)
[![downloads](https://img.shields.io/npm/dm/summer-engine?label=downloads&color=f7b731)](https://www.npmjs.com/package/summer-engine)
[![license](https://img.shields.io/badge/license-MIT-1a1a1a)](LICENSE)

[**Website**](https://www.summerengine.com) · [**Docs**](https://docs.summerengine.com) · [**CLI setup**](https://www.summerengine.com/cli) · [**MCP setup**](https://www.summerengine.com/mcp)

</div>

---

## Install

- **Start a game now** (Node 22+): `npx -y summer-engine@latest dev`. It asks before it installs the Summer Engine app (about 660 MB, free) when it is missing, creates a starter project here (in `./my-game` when this folder has other files) and opens it, ready for your agent. No sign-in needed to build.
- **Chat apps** (Claude, ChatGPT, Cursor...): add `https://mcp.summerengine.com/mcp`. Nothing to install.
- **Homebrew:** `brew install summerengine/tap/summer`
- **npm** (Node 22+): `npm install -g summer-engine`

**CLI only** (summer-engine 4.2.0 or newer), no MCP server: `summer setup --cli`. `summer ops search "publish my game"` finds any operation, signed in or not.

## Connect

**Cloud work: `https://mcp.summerengine.com/mcp`.** Nothing to install. Add the URL to your agent and sign in to your Summer account once. Your agent then makes assets (images, 3D models, motion, sound effects, music, voices, video), searches and downloads your Summer asset library, plans games, and runs your projects, the store, publishing, prices, analytics, A/B tests, your team and Studio. It has no engine tools: for those, use the local server below.

| Agent | Add the hosted server |
|---|---|
| Claude Code | `claude mcp add --transport http summer-cloud https://mcp.summerengine.com/mcp`, then `/mcp` to sign in |
| Codex | `codex mcp add summer-cloud --url https://mcp.summerengine.com/mcp`, then `codex mcp login summer-cloud` |
| Cursor | [Add to Cursor](https://cursor.com/install-mcp?name=summer-cloud&config=eyJ1cmwiOiJodHRwczovL21jcC5zdW1tZXJlbmdpbmUuY29tL21jcCJ9), or add `"summer-cloud": {"url": "https://mcp.summerengine.com/mcp"}` under `mcpServers` in `~/.cursor/mcp.json` |
| VS Code | [Add to VS Code](https://vscode.dev/redirect/mcp/install?name=summer-cloud&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.summerengine.com%2Fmcp%22%7D), or `code --add-mcp '{"name":"summer-cloud","type":"http","url":"https://mcp.summerengine.com/mcp"}'` |
| Devin Desktop (formerly Windsurf) | add `"summer-cloud": {"serverUrl": "https://mcp.summerengine.com/mcp"}` under `mcpServers` in `~/.config/devin/mcp_config.json` (Windows `%APPDATA%\devin\mcp_config.json`) |
| Claude Desktop, claude.ai | Settings > Connectors > Add custom connector, then paste the URL |

**Engine work: `npx -y summer-engine@latest setup <agent> --yes`** (needs Node 22+). It writes the local server (`summer mcp`) into your agent's config with the skills. The local server drives the Summer Engine app on your machine: build scenes, write scripts, play the game, take screenshots, read errors. After `summer login` it also runs every cloud operation, so your agent needs one server. Or paste the prompt in [Get started](#get-started-one-prompt) and your agent does every step.

**CLI only (summer-engine 4.2.0 or newer): `npx -y summer-engine@latest setup <agent> --cli --yes`.** No MCP server: your agent runs Summer as commands in its shell. Setup installs the skills for your agent, with `summer-cli`, the guide to the commands, and writes no MCP entry. Your agent signs you in with `summer login`, finds an operation with `summer ops search "<what you want>"` and runs it as `summer <area> <action> --<field> <value>`, with `--dry-run`, `--wait` and `--json`. Engine commands (`summer engine …`) drive the Summer Engine app on your machine. Each skill ends with a table of the command for every tool it names. Add `--assets-only` for only the asset skills. `--no-mcp` is the same as `--cli`.

**ChatGPT and Claude's connector directory** use two reviewed store versions with a fixed tool list: `https://mcp.summerengine.com/chatgpt` (games, assets and generation; no publishing, no billing links) and `https://mcp.summerengine.com/directory` (the store, publishing and Grow reads; no image, 3D, audio or video generation). They keep their 3.x tool names and have no `summer_search` or `summer_call`. For everything else, use `/mcp`.

## What this is

[Summer Engine](https://www.summerengine.com) is the game engine built for AI. This repo connects your AI coding agent (Claude Code, Cursor, Codex, Copilot and many more) to it: the agent builds a whole game in the engine, tests it, publishes it to [summer.games](https://summer.games) and reads how players play it.

| Part | What it does |
|---|---|
| **MCP server** (`summer mcp`) | Tools your agent calls to drive the running editor: build scenes, write scripts, play the game, take screenshots, read errors. After `summer login` it also runs the cloud operations: assets, plans, the store, publishing, prices and analytics. |
| **Skills** | Game-dev know-how your agent loads: movement, combat, multiplayer, VFX, audio, UI, level design and more. |
| **CLI** (`summer`) | Installs the engine, signs you in, sets up your agent, creates projects from templates and publishes games. |

This repo is not the engine itself. The CLI downloads the Summer Engine app for you.

With Summer installed, your agent can:

- **Build real games**: scenes, scripts, physics and UI, through live MCP tools.
- **Build multiplayer games** on Summer's own networking: matchmaking, parties, leaderboards, player data and world saves.
- **Add analytics** to the game and read it back: store page views, launches, play sessions, play time and your own events.
- **Publish games** to the [summer.games](https://summer.games) store: the store page, art, the build, a private preview link and the release. Summer's automatic checks run before anything goes live; staff review games afterwards.
- **Use proven recipes**: skills, templates and references, all searchable through one index.
- **Check its own work**: play the game, take screenshots, read the debugger, press real keys.
- **Resume any project**: `.summer/` project memory lets a fresh agent pick up where the last one stopped.

### You decide what your agent may do

Studio > Settings > Agent permissions has six switches. They apply to every app you connect, like Claude or ChatGPT. These defaults apply now. You can change them soon. Until then, Summer Games still asks the game's owner before an agent publishes, and price, A/B test and member changes ask you first.

| Switch | Default | What the agent may do without asking |
|---|---|---|
| Make and build | on | Edit drafts, scenes, plans and uploads, and start builds. |
| Spend credits | on | Generate assets and run paid builds, within your credits and your auto top-up limit. |
| Publish | on | Publish store pages, versions and releases. Summer's automatic checks still run first. |
| Prices and live changes | on | Change prices and sales, start or stop A/B tests, change member roles. |
| Delete for good | off: asks | Delete games, assets, pages and releases. |
| Contact people | off: asks | Send invites and other emails to real people. |

When a switch is off, the agent asks you first. It gives you a link (`https://www.summerengine.com/studio/approvals/<id>`), and an open Studio tab shows the request with Approve and Decline. Nothing changes until you approve. The agent always asks before it changes agent permissions or auto top-up, enters a jam, or changes the analytics event limit. Studio > Settings > Agent activity lists what agents changed or asked for, newest first, with Undo for prices, sales, country prices, member roles, team names and the event limit.

Generation and paid builds spend your Summer credits. Turn on auto top-up in Studio Billing: when your credits fall below an amount you pick, Summer adds the amount you choose, up to a monthly limit you set. Agents can never change auto top-up on their own. When credits run out, your agent gets the error `no_credits` with one link: https://www.summerengine.com/studio/credits.

Summer never installs software without your explicit confirmation. Library entries are structurally prevented (by a capability lint in CI) from instructing agents to touch the network, credentials, or package managers.

## Get started: one prompt

Open your AI agent (Claude Code, Cursor, Codex, Copilot, Devin Desktop, etc.) and paste:

> Install Summer Engine and let's make a game. Read github.com/summerengine/summer, check what I already have installed, install whatever is missing, and open a starter project so we can start building.

The agent reads this README, checks what is already on your machine, and runs only the missing steps in its shell.

The first run will:
1. Fetch the `summer-engine` npm package (~2 MB) through npx.
2. Install Summer's game-dev skills into `~/.claude/skills/` (or your agent's user-skill directory) so the agent loads them next session.
3. Run `npx -y summer-engine@latest dev`: download the Summer Engine app (about 660 MB) if it's not installed, create a starter project and open it in the engine.

Building needs no sign-in. Your agent asks you to sign in only when you first use Summer's cloud (generating assets, publishing).

Agents with no shell (Claude Desktop, chat apps with the local server) do the same through the MCP: `summer_projects_create_local` writes the starter project and `summer_projects_open_local` opens it, after you say yes to installing the engine.

In most agents (Claude Code, Codex, Cursor, GitHub Copilot (VS Code, CLI, JetBrains), Zed, Cline, Kilo Code, OpenCode, Devin Desktop, Antigravity, Kiro, Trae, Warp, Goose, Hermes, Crush, Amp, Factory, Junie, Qwen Code, Kimi Code, Grok Build and Mistral Vibe), setup also connects Summer Games (`summer-games`), so the agent can see your friends, start parties and send messages as you. You sign in once; setup prints the step for your agent (Claude Code: `/mcp`, choose `summer-games`; Codex: `/mcp login summer-games`; Cursor: Connect next to `summer-games` in its MCP settings). A summer.games page opens in your browser; sign in and choose Allow.

Then ask the agent to build something.

### Claude Code: the Summer plugin

In Claude Code, type:

```text
/plugin install summer --marketplace summerengine/summer
```

Then type `/summer:start`. It gets a first game playing in about five minutes, with one OK from you and no sign-in: from a template that already plays, or from a plan of concept art Summer draws for your idea right in the chat, built in the Summer Engine desktop app. The plugin brings Summer's skills and two MCP servers: `summer-engine` drives the desktop app (needs Node), and `summer-cloud` is Summer's hosted server (sign in once with `/mcp`). Use the plugin or `summer setup claude-code`, not both: they install the same skills.

### Only want assets?

Sound effects, music, voices, images, 3D models, motion and video are made on Summer's servers, so you do not need the Summer Engine app for them. The quickest way is the hosted server in [Connect](#connect): no Node, no install. To get the asset skills too, paste this instead:

> Connect Summer to this agent so I can make game assets. Read github.com/summerengine/summer, connect yourself to Summer and log me in. Skip the Summer Engine app and the starter project, I only want assets.

The agent installs the asset skills and the MCP config (summer-engine 4.0.0 or newer) and signs you in. It does not download the engine. Each asset lands in your Summer library as a normal file: GLB for 3D models, PNG, JPG or WebP for images, MP3 or WAV for audio, MP4 for video. The agent saves each file into your project (your engine's asset folder, or the folder you name), so any engine or web app can use it.

---

## AGENTS READING THIS: install playbook

<details>
<summary>The step-by-step install playbook your agent runs (humans can skip it)</summary>

You are an AI coding agent. The user told you to install Summer Engine. **Run this playbook via your shell**: Bash on macOS/Linux or PowerShell on Windows. Detection first, then only install what's missing. (Once installed, your working guide is [`AGENTS.md`](AGENTS.md).)

**Assets only.** If the user only wants assets (sound effects, music, voices, images, 3D models, video), not a game built in Summer Engine, or tells you to skip the engine: run Step -1, Step 0, Step 1 with `--assets-only` added, and Step 3, then stop installing. `--assets-only` writes the `assets` tool profile (generation and asset tools, no engine tools), installs only the asset skills, and leaves out Summer Games (it is for playing with friends, and leaving it out saves a sign-in). Skip Step 2 (the engine download), Step 5 and Step 6. On this path the doctor warnings for `engine-install` and `local-api` are expected; leave them. The asset operations (`assets.generate_audio`, `assets.generate_sfx_choices`, `assets.generate_image`, `assets.generate_3d`, `assets.generate_video`, `assets.search`) run on Summer's servers and need only the login. Most agents load a new MCP server only after a restart. Until then, run the same operation from the shell: `npx -y summer-engine@latest <area> <action> --<field> <value>` (`summer ops search <words>` finds one and its input). For example, three versions of one sound for the user to pick from: `npx -y summer-engine@latest assets generate-sfx-choices --text "sword clash"`. Each asset lands in the user's Summer library; `out` (a folder or a file path) on the call saves it on this machine and the answer gives `localPath`, and `assets.get` returns a `downloadUrl` for use outside Summer Engine.

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

Read the JSON output. **Top-level `ok: true` means "no check failed" — it does NOT mean Summer is installed.** A machine with no skills, no MCP config, and no login can report `ok: true` (those checks warn, they do not fail). So never skip Step 1 on `ok`: it is idempotent and fast. Use the `checks` array (each entry: `id`, `label`, `status` of `ok` / `warning` / `fail`, `message`, optional `details`) only to decide whether the expensive steps — engine download (Step 2) and browser login (Step 3) — are needed. Building needs no login: Step 3 is for cloud work only.

The check ids are `node-version`, `cli-version`, `cli-version-current`, `skills-version-stale`, `login`, `store-access`, `engine-install`, `local-api`, `project-memory`, `mcp-boot`, and `mcp-tools-list`. For any check whose `status` is not `ok`, run the action in the table below, then re-run doctor.

| Check id | If `status` is `ok` | Action when attention is needed |
|---|---|---|
| `node-version` | continue | Step -1 already covered this |
| `cli-version` | always ok via npx | no action |
| `cli-version-current` | continue | run `npx clear-npx-cache && npx -y summer-engine@latest doctor --json` (forces a fresh resolve) |
| `skills-version-stale` | run Step 1 anyway (idempotent) | run Step 1 (`--force` is already in the command) |
| `login` | skip Step 3 | building needs no login: run Step 3 only for cloud work (assets, publishing) or when a tool answers `not_signed_in` |
| `store-access` | continue | only for publishing: surface the `message` (it carries the store's own reason); signing in again does not fix a refusal the store gives a valid sign-in |
| `engine-install` | skip Step 2 | Step 5 (`summer dev`) installs it |
| `local-api` | skip Step 5b wait-loop | expected before Step 5; `summer dev` waits for it |
| `project-memory` | continue | if a project is open, use the `brainstorm-game` skill before building |
| `mcp-boot` | continue | the MCP server failed to start locally — surface the `message` to the user |
| `mcp-tools-list` | continue | the MCP server started but listed no tools — surface the `message`; usually a stale npx cache (`npx clear-npx-cache`) |

**On version drift:** if either `cli-version-current` or `skills-version-stale` needs attention, refresh before proceeding. Tell the user once: "There's a newer Summer (X.Y.Z to A.B.C); updating before we start." Then run the command in that check's `details.recommendedAction` (a fresh `npx clear-npx-cache && npx -y summer-engine@latest ...`) and re-run doctor. Don't ask the user to choose; they paste "install" and want the latest.

### Step 1: Install skills + MCP config (always run it — idempotent, fast)

```bash
npx -y summer-engine@latest setup claude-code --yes --force
```

Replace `claude-code` with the user's actual agent: `claude-desktop`, `codex`, `cursor`, `windsurf`, `antigravity`, `cline`, `cline-cli`, `kilo-code`, `github-copilot`, `vscode-copilot`, `visual-studio`, `copilot-jetbrains`, `opencode`, `zed`, `kiro`, `goose`, `hermes`, `trae`, `qwen-code`, `kimi-code`, `crush`, `amp`, `factory`, `junie`, `warp`, `rovo-dev`, `qoder`, `grok-build`, `mistral-vibe`, `lm-studio`. Use `github-copilot` for Copilot CLI, `vscode-copilot` for GitHub Copilot Chat/Agent in VS Code, `visual-studio` for Copilot in Visual Studio, and `copilot-jetbrains` for Copilot in JetBrains IDEs. Legacy targets `gemini` and `roo-code` still work; for Google's agent use `antigravity`. This installs **every skill in the library** to `~/.claude/skills/<slug>/SKILL.md` (or the agent's own skill directory), writes the MCP server config, runs doctor, and prints what it installed and where. Preview skills are included and labelled; `--stable-only` skips them. `--force` wipes stale skill copies first. Don't use `--recommended` from this playbook; it installs only a subset.

**Summer Games:** for every agent whose sign-in summer.games accepts (all targets except `claude-desktop`, `visual-studio`, `qoder`, `rovo-dev`, `lm-studio` and the legacy ones), setup also adds the remote `summer-games` MCP (`https://mcp.summer.games/mcp`) and prints a `Sign in once:` line. Tell the user that line once, in plain words. Their browser opens summer.games; they sign in and choose Allow. Do not wait for it; continue the playbook. If the user already added the same URL under another name (for example `summer`), setup keeps theirs and adds no second entry.

**First-install detection:** if `~/.claude/skills/` didn't exist before this command, Claude Code wasn't watching it and won't auto-detect the new files this session. Tell the user **once**: "Skills installed - restart your agent so they load." On subsequent installs (directory already existed), skills auto-detect mid-session and no restart is needed. **You can detect first-install vs upgrade by checking if `~/.claude/skills/` existed before Step 1; record the result before running setup.**

**Do NOT run `/plugin install` or any other slash command.** An agent cannot type them; this playbook installs through the CLI. The Claude Code plugin (above) is the user's own one-step choice. If the user already installed it, skip Step 1: the plugin and `summer setup` install the same skills.

### Step 2: Install the engine app (Step 5 does it)

`summer dev` in Step 5 installs the engine when it is missing; nothing to run here. Only to install without a project:

```bash
npx -y summer-engine@latest install
```

About 660 MB from Summer's signed releases, including Git and other runtime tools. The CLI prints the size before it writes anything. Tell the user **"downloading the engine app, about 660 MB, this takes a couple minutes"** so they don't bail thinking it stalled. A failure names its reason (`download`, `checksum`, `disk_space`, `mount`, `copy`, `permission`, `app_running`, `needs_confirmation`) and one next step.

**Already installed?** `summer install` never silently replaces an engine. An equal version exits 0 as "up to date"; a different version is replaced only with `--yes` or a TTY confirmation, and the new bundle is swapped in only after it copied completely, so a failed download leaves the old engine in place.

**Linux note:** on Linux (x86_64) `summer install` places the engine binary under `~/.summer/engine/` (or symlinks a local build via `--path`). There is no desktop app bundle; the editor runs from that binary. Other architectures: point the user at https://summerengine.com/download and stop.

### Step 3: Sign in (only for cloud work)

Engine tools never need a sign-in, so do not stop the build for it. Run this when the user wants Summer's cloud (assets, plans, publishing) or a tool answers `not_signed_in`:

```bash
npx -y summer-engine@latest login
```

This opens the user's default browser for one sign-in that covers every Summer tool: first the Summer account ("Yes, Sign In"), then, in the same browser, a "Welcome to Summer CLI" page for the store, publishing and Grow tools (one Allow click; none if this machine was approved before). **Tell the user**: "Your browser is opening now. Sign in, click Yes, Sign In, then Allow on the next page, and come back to this terminal." The CLI checks the returned identity and stores the session in `~/.summer/`, which the engine shares. If the store step does not finish within 3 minutes, the account sign-in is still saved; `summer login --store` adds the store later. Don't loop.

### Step 4: Re-run doctor to confirm

```bash
npx -y summer-engine@latest doctor --json
```

`cli-version`, `mcp-boot`, and `mcp-tools-list` should now have `status: "ok"` (`login` too if you ran Step 3). `engine-install` and `local-api` may still need attention until Step 5. If a setup check still needs attention, surface the specific `message` to the user and do not loop or paper over it.

### Step 5: Install, create and open in one command

**Important:** `summer dev` works in the current working directory. **Pick a stable parent directory first**, such as the user's home or a Projects folder, and `cd` there. Don't let it land in a temp dir or wherever the agent happened to start.

```bash
cd ~/Projects   # or wherever the user keeps code
```

If the user said "let's make a game" without specifying a template, use the default (`3d-basic`: a sky, a sun with soft shadows, a ground and a hero the camera frames). Pick a sensible project name from the user's request, for example "FPS" to `my-fps-game`. Avoid spaces in the name.

```bash
npx -y summer-engine@latest dev --yes 3d-basic my-fps-game
```

`--yes` is the user's OK to install the engine when it is missing (about 660 MB): ask them first. Without it, `summer dev` installs nothing and exits with `needs_confirmation` and the question to ask. It installs the engine if it is missing, creates the project (a folder that already holds `project.godot` is just opened), launches the editor in the background and waits up to 3 minutes for its local API, printing progress every 10 seconds. It ends with one `Connected:` line. Give the shell call a long timeout (10 minutes) the first time: the download comes first. `summer dev .` uses the current folder when it is empty.

### Step 5b: Wait for the engine to be reachable (only if `summer dev` said it is still starting)

A first open imports every asset and can outlast the wait. The MCP also opens the project by itself when a tool needs it. To wait from the shell:

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

Now you have skills + MCP. **Don't jump into `summer create` content from a vague prompt**. Plan the task first: `summer_call` with `{"op": "docs.plan", "input": {"goal": "<the user's goal>"}}` (from a shell: `summer plan <goal>`), then invoke the recommended skill. For vague "make a game" requests, that should usually be the `brainstorm-game` skill (installed skills are invoked by their bare slug — there is no `summer:` prefix). It scopes mechanics, art direction, and the V1 cut list, and writes the result to `.summer/GameSoul.md`. Every other Summer skill reads from that file.

Project memory lives in `.summer/` as readable Markdown. Use `.summer/memory/` for locked facts that should not drift across sessions, such as character voice IDs, world canon, and provider bindings. Users can inspect it with `summer memory`; agents should read relevant memory surfaced by `summer_get_project_context` before changing creative/audio/dialogue/level/character work.

Only skip brainstorm if the user explicitly said "skip brainstorm" or "just build the X already." After brainstorm, the appropriate build skills (`fps-controller`, `design-mechanic`, `design-level`, `make-game`, etc.) auto-trigger from natural language.

### Anti-patterns (do NOT do these)

- **Don't run `npm install -g summer-engine`.** Use `npx -y summer-engine@latest ...` instead. `-g` requires `sudo` on most Mac/Linux setups, so the user will get permission errors and you'll get stuck. `npx` works without root and the MCP config we ship already points at `npx summer-engine mcp`.
- **Don't install Node.js without asking, and don't use anything but winget for it.** On Windows, Step -1 installs Node LTS with winget after the user says yes. On macOS/Linux, point them at https://nodejs.org and stop.
- **Don't run plain `npx` in Windows PowerShell, and don't change the execution policy or Defender to make it work.** Use `npx.cmd`.
- **Don't ask the user "do you want the engine too?" or "do you also want the CLI?"** This playbook installs all of it. The one exception is an assets-only request (see **Assets only** at the top of this playbook).
- **Don't double-download.** Always run `npx -y summer-engine@latest doctor --json` first; `summer dev` skips the engine download when one is installed. Step 1 (`setup`) is the exception: run it every time — it is idempotent, and doctor's top-level `ok` cannot tell you whether skills or the MCP config are installed.
- **Don't run `summer install` or `summer login` in the background.** They print user-facing output (engine download progress, browser-opening notice). Run them in the foreground so the user sees what's happening.
- **Don't skip the `--json` flag on `summer doctor`.** Text output is fragile to parse and changes per version.
- **Don't skip the `-y` flag on `npx`.** Without it, npx prompts "ok to install summer-engine?" interactively and the call hangs in a non-interactive shell.
- **Don't drop `@latest` from the npx commands.** `npx -y summer-engine` (no version pin) serves whatever's in npx's local cache, which can be a stale older version. The `@latest` tag forces npm to re-resolve from the registry. If a user reports "unknown command 'doctor'" or sees a much smaller skill list than expected, they got cache-served. Tell them to run `npx clear-npx-cache` then retry with `@latest`.
- **Don't stop the build for a sign-in.** Engine tools work signed out; sign in only when a cloud operation answers `not_signed_in`.
- **Don't `summer dev` or `summer create` without `cd`'ing to a stable parent directory first.** They write into CWD; agents that start in a temp dir will leave the project there.
- **Don't loop `summer login` if it times out.** It waits up to 15 minutes for the account sign-in. Re-run it once and tell the user to finish "Yes, Sign In" in the browser tab it opens; loop forever and the user is stuck.
- **Don't jump straight into `summer create` from a vague prompt.** Invoke the `brainstorm-game` skill first (Step 6). The build skills assume `.summer/GameSoul.md` exists.

**Using a different agent?** Use its id from Step 1 (aliases such as `devin`, `agy` and `droid` also work; see the [CLI reference](#cli-reference)). Skill folders vary per agent; the CLI handles the difference, and [`integrations/README.md`](integrations/README.md) documents exactly what gets written where for every client. After install, **Cline users should restart VS Code** so the extension reloads its MCP config. **VS Code Copilot users** should start the `summer-engine` MCP server from Agent mode if VS Code does not autostart it.

If the user wants `summer` on their `PATH` for everyday terminal use, a global npm install works too. The agent flow doesn't need it.

</details>

---

## The lifecycle: create → test → publish → grow

| Stage | Status | What it means today |
|---|---|---|
| **Create** | Available | Scaffold from a pinned template, build scenes and scripts through MCP, generate 2D/3D/audio/video assets, guided by the library. |
| **Test** | Available | The verification ladder: compile checks, screenshots, live play with debugger reads, and input-driven probes (`RunVerification`) that press real keys and assert on real frames. |
| **Publish** | Available | `summer_export_game` builds the store file with the installed engine; `store.upload_file` uploads it after you confirm the exact game, file and version. `store.update_listing`, `store.set_art` and `store.set_trailer` write the store page (text, tags, long description, support contact, release date, art, trailer); `store.preview_link` makes a private preview link; `store.publish` publishes the store page, live as soon as the automatic checks pass; `store.status` shows whether the game is live, its releases, and any note from Summer's review afterwards; `store.release` ships a checked build. With the Publish switch off, the agent asks you first. |
| **Grow** | Available | `analytics.overview` and `analytics.summary` read store page views, launches, play sessions, play time and your game's own events (see the `summer-analytics` skill). `pricing.*` sets prices, country prices and sales; `experiments.*` runs store page A/B tests; `games.members` and the member operations manage who works on a game; `marketing.*` applies for Summer's growth services. |

These are operations on the hosted Summer server; the local server runs them too after `summer login`.

## How agents call Summer

Every capability is an operation named `<area>.<action>`: `assets.generate_image`, `store.publish`, `pricing.set_base`.

- **Direct tools** cover the common jobs: `summer_` plus the operation name, with `_` for `.` (`games.list` is `summer_games_list`). Engine tools keep their 3.x names (`summer_add_node`, `summer_run_script`, `summer_play`, `summer_screenshot`), and makers keep `summer_tool_<slug>`.
- **Everything else**: `summer_search` finds the operation for a job you describe in words and returns its exact input. `summer_call` runs it: `{op, input, dryRun?, idempotencyKey?}`.
- **One answer shape**: `done` with a `result`, `running` with a job (`summer_jobs_wait` waits up to 50 seconds per call), `needs_approval` with a link for you, `dry_run` with a preview, or an error with a `code`, a `message` and exactly one `next` step.
- **Safe to try**: every change takes `dryRun: true` (it changes nothing and spends nothing; a spend shows your own credit estimate) and an `idempotencyKey`, so a retry never runs twice.
- **Error codes**: `invalid_input`, `not_signed_in`, `forbidden`, `not_found`, `conflict`, `idempotency_conflict`, `in_progress`, `rate_limited`, `no_credits`, `over_limit`, `engine_not_running`, `engine_lacks_op`, `unsupported`, `not_in_profile`, `moved`, `outcome_unknown`, `unavailable`, `internal`.
- **3.x names keep working** for all of 4.x: `summer_call` accepts them on every server, `summer mcp --toolsets legacy` lists them on the local server, and the local server lists them by itself while your installed skills are older than 4.0. Its first start after an upgrade refreshes the Summer skills you installed, so after an upgrade the legacy list stays off unless you ask for it. The map from old names to operations is [`registry/operations/legacy-names.json`](registry/operations/legacy-names.json).

The same operations run from a shell: `summer <area> <action> --<field> <value>` (for example `summer assets generate-image --prompt "a cozy pixel-art tavern" --aspect-ratio 16:9`), with `--dry-run`, `--wait` (follows a job or an approval to the end) and `--json` (prints the answer only; exit code 0 for any `ok` answer, 1 for an error). `summer whoami` shows who is signed in. `summer ops search <words>` and `summer ops describe <op>` find an operation and its input. Every command that reads something takes `--json`.

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
├── commands/          # the shipped slash commands (/summer, /gameskill, the plugin's /summer:start)
├── hooks/             # lifecycle hooks: session-start orientation, opt-in pre-commit doctor
├── assets/            # files the tools ship with: offline API docs, engine-side probe and audit scripts
├── scripts/           # generate-registry (the compiler), validate-library (schema + capability lint)
├── tests/             # v2 prose behaviour specs (the code tests sit next to the code in src/)
├── docs/              # development guide, migration notes, design contract
└── .claude-plugin/ …  # plugin manifests for Claude Code, Codex, Cursor and Factory (generated)
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

Agents don't browse folders; they search the compiled index (`registry/generated/index.json`) through `summer_docs_search` (or `summer tool search-library`) by summary, use-cases, and facets, then load the hit with `summer_docs_read`. IDs are permanent, so feedback and evidence follow an entry across any reorganization.

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

- Agents can report how an entry worked (`summer_call` with `docs.feedback`): worked / worked with fixes / wrong / outdated / incomplete / did not apply / misrouted. What is sent, in full: the entry ids, one outcome word each, an optional note and deviation (280 characters max, about the entry), the engine version, the agent's self-reported model id, this CLI's version, the host app name/version, a random per-process session id, and — only when logged out — a random install uuid (when logged in, the account token is sent instead). **The schema cannot carry your code, files, or chat.** The very first call on a machine sends nothing and returns a notice; `SUMMER_NO_TELEMETRY=1` or `DO_NOT_TRACK=1` turns it off entirely.
- Today those reports land in a write-only mailbox that maintainers read. Only verified outcomes count; popularity never ranks an entry.

## Telemetry

Summer sends a few usage lines so we can see which tools and commands work, in which agent apps. **It never sends prompts, code, file contents, file paths, project names, tool arguments or results, or anything you typed.** Turn all of it off with `SUMMER_NO_TELEMETRY=1` or `DO_NOT_TRACK=1`.

The first `summer` command on a computer (any command, `summer mcp` too) prints this notice once, to stderr:

```
Summer collects usage data to improve its tools: which commands and tools run, whether they worked, and which agent app ran them.
No prompts, code, file names or project names. Opt out: SUMMER_NO_TELEMETRY=1
Details: https://github.com/summerengine/summer#telemetry
```

Every line goes to `/api/mcp/log-local-call` on the Summer server. Every request also names this package's version in a header.

| Line | When | Fields |
|---|---|---|
| First run | Once per computer, with the notice. Not in CI. The only line sent without a sign-in. | `installId` (a random id in `~/.summer/feedback-install-id`, the same one the library feedback uses; no hardware, user or project identity), `command` (the command name, e.g. `dev`), `mcpClient` (the agent app, e.g. `claude-code`), `os` (`darwin`, `win32` or `linux`) |
| Session | Signed in: the first tool call of each MCP server | `mcpClient` (the host app name from the MCP handshake), `installId` (so the first-run line joins your account) |
| Tool call | Signed in: each local MCP tool call | `tool`, `op` (the Summer operation), `ok`, `error` (a short code such as `engine_not_running`, never the message), `durationMs`, `mcpClient`, `surfaceVersion`, `profile`, and the fields below when they apply |
| Command | Signed in (a saved sign-in or `SUMMER_TOKEN`): each `summer` command that runs on your computer | `tool` (the command or operation name), `op`, `ok`, `error`, `durationMs`, `mcpClient` (from the environment), and the fields below when they apply; after `summer login` also `installId` |

Fields a tool call or command adds when they apply:

| Field | Example | What it is |
|---|---|---|
| `projectIdHash` | `9f2c…e41a` (64 hex characters) | The id Summer Engine already uses to route requests to a project: the sha256 of a random id the engine stores in the project (`.summer/local/.project_id`). Not the name or path. |
| `templateId` | `2d-platformer` | The library template the project started from (`.summer/project.json`). Only ids from the shipped catalog. |
| `templateTags` | `["2d", "platformer"]` | `summer create` only: that template's library domains. |
| `instanceCount` | `3` | `engine.play` only: how many game clients the play started (1 for a normal run; Local Play players plus spectators). |
| `engineState` | `{"desktopInstalled": true, "engineRunning": false, "projectOpen": false, "signedIn": true}` | `engine_not_running` failures only: four yes/no answers from local files. |

The [library feedback mailbox](#library-feedback) is separate and described above. Requests to Summer's servers (generation, assets, the store) also name your agent app, its version and the tool in headers; the same two variables remove them.

## What gets downloaded

We tell you before we touch your disk.

| What | Size | When | Source |
|---|---|---|---|
| `summer-engine` npm package (CLI + MCP + library) | ~2 MB download, ~6 MB unpacked | first `npx -y summer-engine@latest ...` call | [npmjs.com/package/summer-engine](https://www.npmjs.com/package/summer-engine) |
| Summer Engine app | about 660 MB download (engine + bundled Git/runtime tools) | `npx -y summer-engine@latest dev` or `install`, when missing | Summer's signed releases |
| Auth token | ~1 KB | `npx -y summer-engine@latest login` | Browser to `~/.summer/auth-token` |
| Store sign-in | ~2 KB | `summer login` (right after the account sign-in), or `summer login --store` alone | Browser OAuth (PKCE, loopback port 47615-47617) to `~/.summer/oauth-token` with its refresh token, plus this machine's public client id in `~/.summer/oauth-client`; never replaces the auth token |
| Skill files | small, bundled | in the npm package | no extra network call |
| Generated assets (3D / image / audio / video) | varies | only on explicit `assets.generate_*` calls | Summer Engine Studio |
| URL imports | varies | only on explicit `summer_import_from_url` calls | the URL you provide |

Not downloaded, not collected:
- No telemetry beyond what [Telemetry](#telemetry) lists. Diagnostics stay local.
- No silent engine updates. `summer install` checks the installed version and asks before replacing it (or needs `--yes`); nothing updates the engine behind your back.
- No model weights. AI generation runs in Summer Engine Studio (cloud), never on your machine.

## What's open and what's not

| Thing | License | Source |
|---|---|---|
| **Summer** (this repo: CLI, MCP server, library, integrations) | **MIT** | [summerengine/summer](https://github.com/summerengine/summer) |
| **Summer Engine app** (the desktop editor and runtime) | free to download, closed source for now | [summerengine.com/download](https://summerengine.com/download) |
| **Hosted Summer services** (store, publishing, Grow, multiplayer hosting, AI generation) | run under your Summer account | [summerengine.com/pricing](https://summerengine.com/pricing) |

Publishing to summer.games, multiplayer hosting, matchmaking and Grow are live.

## CLI reference

| Command | What it does |
|---|---|
| `summer dev [template] [dir]` | One step from nothing to an editor your agent can drive: installs Summer Engine if it is missing, creates the project (`3d-basic` unless you name a template; `.` or no folder uses the current one when it is empty), opens it and waits until it answers. A folder with `project.godot` is just opened. |
| `summer install [--yes]` | Download Summer Engine. Prints URL and size first; never replaces an installed engine without confirmation. |
| `summer login` | One browser sign-in for every Summer tool: your Summer account, then the store, publishing and Grow operations in the same browser. `--no-store` skips the store step. |
| `summer login --store` | Only the store sign-in (`store.upload_file` and the cloud operations: plans, the store, publishing and Grow). |
| `summer whoami` | The signed-in account, its plan and credits. |
| `summer <area> <action> [--<field> <value> …] [--input '<json>'] [--dry-run] [--idempotency-key <k>] [--wait] [--json]` | Run any operation from the shell, for example `summer assets generate-image --prompt "…"` or `summer store status --game-id <id>`. |
| `summer ops search <words…>` / `summer ops describe <op>` | Find the operation for a job, or print one operation's input, effect and approval. Works signed out: a cloud operation shows `(needs sign-in)`. |
| `summer logout` | Clear auth tokens. |
| `summer config [get\|set\|unset]` | Read or update the shared non-secret `~/.summer/config.json`. |
| `summer status [--json]` | Engine state, port, auth. |
| `summer doctor` | Diagnose Node, login, engine, project memory, MCP. |
| `summer plan <goal>` | Route a game-building goal into skills, MCP tools, gates, and verification. |
| `summer memory` | Inspect project memory in `.summer`. |
| `summer memory show <file>` | Print a project memory Markdown file. |
| `summer run [path] [--background\|--focus] [--bin <executable>]` | Launch the engine. Agents (no TTY) launch in the background by default so the window never steals focus; `--focus` brings it to the front. `--bin` (env `SUMMER_BIN`) launches a build that is not installed. |
| `summer open <path \| target> [--print] [--list]` | A project directory opens in the running engine. Anything else is a navigation target — `billing`, `my-games`, `mcp-guide`, `scene`, `inspector`, an intent phrase, a `res://` path — opened in the browser or sent to the editor; `--print` resolves without opening. |
| `summer create <template> [name]` | Scaffold a project from a pinned template, with an AGENTS.md for your agent (and a CLAUDE.md that imports it). |
| `summer list templates` / `projects` | Browse. `--json` for scripts. |
| `summer events [--follow] [--kinds <csv>] [--since <seq>] [--json]` | The engine events channel (engine 0.5.66+): newest events, or stream them live. |
| `summer debug [issue…]` | Support-ready Markdown debug report. |
| `summer skills list` | Show all skills (`--by-domain` groups them; the same grouping is in [`library/skills/README.md`](library/skills/README.md)). |
| `summer skills install <name>` | Install one. |
| `summer skills install --all --agent <agent>` / `--recommended` / `--assets` [`--stable-only`] | Install every skill (preview included and labelled), only the recommended subset, or only the asset skills; `--stable-only` skips preview skills. |
| `summer tool <name> --args '<json>'` | Run any Summer tool from the shell — the same implementation the MCP tool uses. `summer tool --list` prints them all. |
| `summer mcp [--project <path> \| --instance <id>] [--profile <p>] [--toolsets <list>] [--surface v4\|v3]` | Start MCP; normally auto-binds from the agent's project directory. `--surface` (env `SUMMER_SURFACE`): `v4` (the default: engine tools, `summer_docs_search`, `summer_docs_read`, `summer_search` and `summer_call`) or `v3` (the 3.x tools). `--profile` (env `SUMMER_PROFILE`): `full` (every tool, the default), `engine` (engine, generation and store tools; fits the per-request tool cap of clients such as VS Code Copilot, which is 128), `assets` (generation and asset tools, no engine tools). `--toolsets` (env `SUMMER_TOOLSETS`) adds toolsets by name: `core`, `assets`, `tools`, `engine`, `ui`, `ship`, `uploads`, `apps`, `board`, `grow`, `studio`, `cloud`, `projects` (create and open a project on this computer with no shell; in `full`), `other`, or `all`. `--toolsets legacy` also lists every 3.x tool name. |
| `summer mcp setup <agent>` | Deprecated alias of `summer setup <agent>`. |
| `summer setup <agent> [--yes] [--force] [--recommended] [--stable-only] [--no-games] [--profile <p>] [--assets-only] [--cli]` | One shot: MCP config + all skills, preview included (`--recommended` for the subset, `--stable-only` to skip preview) + doctor. Idempotent. `--cli` (or `--no-mcp`, 4.2.0 or newer) installs the skills and no MCP server: the agent runs `summer` commands in its shell. Inside a Summer project it also adds the Summer instructions to the project's AGENTS.md and CLAUDE.md; `--no-project-files` skips that. `--profile` writes a tool profile into the agent's MCP entry (`SUMMER_PROFILE`); `vscode-copilot` gets `engine` unless you pass `--profile full`, every other agent gets every tool. `--assets-only` is the assets path: the `assets` profile, only the asset skills, no Summer Games. For most agents (not Claude Desktop, Visual Studio, Qoder, Rovo Dev, LM Studio or the legacy targets) it also adds `summer-games` (`https://mcp.summer.games/mcp`: friends, parties and messages as you) unless the same URL is already listed; you sign in once through summer.games. `--no-games` skips it. |

Agents: `claude-code`, `claude-desktop`, `codex`, `cursor`, `windsurf`, `antigravity`, `cline`, `cline-cli`, `kilo-code`, `github-copilot`, `vscode-copilot`, `visual-studio`, `copilot-jetbrains`, `opencode`, `zed`, `kiro`, `goose`, `hermes`, `trae`, `qwen-code`, `kimi-code`, `crush`, `amp`, `factory`, `junie`, `warp`, `rovo-dev`, `qoder`, `grok-build`, `mistral-vibe`, `lm-studio`. Legacy (still accepted, warn on use): `gemini`, `roo-code`. Aliases: `devin`/`devin-desktop` → `windsurf`, `agy` → `antigravity`, `droid` → `factory`, `copilot` → `github-copilot`, `vscode` → `vscode-copilot`, `kilo` → `kilo-code`, `qwen` → `qwen-code`, `kimi` → `kimi-code`. Scopes: `--scope user` (default), `--scope project`.

## Contributing

The library grows by PR, and CI holds the line:

1. **Report a bad entry.** Open an issue quoting the prompt and the response — or, if you're an agent, file `docs.feedback` through `summer_call` after a verified failure.
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
- [Support](https://summer.games/support) · [Privacy policy](https://www.summerengine.com/privacy) · [Terms](https://www.summerengine.com/terms)
