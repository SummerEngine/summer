# Summer

<div align="center">

<img src="docs/brand/sun.png" alt="" width="128">

### The open-source game-development system for AI agents.

**A verified game-dev library · live engine tools · project memory. One npm package.**

[![npm](https://img.shields.io/npm/v/summer-engine?label=npm&color=f7b731)](https://www.npmjs.com/package/summer-engine)
[![downloads](https://img.shields.io/npm/dm/summer-engine?label=installs&color=f7b731)](https://www.npmjs.com/package/summer-engine)
[![license](https://img.shields.io/badge/license-MIT-1a1a1a)](LICENSE)

[**Website**](https://www.summerengine.com) · [**Docs**](https://docs.summerengine.com) · [**CLI setup**](https://www.summerengine.com/cli) · [**MCP setup**](https://www.summerengine.com/mcp)

</div>

---

This repo is `summerengine/summer` — the front door to Summer. (It is being renamed from `SummerEngine/summer-engine-agent`; redirects keep every old link working.)

Your agent gets a real engine, not a chat box. With Summer installed, any AI coding agent can:

- **Build real games** in Summer Engine: scenes, scripts, physics, UI — through live MCP tools, not text about code.
- **Draw on a verified library**: skills (how to do something well), examples (proven working instances), templates (pinned project foundations), collections (curated assets), references (facts) — all searchable through one generated index.
- **Verify its own work**: play the game, take screenshots, read the debugger, run input-driven probes.
- **Resume any project**: `.summer/` project memory means a fresh agent picks up where the last one stopped, no conversation history needed.

You stay in control of every change and release. Summer never publishes, installs, or spends without your explicit confirmation, and library entries are structurally prevented (by a capability lint in CI) from instructing agents to touch the network, credentials, or package managers.

## Get started: one prompt

Open your AI agent (Claude Code, Cursor, Codex, Copilot, Devin Desktop, etc.) and paste:

> Install Summer Engine and let's make a game. Read github.com/summerengine/summer, check what I already have installed, install whatever is missing, log me in, and scaffold a starter project so we can start building.

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

You are an AI coding agent. The user told you to install Summer Engine. **Run this playbook via your shell**: Bash on macOS/Linux or PowerShell on Windows. `npx -y` is shell-agnostic and works identically in both. Detection first, then only install what's missing. (Once installed, your working guide is [`AGENTS.md`](AGENTS.md).)

### Step -1: Verify Node.js is on PATH

```bash
node --version
```

If this command does not print Node.js 20 or newer, **stop**. Tell the user: "Summer needs Node.js 20+. Install from https://nodejs.org and re-run the prompt." Do NOT try to install Node yourself.

### Step 0: Pre-detection (no commits to disk, just check state)

```bash
npx -y summer-engine@latest doctor --json
```

The first invocation downloads the npm package transparently to npx's cache (~3 MB, ~5 sec). Subsequent calls are fast. The `-y` flag auto-confirms npx's "ok to install summer-engine?" prompt so the call doesn't hang in a non-interactive shell.

Read the JSON output. **Top-level `ok: true` means "no check failed" — it does NOT mean Summer is installed.** A machine with no skills, no MCP config, and no login can report `ok: true` (those checks warn, they do not fail). So never skip Step 1 on `ok`: it is idempotent and fast. Use the `checks` array (each entry: `id`, `label`, `status` of `ok` / `warning` / `fail`, `message`, optional `details`) only to decide whether the expensive steps — engine download (Step 2) and browser login (Step 3) — are needed.

The check ids are `node-version`, `cli-version`, `cli-version-current`, `skills-version-stale`, `login`, `engine-install`, `local-api`, `project-memory`, `mcp-boot`, and `mcp-tools-list`. For any check whose `status` is not `ok`, run the action in the table below, then re-run doctor.

| Check id | If `status` is `ok` | Action when attention is needed |
|---|---|---|
| `node-version` | continue | Step -1 already covered this |
| `cli-version` | always ok via npx | no action |
| `cli-version-current` | continue | run `npx clear-npx-cache && npx -y summer-engine@latest doctor --json` (forces a fresh resolve) |
| `skills-version-stale` | run Step 1 anyway (idempotent) | run Step 1 (`--force` is already in the command) |
| `login` | skip Step 3 | run Step 3 |
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

Replace `claude-code` with the user's actual agent: `codex`, `cursor`, `windsurf`, `cline`, `roo-code`, `kilo-code`, `gemini`, `github-copilot`, `vscode-copilot`, `opencode`, or `lm-studio`. Use `github-copilot` for Copilot CLI and `vscode-copilot` for GitHub Copilot Chat/Agent in VS Code. Factory Droid uses the plugin marketplace path (see [`integrations/README.md`](integrations/README.md)). This installs **every skill in the library** (`status: preview` skills included — they are labelled as preview in their guidance, and `--stable-only` skips them) to `~/.claude/skills/<slug>/SKILL.md` (or the agent's equivalent user-skill directory) AND writes the MCP server config so the agent can talk to the engine, then runs doctor and prints what it installed and where. The `--force` flag wipes any stale skill content first, so re-runs always end up with the latest copy. `--recommended` installs only the recommended subset — don't use it from this playbook.

**First-install detection:** if `~/.claude/skills/` didn't exist before this command, Claude Code wasn't watching it and won't auto-detect the new files this session. Tell the user **once**: "Skills installed - restart your agent so they load." On subsequent installs (directory already existed), skills auto-detect mid-session and no restart is needed. **You can detect first-install vs upgrade by checking if `~/.claude/skills/` existed before Step 1; record the result before running setup.**

**Do NOT run `/plugin install` or any slash command.** The CLI path is the canonical install. The marketplace path is an alternative for users who specifically prefer the official plugin TUI; we don't route agents there.

### Step 2: Install the engine app (only if `engine-install` needs attention)

```bash
npx -y summer-engine@latest install
```

~1 GB. Downloads from Summer's signed releases. The bundle includes the engine binary plus Git and a handful of other runtime tools so users who don't already have them aren't blocked. The CLI prints the URL and size before touching disk. Tell the user **"downloading the engine app, ~1 GB, this takes a couple minutes"** so they don't bail thinking it stalled.

**Already installed?** `summer install` never silently replaces an engine. An equal version exits 0 as "up to date"; a different version is replaced only with `--yes` or a TTY confirmation, and the new bundle is swapped in only after it copied completely, so a failed download leaves the old engine in place.

**Linux note:** on Linux (x86_64) `summer install` places the engine binary under `~/.summer/engine/` (or symlinks a local build via `--path`). There is no desktop app bundle; the editor runs from that binary. Other architectures: point the user at https://summerengine.com/download and stop.

### Step 3: Sign in (only if `login` needs attention)

```bash
npx -y summer-engine@latest login
```

This opens the user's default browser. **Tell the user**: "Your browser is opening now. Click sign-in once and come back to this terminal." The CLI waits up to 120 seconds for the auth callback, validates that the returned identity matches the CLI token, writes the core-compatible session to the secured `~/.summer/` store, and returns. **If the user takes longer than 120 seconds, re-run `npx -y summer-engine@latest login` and tell them to come back to the terminal quickly.** Don't loop indefinitely. The same `auth-token` and `user.json` filenames remain shared with the engine; they sign in once, both surfaces accept it.

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

If the engine takes longer than 20s to boot (cold start, slow disk, etc.), `summer run` returns successfully but the local API isn't up yet. MCP tools may not connect until the local API is ready. Wait for it:

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
- **Don't try to install Node.js for the user.** If `node --version` is unavailable, point them at https://nodejs.org and stop.
- **Don't ask the user "do you want the engine too?" or "do you also want the CLI?"** There is one product, three pieces, all installed by this playbook.
- **Don't double-download.** Always run `npx -y summer-engine@latest doctor --json` first and skip the engine download and the browser login when their checks are `status: "ok"`. Step 1 (`setup`) is the exception: run it every time — it is idempotent, and doctor's top-level `ok` cannot tell you whether skills or the MCP config are installed.
- **Don't tell the user to type `/plugin marketplace add` or `/plugin install`.** The CLI path is the canonical install. Those slash commands are an alternative for the marketplace TUI, not the primary flow.
- **Don't run `summer install` or `summer login` in the background.** They print user-facing output (engine download progress, browser-opening notice). Run them in the foreground so the user sees what's happening.
- **Don't skip the `--json` flag on `summer doctor`.** Text output is fragile to parse and changes per version.
- **Don't skip the `-y` flag on `npx`.** Without it, npx prompts "ok to install summer-engine?" interactively and the call hangs in a non-interactive shell.
- **Don't drop `@latest` from the npx commands.** `npx -y summer-engine` (no version pin) serves whatever's in npx's local cache, which can be a stale older version. The `@latest` tag forces npm to re-resolve from the registry. If a user reports "unknown command 'doctor'" or sees a much smaller skill list than expected, they got cache-served. Tell them to run `npx clear-npx-cache` then retry with `@latest`.
- **Don't call MCP tools (`summer_get_scene_tree`, etc.) until `local-api` is `ok`.** The engine takes a few seconds to boot after `summer run`. Use Step 5b's wait-loop.
- **Don't `summer create` without `cd`'ing to a stable parent directory first.** It writes into CWD; agents that start in a temp dir will leave the project there.
- **Don't loop `summer login` if it times out at 120s.** Re-run it once and tell the user to be quicker; loop forever and the user is stuck.
- **Don't jump straight into `summer create` from a vague prompt.** Invoke the `brainstorm-game` skill first (Step 6). The build skills assume `.summer/GameSoul.md` exists.

**Using a different agent?** Replace `claude-code` with any supported agent in Step 1: `codex`, `cursor`, `windsurf`, `cline`, `roo-code`, `kilo-code`, `gemini`, `github-copilot`, `vscode-copilot`, `opencode`, or `lm-studio`. (`devin` is also accepted as an alias for `windsurf`.) Skill targets vary per agent; the CLI handles the difference, and [`integrations/README.md`](integrations/README.md) documents exactly what gets written where for every client. After install, **Cline and Roo Code users should restart VS Code** so the extension reloads its MCP config. **Gemini users** may need to run `gemini extensions enable summer-engine` after the first install. **VS Code Copilot users** should start the `summer-engine` MCP server from Agent mode if VS Code does not autostart it.

**Power-user note:** if the user specifically wants `summer` on their `PATH` for everyday terminal use outside the AI agent, a global npm install is still possible. The agent flow doesn't need it.

---

## The lifecycle: create → test → publish → grow

| Stage | Status | What it means today |
|---|---|---|
| **Create** | Available | Scaffold from a pinned template, build scenes and scripts through MCP, generate 2D/3D/audio/video assets, guided by the library. |
| **Test** | Available | The verification ladder: compile checks, screenshots, live play with debugger reads, and input-driven probes (`RunVerification`) that press real keys and assert on real frames. |
| **Publish** | Available (creator CLI) | `summer publish` streams an already-exported Summer `.pck` to the Summer Platform for review — explicit, confirmed, immutable releases with real history (`summer releases`). Nothing is ever submitted silently. |
| **Grow** | Direction | Store distribution, analytics, retention and live-ops tooling arrive as new library entries (the structure is built for it — lifecycle is metadata, not architecture). Not promised by this package today. |

## What's in this repo

```
summer/
├── README.md          # you are here — humans + the one-paste install prompt
├── AGENTS.md          # the agent guide: trust, the library, navigation, engine rules
├── src/               # the Summer software (TypeScript)
│   ├── core/          #   shared implementations (capabilities used by both CLI and MCP)
│   ├── cli/           #   the `summer` command surface
│   ├── mcp/           #   the MCP server and tool adapters
│   ├── project-memory/#   .summer/ read/write
│   └── installer/     #   agent detection and config writing for every supported client
├── library/           # the Library — skills, templates, references (examples, tools, collections as they land)
├── registry/          # schemas + generated/ (the compiled index everything reads; never hand-edited)
├── evals/             # evidence the library works: routing, skills, examples, templates, tools, end-to-end
├── integrations/      # one folder per supported agent — the honest map of who gets what
├── scripts/           # generate-registry (the compiler), validate-library (schema + capability lint)
└── docs/              # development guide, migration notes, design contract
```

One rule ties it together: **every entry is described once** (a `resource.yaml` in `library/`), and the registry compiler generates everything else — the searchable index, every agent plugin manifest, the skill installer data, counts, and legacy aliases. CI fails on any drift. See [`docs/design/CONTRACT.md`](docs/design/CONTRACT.md).

## The library

Six kinds of entry, all searchable through the same generated index:

- **Skills** — how to do something well (FPS controllers, scene composition, debugging discipline, VFX recipes, audio direction…). Open [Agent Skills](https://agentskills.io) format, so any conformant tool picks them up.
- **Examples** — proven working instances with required evidence (screenshots, verification receipts) — an example that can't show it works doesn't ship.
- **Templates** — complete project foundations (platformers, FPS, racing, roguelikes, multiplayer starters…), each pinned to an exact commit with a verified tree digest. `summer create <slug>` fetches exactly that commit, recomputes the digest and refuses on mismatch, then records the pin into the project's `.summer/project.json` — never whatever a branch happens to contain today. Two small templates (`3d-basic`, `empty`) are built in and generate offline. Browse with `summer list templates`; pinning rules and the digest formula in [`library/templates/README.md`](library/templates/README.md).
- **Collections** — curated, compatible creative materials: asset sets with style rules and presets. **Preview** — the catalog system lives platform-side today and is being unified into the library format.
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
 Summer Platform (publishing) · your players
```

Summer is agent-neutral by construction: `integrations/` adapts one generated system to each agent; no agent is the foundation. Currently 13 clients are supported end-to-end — the full map of what gets installed where is [`integrations/README.md`](integrations/README.md).

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

## The self-improving library

The long-term bet: the best library is the one that learns from real usage. v1 of that loop is deliberately small and honest:

- Agents can report how an entry worked (`summer_library_feedback`): worked / worked with fixes / wrong / outdated / incomplete / did not apply / misrouted. What is sent, in full: the entry ids, one outcome word each, an optional note and deviation (280 characters max, about the entry), the engine version, the agent's self-reported model id, this CLI's version, the host app name/version, a random per-process session id, and — only when logged out — a random install uuid (when logged in, the account token is sent instead). **The schema cannot carry your code, files, or chat.** The very first call on a machine sends nothing and returns a notice; `SUMMER_NO_TELEMETRY=1` or `DO_NOT_TRACK=1` turns it off entirely.
- Today those reports land in a write-only mailbox that maintainers read. Automated triage, ranking, and repair are specced ([`docs/design/SELF_IMPROVING_LIBRARY.md`](docs/design/SELF_IMPROVING_LIBRARY.md)) and gated behind written promotion criteria — verified outcomes only, popularity never ranks.

## What gets downloaded

We tell you before we touch your disk.

| What | Size | When | Source |
|---|---|---|---|
| `summer-engine` npm package (CLI + MCP + library) | ~3 MB | first `npx -y summer-engine@latest ...` call | [npmjs.com/package/summer-engine](https://www.npmjs.com/package/summer-engine) |
| Summer Engine app | ~1 GB (engine + bundled Git/runtime tools) | `npx -y summer-engine@latest install` | Summer's signed releases |
| Auth token | ~1 KB | `npx -y summer-engine@latest login` | Browser to `~/.summer/auth-token` |
| Creator token | ~50 bytes | only when you run `summer login --creator` and mint one | One-time browser value to `~/.summer/creator-token`; never replaces the auth token |
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
| **Summer** (this repo: CLI, MCP server, library, integrations) | **MIT** | [summerengine/summer](https://github.com/SummerEngine/summer-engine-agent) |
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
| `summer login --creator` | Open the Summer Platform token settings and securely connect a separate publish-scoped creator token. |
| `summer logout` | Clear auth tokens. |
| `summer config [get\|set\|unset]` | Read or update the shared non-secret `~/.summer/config.json`. |
| `summer publish [project] --artifact <game.pck> --version <value> [--confirm]` | Compute and show the exact immutable target; after approval, stream it through prepare → write-once PUT → finalize. |
| `summer releases [--cursor <value>]` | List real creator-owned release history. |
| `summer status` | Engine state, port, auth. |
| `summer doctor` | Diagnose Node, login, engine, project memory, MCP. |
| `summer plan <goal>` | Route a game-building goal into skills, MCP tools, gates, and verification. |
| `summer memory` | Inspect project memory in `.summer`. |
| `summer memory show <file>` | Print a project memory Markdown file. |
| `summer run [path] [--background\|--focus]` | Launch the engine. Agents (no TTY) launch in the background by default so the window never steals focus; `--focus` brings it to the front. |
| `summer open <path>` | Open a project in a running engine. |
| `summer create <template> [name]` | Scaffold a project from a pinned template. |
| `summer list templates` / `projects` | Browse. |
| `summer skills list` | Show all skills. |
| `summer skills install <name>` | Install one. |
| `summer skills install --all --agent <agent>` / `--recommended` [`--stable-only`] | Install every skill (preview included and labelled), or only the recommended subset; `--stable-only` skips preview skills. |
| `summer tool <name> --args '<json>'` | Run any Summer tool from the shell — the same implementation the MCP tool uses. `summer tool --list` prints them all. |
| `summer mcp [--project <path> \| --instance <id>]` | Start MCP; normally auto-binds from the agent's project directory. |
| `summer mcp setup <agent>` | Deprecated alias of `summer setup <agent>`. |
| `summer setup <agent> [--yes] [--force] [--recommended] [--stable-only]` | One shot: MCP config + all skills, preview included (`--recommended` for the subset, `--stable-only` to skip preview) + doctor. Idempotent. |

Agents: `claude-code`, `codex`, `cursor`, `windsurf`, `cline`, `roo-code`, `kilo-code`, `gemini`, `github-copilot`, `vscode-copilot`, `opencode`, `lm-studio`. (`devin` and `devin-desktop` are accepted as aliases for `windsurf`.) Scopes: `--scope user` (default), `--scope project`.

## Contributing

The library grows by PR, and CI holds the line:

1. **Report a bad entry.** Open an issue quoting the prompt and the response — or, if you're an agent, file `summer_library_feedback` after a verified failure.
2. **Improve or add an entry.** Add `library/<kind>/<slug>/` with a `resource.yaml` (plus `SKILL.md` for skills). Run `npm run validate:library`, regenerate with `node scripts/generate-registry/cli.ts`, and commit both. Schema, capability lint, and registry parity are enforced in CI.

[`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md) is the contributor guide; [`docs/design/CONTRACT.md`](./docs/design/CONTRACT.md) is the rulebook.
Testing an unpublished build end to end against the real engine and a real agent: [`docs/TESTING.md`](./docs/TESTING.md).

## Docs

- [Agent guide (AGENTS.md)](AGENTS.md) — how agents use Summer, including the verification ladder
- [Development guide](docs/DEVELOPMENT.md) · [v2 → v3 migration](docs/MIGRATION-V2-V3.md)
- [Design: contract](docs/design/CONTRACT.md) · [decisions](docs/design/DECISIONS.md) · [roadmap](docs/design/ROADMAP.md)
- [Agent support map](integrations/README.md) · [Template pinning](library/templates/README.md) · [Evals](evals/README.md)
- Per-host notes: [Claude Code](docs/CLAUDE_CODE.md) · [Codex](docs/CODEX.md) · [Cursor](docs/CURSOR.md) · [OpenCode](.opencode/INSTALL.md)

## License

MIT for everything in this repo. Summer Engine itself is proprietary. See [What's open and what's not](#whats-open-and-whats-not).

## Links

- [Website](https://summerengine.com)
- [Download Summer Engine](https://summerengine.com/download)
- [Documentation](https://summerengine.com/docs)
- [Community](https://summerengine.com/community)
- [Issues](https://github.com/SummerEngine/summer-engine-agent/issues)
