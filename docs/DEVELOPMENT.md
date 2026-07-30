# Summer: Development Guide

This repo (npm: `summer-engine`, GitHub: [SummerEngine/summer-engine-agent](https://github.com/SummerEngine/summer-engine-agent)) is **MIT, open source**. Treat all commits and code comments as public; they ship to the public repo.

When committing, don't attribute Cursor, Claude, or any AI tool. Don't reference internal pricing, revenue, or private endpoints. Don't commit secrets. Auth tokens are read from `~/.summer/` at runtime, never hard-coded.

If you're an AI agent or developer with zero context, read this first.

---

## What This Is

**Summer Engine** is the proprietary AI game engine binary users download via
`summer install` or from
[summerengine.com/download](https://summerengine.com/download). Users make
Summer games with the Summer SDK and GDScript.

**Summer** (this repo) is the **open-source agent layer** for it. Three things in one Node.js package:

1. **CLI tool**: lets users install, manage, and launch Summer Engine from their terminal
2. **MCP server**: gives AI coding agents 62 tools, including identity-bound project files, scene manipulation, play/stop, diagnostics, asset import/generation, cloud workflows, and creator publishing
3. **Skills bundle**: the current SKILL.md playbooks that auto-trigger when the agent sees the right natural-language signal

Plus lifecycle hooks, plugin manifests, and setup targets that wire all of the above into Claude Code, Cursor, Codex, Gemini, OpenCode, GitHub Copilot CLI, GitHub Copilot in VS Code, Cline, Roo Code, Factory Droid, and Devin Desktop (formerly Windsurf).

It gets published to npm as `summer-engine`. Users run it with `npx summer-engine <command>`.

### Naming (Do Not Confuse)

| Our package | Name | Notes |
|-------------|------|-------|
| npm package | `summer-engine` | What users install. Never recommend `summer-cli`. |
| GitHub repo | `summer-engine-agent` | Public repo at github.com/SummerEngine/summer-engine-agent |
| Internal folder | `tools/summer-cli/` | Path in engine repo only; not the package name |

**Warning:** The npm package `summer-cli` is an unrelated project (inactive since ~2020). We do not own it. Never document or recommend installing `summer-cli`. Always use `summer-engine`.

**It is NOT part of the engine build.** When you run `scons`, this code is not compiled. When you release a DMG/EXE, the CLI is not bundled. It's a separate product with its own build, its own version, its own publish pipeline. It happens to live in this repo for convenience.

### Public Surface Sync

When tools, skills, setup targets, license language, or counts change, update every public surface in the same change. Do not leave stale totals in README text, plugin manifests, docs, or SEO pages.

Current count commands:

```bash
rg "server\\.tool\\(" src/mcp/tools -g '*.ts' -g '!*.test.ts' | wc -l
find skills -name SKILL.md | wc -l
npm run build
node -e "import('./dist/lib/skills-registry.js').then(m=>{const r=m.SKILL_REGISTRY||[]; console.log({registry:r.length,recommended:r.filter(s=>s.recommended).length})})"
```

Update these CLI repo files when the public surface changes:

- `README.md`
- `.claude-plugin/plugin.json`
- `.codex-plugin/plugin.json`
- `AGENTS.md`
- `GEMINI.md`
- `references/mcp-tools-reference.md`
- `docs/DEVELOPMENT.md`
- `docs/SKILLS.md`

Update sibling public repos when relevant:

- `docs`: Mintlify docs, especially `cli/overview.mdx`, `ai-tools/operations.mdx`, `api-reference/`, setup guides, and any count-bearing page.
- `PublicSummerEngine`: guide data, `llms.txt` routes, README, and blog posts that mention counts or openness.
- `summer-strategy`: positioning, licensing, and launch strategy pages when the product story changes.

Copy rule: use "Summer agent layer" for this repo in prose, "`summer-engine` npm package" for the package, and "Summer Engine app" for the closed desktop engine. Avoid brittle skill totals in public copy unless you generated them in this change. Never show scary doctor JSON in the README just to explain remediation.

## Open Source

**This code is public.** The CLI is open source at [github.com/SummerEngine/summer-engine-agent](https://github.com/SummerEngine/summer-engine-agent) (MIT license). The engine repo is private; the CLI repo is a clean copy of `tools/summer-cli/` with no engine code or history.

### What this means for development

- **Commit messages are public.** Don't reference internal pricing, revenue numbers, private URLs, or engine internals. Keep messages focused on what changed in the CLI.
- **Don't commit secrets.** No API keys, internal endpoints, or auth tokens. The code reads tokens from `~/.summer/` at runtime - that's the correct pattern.
- **Internal strategy docs stay in the engine repo only.** Strategy, pricing, security-review, handoff, spec, and plan docs are NOT synced to the public repo. Keep public docs focused on setup, architecture, naming, tools, and release workflow.
- **AI agents: be aware.** If you're an AI agent working in this codebase, your commit messages and code comments will end up in a public repo. Write them as if the world can see them - because it can.

### Two-repo workflow

Development happens here in the engine monorepo (`tools/summer-cli/`). The public repo is synced on release:

The engine mirror's `package.json` is intentionally marked `private: true`. That guard does not affect local installs, builds, tests, or source reconciliation, but it makes `npm publish` fail from this stale mirror. The public repository owns the reviewed, releasable package metadata. Never remove the guard as a shortcut to publish from the engine checkout.

```
Engine repo (private)                Public repo (open source)
tools/summer-cli/        --sync-->   SummerEngine/summer-engine-agent
  src/, docs/, package.json, etc.      Same files, clean history
  docs/MCP_*_STRATEGY.md              NOT synced (internal)
  banner-preview.html                  NOT synced (dev artifact)
```

## Why It Exists

The short version: AI tools can write code, but they can't build scenes, run games, or read engine diagnostics. The MCP gives them those capabilities.

## Why TypeScript In A C++ Engine Repo

MCP's official SDK (`@modelcontextprotocol/sdk`) is JavaScript/TypeScript. There's no C++ MCP SDK. The MCP server needs to be a separate process that AI tools launch via stdin/stdout.

It lives in this repo (rather than the web repo or a separate repo) because the MCP tool definitions map to C++ engine operations. When you add an op in `ops_executor.cpp`, the matching tool updates here. That said, the coupling is loose - moving it to a separate repo later is trivial.

**The .ts files never run inside the engine.** They compile to JavaScript, get published to npm, and run as a completely separate Node.js process.

---

## Architecture

```
AI Tool (Cursor/Claude Code)
    |  stdio (MCP protocol)
    v
summer-engine CLI (this package - Node.js)
    |  HTTP (localhost:6550)
    v
Summer Engine (C++ - LocalApiServer)
    |  direct call
    v
OpsExecutor::apply() (same path as integrated chat)
```

## Folder Structure

```
tools/summer-cli/
├── package.json              # npm package config - published as "summer-engine"
├── tsconfig.json             # TypeScript compiler config
├── README.md                 # User-facing documentation
├── .gitignore                # Excludes dist/ and node_modules/
│
├── docs/                     # Developer documentation (you are here)
│   ├── DEVELOPMENT.md        # This file - architecture, workflow, deployment
│   └── ADDING_TOOLS.md       # How to add new MCP tools when ops change
│
├── scripts/
│   └── smoke-test.sh         # Quick validation that CLI commands work
│
└── src/                      # TypeScript source
    ├── bin/
    │   └── summer.ts         # CLI entry point - registers all commands
    │
    ├── commands/              # CLI commands (one file per command)
    │   ├── install.ts         # summer install - downloads engine
    │   ├── login.ts           # summer login - browser OAuth
    │   ├── logout.ts          # summer logout - clears tokens
    │   ├── config.ts          # summer config - shared non-secret config
    │   ├── publish.ts         # summer publish - confirmed creator release
    │   ├── releases.ts        # summer releases - creator history
    │   ├── logs.ts            # summer logs - explicit durable-log boundary
    │   ├── status.ts          # summer status - engine diagnostics
    │   ├── run.ts             # summer run [path] - launches engine
    │   ├── open.ts            # summer open <path> - opens project
    │   ├── create.ts          # summer create <template> - scaffolds project
    │   ├── list.ts            # summer list - templates/projects
    │   ├── memory.ts          # summer memory - inspect .summer project memory
    │   ├── skills.ts          # summer skills - install/list best-practice guides
    │   └── mcp.ts             # summer mcp - starts MCP server
    │
    ├── mcp/                   # MCP server implementation
    │   ├── server.ts          # MCP server setup - lazy-connect, stdio transport
    │   └── tools/             # Tool definitions (one file per category)
    │       ├── with-engine.ts # Wrapper: lazy-connect + error handling
    │       ├── scene-tools.ts # 10 tools: AddNode, SetProp, RemoveNode, etc.
    │       ├── debug-tools.ts # 7 tools: Play, Stop, Diagnostics (snapshots Summer Agent-only)
    │       ├── project-tools.ts # 5 tools: ProjectSetting, SceneTree, Import, etc.
    │       └── asset-tools.ts # 2 tools: SearchAssets, ImportAsset (Pro)
    │
    └── lib/                   # Shared utilities
        ├── api-client.ts      # HTTP client for engine's local API
        ├── store.ts           # Hardened shared ~/.summer store
        ├── auth.ts            # Core-compatible identity + token metadata
        ├── config.ts          # Typed non-secret configuration
        ├── creator.ts         # Versioned creator publish/history client
        ├── engine.ts          # Engine detection, health check, port reading
        └── project-memory.ts  # Lightweight .summer memory summary
```

## Key Concepts

### Lazy-Connect Pattern (`mcp/server.ts`)

The MCP server does NOT require the engine to be running at startup. It starts immediately, registers all tools, and connects to the engine lazily on first tool call. If the engine stops mid-session, the next tool call retries. This is handled by `with-engine.ts`.

### Shared `~/.summer/` Store

The CLI, existing MCP, exporters, and desktop engine share one secured
`~/.summer/` directory. Existing filenames are preserved because other Summer
Engine consumers already read them:

- `api-token` - written by the engine's `LocalApiServer` on startup. Random per-session. The MCP server reads this to authenticate with the engine. **Only valid while engine is running.**
- `auth-token` - core Summer CLI JWT written by `summer login`.
- `cloud-token` - separate Summer Cloud credential.
- `creator-token` - separate Summercraft `sc_` credential connected by
  `summer login --creator`; it never replaces `auth-token`.
- `user.json` - validated `{id, email, name?}` core identity.
- `credential-metadata.json` - non-secret audience, scope, type, and expiry.
- `config.json` - typed, non-secret shared configuration.
- `creator-audit.jsonl` - secret-free local creator publish receipts.

Normal users need no new environment variables. See
[GATE_E3_CREATOR_CLI.md](GATE_E3_CREATOR_CLI.md) for the exact API,
confirmation, credential, and residual activation contract.

### Template System (`commands/create.ts`)

Two tiers:
- **Built-in**: Tiny templates embedded in code (empty, 3d-basic). Just Godot config strings.
- **Remote** (future): Hosted in GitHub repo, downloaded on demand. 100MB-2GB per template.

---

## Development Workflow

### Prerequisites

- Node.js 18+
- npm

### Setup

```bash
cd tools/summer-cli
npm install
```

### Build

```bash
npm run build          # Compile TypeScript to dist/
npm run dev            # Watch mode - recompiles on change
```

### Test Locally

```bash
# Run CLI commands directly from source
node dist/bin/summer.js status
node dist/bin/summer.js list templates
node dist/bin/summer.js create 3d-basic test-project

# Run MCP server (requires engine running)
node dist/bin/summer.js mcp

# Run smoke tests
bash scripts/smoke-test.sh
```

### Test MCP with Cursor

Add to `.cursor/mcp.json` (point to local build):

```json
{
  "mcpServers": {
    "summer-engine": {
      "command": "node",
      "args": ["/Users/YOU/development/summerengine/tools/summer-cli/dist/bin/summer.js", "mcp"]
    }
  }
}
```

---

## Three Independent Deploy Pipelines

The CLI, the engine, and the web app are **completely independent products** with separate deploy processes:

| What changed | How to deploy | Where it goes |
|---|---|---|
| C++ code (ops, LocalApiServer, auth) | `scons` build -> release DMG/EXE per `doc/SUMMER/releases/` | Supabase storage, auto-updater |
| CLI commands, MCP tools | Reconcile into the public repo, then follow its reviewed npm release runbook | npmjs.com as `summer-engine` |
| Web auth routes, API | Deploy web repo (`publicsummerengine`) as usual | Vercel/your hosting |

Changing the CLI does NOT require rebuilding the engine. Rebuilding the engine does NOT require republishing the CLI. The only time you touch both is when adding a new engine operation that needs a new MCP tool.

### Release Checklist

A full release means the reviewed CLI changes and version bump are already on the public repository's `main`, then npm is published from a fresh clone of that exact commit. Never publish first and sync source later.

Use [`RELEASING.md`](./RELEASING.md) for the release contract and [`NPM_PUBLISH_QUICK_COMMANDS.md`](./NPM_PUBLISH_QUICK_COMMANDS.md) for the copy-paste fresh-terminal procedure. Both contain hard stops for a stale version, a dirty tree, the wrong repository, or the wrong npm account.

### npm Account

- Username: `summer-engine`
- Email: `founders@summerengine.com`
- 2FA: Required for publishing
- Orgs: `@summerengine`, `@summer-engine` (for future scoped packages)

### Reserved npm Names

These are registered under the `summer-engine` npm account as placeholders:
- Unscoped: `summer-mcp`, `summerengine`, `summer`, `summer-engine-mcp`, `summer-game-engine`
- `@summerengine/`: `cli`, `mcp`, `sdk`, `tools`, `core`, `engine`
- `@summer-engine/`: `cli`, `mcp`, `sdk`, `tools`, `core`

Keep this list in sync with the npm account and package metadata.

### Version Strategy

- CLI version is independent of engine version
- CLI must be backwards-compatible with older engine versions (tools gracefully report unsupported engine capabilities)
- Use semver: patch for fixes, minor for new tools, major for breaking changes

---

## How the CLI Relates to the Engine

### Engine Side (C++)

The engine runs a `LocalApiServer` (at `modules/1summer_engine/api/local_api_server.cpp`) that:
- Listens on `localhost:6550`
- Writes `~/.summer/api-token` and `~/.summer/api-port` on startup
- Accepts HTTP requests with Bearer token auth
- Routes to `OpsExecutor::apply()` for operations
- Routes to `StateProvider` for state queries

### Web Side (Next.js)

The web repo at `development/publicsummerengine` has:
- `app/api/auth/cli-login/route.ts` - CLI login polling endpoint
- `app/(core)/loginDeepPage/LoginDeepPageClient.tsx` - handles `cli_session` param
- `app/(core)/login/page.tsx` - passes `cli_session` through OAuth

### The Connection

```
Engine ops (C++)           MCP tools (TypeScript)        Web auth (TypeScript)
ops_executor.cpp    <-->   mcp/tools/*.ts          -->   api/auth/cli-login/
  AddNode                    summer_add_node              GET/POST polling
  SetProp                    summer_set_prop
  PlayGame                   summer_play
  ...                        ...
```

When an op changes in C++, the matching tool in `mcp/tools/` must be updated. See `docs/ADDING_TOOLS.md`.

---

## Troubleshooting

### "Cannot find module" errors in IDE

Run `npm install` in `tools/summer-cli/`. The IDE needs `node_modules/` to resolve imports.

### MCP tools return "Summer Engine is not running"

The engine must be open. The MCP server connects via localhost to the engine's API.

### "Unauthorized" errors from engine API

The `api-token` changes each time the engine starts. If the MCP server cached an old token, it will reset and retry on the next call.

### CLI can't find engine binary

`summer run` looks in standard install paths (`/Applications/Summer.app` on macOS, `%LOCALAPPDATA%\SummerEngine\current\Summer.exe` first on Windows, then legacy NSIS paths as fallback). If installed elsewhere, pass the project path directly.

---

## TODO - What's Missing / Thin / Needs Work

### Not Yet Built
- [ ] `summer install` - downloads engine but hasn't been tested end-to-end (DMG mount/copy flow on macOS, silent installer on Windows)
- [ ] `summer run` - launches engine but the binary detection paths are still hardcoded guesses (`/Applications/Summer.app`, `%LOCALAPPDATA%\SummerEngine\current\Summer.exe`, legacy NSIS fallbacks on Windows). Needs real-world testing on both platforms
- [ ] `summer open` - currently just prints a message if engine is already running. Doesn't actually switch projects via the API (would need a new engine endpoint)
- [ ] Remote templates - `summer create` only has 2 tiny built-in templates. No GitHub-based template downloading yet. Templates will be 100MB-2GB, need download progress, extraction, etc.
- [ ] `summer list projects` - only scans current directory. Should eventually scan known project locations or integrate with engine's project manager
- [ ] Linux support - `summer install` and `summer run` only handle macOS/Windows
- [ ] Auto-update mechanism - no way for the CLI to tell users a new version is available

### Thin / Fragile
- [ ] CLI login flow - works but hasn't been tested end-to-end with the web route (`/api/auth/cli-login`). The deep link page changes for `cli_session` need real browser testing
- [ ] Error handling in `api-client.ts` - all methods return `Promise<unknown>` with no typed responses. Network errors surface as generic messages
- [ ] No retry logic - if a single API call errors, the tool just returns that error. No automatic retry
- [ ] `with-engine.ts` resets the entire client on any error, even if it's a 400 (bad request) not a connection issue
- [ ] MCP tool descriptions - functional but could be much richer. Should include examples, common patterns, and type system documentation (e.g., Godot string format for Vector3)
- [ ] No input validation - CLI commands don't validate paths exist before passing to the engine (some do, most don't)

### Should Spend More Time On
- [ ] MCP tool descriptions are the main thing AI agents read to understand how to use Summer Engine. Current descriptions are minimal. Each tool should have examples of usage, common parameter values, and links to Godot docs where relevant
- [ ] The `create` command templates are bare-bones. The 3d-basic scene doesn't have a WorldEnvironment configured properly. Templates should be polished enough to be impressive on first use
- [ ] Testing - only a smoke test script exists. No unit tests for individual commands, no integration tests for the MCP server, no mock engine for testing without the real engine running
- [ ] CI/CD - no automated build/test/publish pipeline. Publishing is manual from a clean public-repository clone
- [ ] The engine's `LocalApiServer` (C++) is polling-based at 50ms intervals. Should benchmark whether this causes any frame drops in the editor. Might need to throttle or use a different approach for heavy operations
- [ ] Windows testing - everything was built on macOS. The Windows paths in `run.ts` and `install.ts` are untested
- [ ] Documentation for users (not devs) - the README is okay but there's no "Getting Started with MCP" tutorial that walks through the full flow with screenshots

### R&D / Future Investment
- [ ] **Summer Cloud sync** - Experimental content-addressed project sync. Keep it clearly labeled as a Research Preview until recovery, conflicts, service availability, and cross-machine behavior have production evidence. It is not required for the stable local CLI and MCP workflow
- [ ] **Simulated play (high value, hard problem)** - Let the AI start the game, simulate input (based on InputMap), record frames, and analyze what happens. This is the dream feedback loop: AI builds -> plays -> sees issues -> fixes. Blocked by: video-as-context is expensive and not well-supported by current models. Snapshot-per-frame is possible but noisy. Needs real R&D on frame sampling, input simulation via engine API, and cost-effective visual analysis
- [ ] **Skills / knowledge packs** - Downloadable best-practice guides for game dev patterns (FPS, platformer, 3D optimization, GDScript patterns). Format TBD (markdown? Cursor rules? JSON?). Would make AI agents significantly better at building games

### Nice To Have (Future)
- [ ] `summer doctor` - diagnose common issues (engine installed? right version? port available? auth valid?)
- [ ] `summer upgrade` - update the engine to latest version
- [ ] `summer publish` - export/publish your game
- [ ] Tab completion for commands and template names
- [ ] MCP resources (read-only data like scene tree, file tree) in addition to tools
- [ ] Streaming results for long operations (e.g., ImportFromUrlBatch)
- [ ] Telemetry/analytics on CLI usage (opt-in)

---

## File Ownership

| Area | Repo | Key Files |
|------|------|-----------|
| LocalApiServer | engine (C++) | `modules/1summer_engine/api/local_api_server.*` |
| Auth token writing | engine (C++) | `modules/1summer_engine/auth/auth_manager.cpp` |
| Editor init | engine (C++) | `editor/editor_node.cpp` |
| CLI commands | engine (Node.js) | `tools/summer-cli/src/commands/` |
| MCP tools | engine (Node.js) | `tools/summer-cli/src/mcp/tools/` |
| CLI auth route | web (Next.js) | `publicsummerengine/app/api/auth/cli-login/` |
| Login page changes | web (Next.js) | `publicsummerengine/app/(core)/login/page.tsx` |
| Deep link page | web (Next.js) | `publicsummerengine/app/(core)/loginDeepPage/` |
