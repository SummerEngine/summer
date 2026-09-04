# Summer: Development Guide

This repo (npm: `summer-engine`, GitHub: `summerengine/summer` — being renamed from `SummerEngine/summer-engine-agent`, redirects keep old links working) is **MIT, open source**. Treat all commits and code comments as public.

When committing, don't attribute Cursor, Claude, or any AI tool. Don't reference internal pricing, revenue, or private endpoints. Don't commit secrets. Auth tokens are read from `~/.summer/` at runtime, never hard-coded.

If you're an AI agent or developer with zero context: read [`AGENTS.md`](../AGENTS.md) for how the system is *used*, [`docs/design/CONTRACT.md`](design/CONTRACT.md) for the rules everything here is built against, then this file for how to *change* it.

---

## What this is

**Summer Engine** is the AI game engine where creators make Summer games with the Summer SDK and GDScript. It is a proprietary binary downloaded through `summer install` or from [summerengine.com/download](https://summerengine.com/download).

**Summer** (this repo) is the open-source system agents use with it:

1. **The Library** (`library/`) — skills, examples, templates, collections, references, and tool descriptors, each described once by a `resource.yaml`.
2. **The software** (`src/`) — CLI, MCP server, project memory, and the per-agent installer.
3. **The registry** (`registry/`) — schemas plus the generated catalog every surface reads.
4. **Evidence** (`evals/`) — proof the library works, gated in CI.

### Naming (do not confuse)

| Thing | Name | Notes |
|---|---|---|
| Product | Summer | The system: library + tools + project memory (this repo). |
| npm package | `summer-engine` | What users install. Never recommend `summer-cli` (an unrelated, inactive package we do not own). |
| GitHub repo | `summerengine/summer` | Rename pending — today the repo is `SummerEngine/summer-engine-agent`; redirects will hold once renamed. |
| Binary | `summer` | The CLI entry point. |
| Brand for the editor | Summer Engine | The closed desktop app (editor + runtime). |
| Copy rule | — | "Summer" for the system, "`summer-engine` npm package" for the package, "Summer Engine" for the editor. Full conventions: [`NAMING.md`](NAMING.md). |

---

## Repository layout

```
src/
├── bin/              # entry point — composes cli + mcp
├── cli/              # commander wiring (src/cli/commands/*); `summer tool` dispatches through core/capabilities/tool-dispatch.ts
├── mcp/              # MCP server + src/mcp/tools/*.ts — where most tool implementations live today
├── core/             # auth, config, engine connection, store, feedback/, headless/, capabilities/
│                     #   (a few tools + doctor, plan, debug-report, and the CLI dispatch table)
├── lib/              # registry helpers shared with scripts/ (capability lint)
├── project-memory/   # .summer/ read/write (project.json, memory index)
└── installer/        # agent detection, per-client config writing, skill install, version checks

library/              # content — flat folders per kind, one resource.yaml each
registry/
├── schemas/          # JSON Schemas validating every resource.yaml, per kind
└── generated/        # BUILD ARTIFACT of the compiler — never hand-edited
evals/                # routing (live), skills, examples, templates, tools, end-to-end
integrations/         # one folder per supported agent: what gets generated/written where
scripts/
├── generate-registry/  # the compiler: library/ -> registry/generated/ + root manifests
└── validate-library/   # schema validation + capability lint
```

The import direction is a tested invariant (`src/import-direction.test.ts`): `cli/` never imports `mcp/`; `bin/` composes the two. The *layering* is not yet the ideal the contract describes: 81 of the 86 tools are implemented in `src/mcp/tools/*.ts` with hand-written zod, and `core/capabilities/tool-dispatch.ts` mirrors them so `summer tool <slug>` reaches the same functions. What keeps the two faces honest is `src/mcp/tools/descriptor-parity.test.ts` (zod shape ↔ `library/tools/*/resource.yaml` `input_schema`) plus the validator's cross-checks; folding the mirror into one registration is the scheduled consolidation pass (CONTRACT §3, DECISIONS D13).

---

## Commands

```bash
npm install
npm run build              # tsc -> dist/
npm run dev                # tsc --watch
npm test                   # vitest + validate:library
npm run validate:library   # schema validation + capability lint over library/
npm run eval:routing       # routing eval: real asks vs the index, gated on baseline.json
npm run eval:routing:heldout   # blind held-out set, report-only (the honest index-quality number)
npm run eval:outcomes -- --dry-run   # outcome evals, static half (task schema + golden drift); the replay needs SUMMER_EDITOR_BIN
npm run generate:registry  # = node scripts/generate-registry/cli.ts — regenerate registry/generated/ + root manifests
node scripts/generate-registry/cli.ts --check  # CI parity gate: fails on any drift, writes nothing
node scripts/generate-registry/cli.ts --embed  # optional: also write registry/generated/embeddings.json for semantic library search (needs a Summer login; CI never embeds)
```

The registry and validation scripts run TypeScript natively and need **Node >= 22.18**; the published package requires Node 20+ (`engines.node`).

Two tests need a sibling checkout to do real work and **skip loudly** otherwise: `src/core/op-registry-drift.test.ts` compares the CLI's known engine ops against the engine's op registry — set `SUMMER_ENGINE_REPO=/path/to/summerengine` (default: a `summerengine` sibling directory); the headless real-binary test needs an engine build with worker mode. A skip is printed by name; do not read a skip as a pass.

### CLI command reference

`summer --help` is the source of truth; this is its current shape (20 commands plus `help`).

| Command | Does |
|---|---|
| `summer install [--yes] [--path <dir>]` | Download and install Summer Engine (macOS, Windows, Linux x86_64). Never replaces an installed engine without `--yes` or a TTY confirmation. |
| `summer login [--creator] [--force]` | Browser sign-in; `--creator` connects a separately scoped publish token. |
| `summer logout` | Clear stored tokens (says so when `SUMMER_TOKEN` is in effect instead). |
| `summer status` | Engine state, port, auth. |
| `summer run [path] [--no-project] [--background\|--focus]` | Launch the engine with a project; bare editor needs `--no-project`. Background (no focus steal) is the default when stdout is not a TTY, i.e. an agent; a human in a terminal gets focus. See `TESTING.md` "Working in the background". |
| `summer open <path \| target> [--print] [--list] [--web \| --editor] [--json] [--path <res>] [--node <p>] [--scene <res>] [--param k=v]` | A project directory (contains `project.godot`) opens in the engine as before. Anything else is a navigation target — a product-map id (`billing`, `my-games`, `mcp-guide`, `scene`, `inspector`), an intent phrase, a `res://` path, or a summerengine.com path — opened in the browser (through `/login?returnUrl=` when needed) or sent to the running editor; `--print` resolves without opening. Same behavior as the `summer_open` MCP tool and `summer tool open` (`docs/design/NAVIGATION-DESIGN.md`). |
| `summer create <template> [name] [--keep-git]` | Scaffold from a pinned (or built-in) template; writes `.summer/project.json`. |
| `summer list templates \| projects` | Browse the template registry / local projects. |
| `summer memory [show <file>]` | Inspect `.summer/` project memory. |
| `summer skills list \| info <name> \| install [name] [--all \| --recommended] [--stable-only] [--agent <a>] [--scope user\|project] [--force]` | Skill installer over `skills-registry.json`. Bulk installs take every `stable` and `preview` skill (`deprecated` only by name); `--stable-only` skips preview; `skills list` tags them `[preview]`. `--include-preview` is a hidden no-op alias for one release. |
| `summer mcp [--project <path> \| --instance <id>]` | Start the MCP server (stdio). `summer mcp setup <agent>` is a deprecated alias of `summer setup`. |
| `summer setup [agent] [--yes] [--force] [--recommended] [--stable-only] [--scope …] [--local-dev]` | MCP config + all skills (preview included; `--stable-only` skips them) + doctor, one shot, idempotent. `--local-dev` (or `SUMMER_DEV=1`) points the agent at this checkout's `dist/bin/summer.js` instead of `npx summer-engine@latest`. |
| `summer doctor [--json]` | Checks: `node-version`, `cli-version`, `cli-version-current`, `skills-version-stale`, `login`, `engine-install`, `local-api`, `project-memory`, `mcp-boot`, `mcp-tools-list`. `ok` = no failures. |
| `summer debug [issue…]` | Support-ready Markdown debug report. |
| `summer plan <goal…>` | Route a goal to skills / tools / gates. |
| `summer config [get \| set \| unset \| path]` | Shared non-secret `~/.summer/config.json` (`gateway.url`, …). |
| `summer publish [project] --artifact <pck> --version <v> [--confirm]` | Confirmed creator release. |
| `summer releases [--cursor <c>]` | Creator release history. |
| `summer events [--follow] [--kinds <csv>] [--since <seq>] [--limit <n>] [--json]` | Engine events channel: the newest events, or `--follow` to stream them live (long-poll over `/api/events/poll`, one line per event, JSON when piped). Builds without the channel print a structured `engine_lacks_events` receipt and exit 1. |
| `summer tool [name] [--args '<json>'] [--list]` | Run any tool with the MCP implementation; `--list` prints every slug. |
| `summer help [command]` | Commander's built-in help. |

Unknown commands exit 1. `summer` alone prints the intro.

### Test the CLI and MCP locally

```bash
node dist/bin/summer.js status
node dist/bin/summer.js list templates
node dist/bin/summer.js mcp                       # requires a running engine
node dist/bin/summer.js mcp --project /abs/path   # explicit selectors for hosts
node dist/bin/summer.js mcp --instance <id>       # launched outside a project dir
```

To point an agent at the local build instead of the published package:

```bash
node dist/bin/summer.js setup claude-code --local-dev --yes    # writes command: node, args: [<abs>/dist/bin/summer.js, mcp]
node dist/bin/summer.js setup claude-code --local-dev --print  # show the entry without writing
npx -y summer-engine@latest setup claude-code --yes --force    # revert to npx + published skills
```

`SUMMER_DEV=1` has the same effect as `--local-dev`. The full end-to-end recipe for testing an unpublished build is [`TESTING.md`](TESTING.md).

Templates (`summer list templates`, `summer create <template> [name]`) resolve only through the pin manifests in `library/templates/` — how resolution, digest verification, and `.summer/project.json` work is documented in [`library/templates/README.md`](../library/templates/README.md) (the former `docs/TEMPLATES.md` is retired).

---

## One definition, every surface

Nothing is registered twice. Every skill, template, reference, and tool descriptor is a `library/<kind>/<slug>/resource.yaml`; `scripts/generate-registry` compiles them into `registry/generated/` (the searchable `index.json`, `counts.json`, `aliases.json`, `skills-registry.json`, `templates-registry.json`) and applies the agent manifests (`.claude-plugin/plugin.json`, `gemini-extension.json`, …) to the repo root. Those root dot-files are build artifacts — edit the source, rerun the compiler, commit both.

CI (`--check` + `npm test`) fails on: schema violations, duplicate IDs/aliases, dangling `related` links, capability-lint violations, regenerated output differing from what's committed, manifest versions ≠ `package.json`, and numeric "N tools"/"N skills" claims in `README.md`/`AGENTS.md`/`GEMINI.md` that contradict `counts.json`. **Don't write literal tool/skill counts in those files** — phrase around them or the guard will (correctly) fail your PR.

### Adding a library entry

1. Create `library/<kind>/<slug>/resource.yaml` per the schema in `registry/schemas/` (skills also get `SKILL.md`; templates are pin manifests — see [`library/templates/README.md`](../library/templates/README.md) for the commit + tree-digest rules).
2. `npm run validate:library` — schema + capability lint (no URLs off the allowlist, no install commands, no credential references).
3. `node scripts/generate-registry/cli.ts` — regenerate; commit the generated diff together with the entry.
4. `npm run eval:routing` — if your entry serves one of the known gap queries, update `evals/routing/queries.yaml` + baseline in the same PR.

IDs (`<kind>/<slug>`) are permanent. Renaming means a new ID plus an `aliases` entry on the new resource — never a silent move.

### How skills reference each other

Inside `library/skills/**/SKILL.md` and `library/references/**/*.md`, refer to another skill by its **bare slug** — the `library/skills/<slug>` directory name, which is also the `name:` in its SKILL.md frontmatter and the `<slug>` half of its `skill/<slug>` id. Write it as inline code or as an explicit instruction: `` `vfx-fire` ``, "use the `design-mechanic` skill", `Skill: gdscript-patterns`, `/play`.

Why the bare slug and not a namespaced form: skills reach a host along two paths that name them differently.

- `summer setup <agent>` / `summer skills install` (the canonical path) copies each skill into the host's user-skill directory (`~/.claude/skills/<slug>/`, and the equivalent for Cursor, Codex, Gemini, …). Hosts expose those as plain user skills — Claude Code as `/<slug>` — and there is no `summer:` namespace.
- The plugin-marketplace path (`.claude-plugin/plugin.json`, generated from `integrations/claude`) loads the same directories as plugin skills, which Claude Code exposes as `/summer:<slug>`.

Hosts match on the skill name in both cases, so the bare slug resolves under either install; `summer:<slug>` resolves only under the second. Never use the v2 forms `summer:<category>/<name>`, `<category>/<name>`, or `skills/<category>/<name>` — categories are gone (`library/skills/` is flat) and the VFX recipes are `vfx-<effect>` (`vfx-fire`, `vfx-smoke`, …). Cross-links to shared documents are relative paths into the library: `../../references/<slug>/<slug>.md` from a skill, `../../templates/README.md` for the template catalog. Legacy names are *recorded* in `registry/generated/aliases.json` but nothing resolves them at runtime yet (only `summer create` resolves legacy template names) — new prose must use the bare slug.

### Adding an MCP tool

Today a tool is four edits, kept in step by tests:

1. Register it in the relevant `src/mcp/tools/*.ts` (`server.registerTool` with a zod raw shape) — or, for engine-free logic, implement in `src/core/capabilities/` and register there.
2. Add a dispatch entry in `src/core/capabilities/tool-dispatch.ts` so `summer tool <slug>` reaches the same function with the same zod validation.
3. Add `library/tools/<slug>/resource.yaml` (descriptor: `implementation.module/export`, `surfaces.mcp.tool_name` + `remote`, `input_schema`, the five `authority` booleans).
4. `npm run generate:registry`; then `npm test` — `descriptor-parity.test.ts` fails if the zod shape and `input_schema` disagree, `tool-dispatch.test.ts` if the CLI face is missing, and the validator if the descriptor names a module/export/tool that does not exist.

Mechanics of the engine side (ops, capability list): [`ADDING_TOOLS.md`](ADDING_TOOLS.md).

### Adding an agent integration

One folder in `integrations/` (plus, if the client has a manifest file in this repo, a builder in `scripts/generate-registry/manifests.ts` and a target in `scripts/generate-registry/targets.ts`), then regenerate. Never hand-edit root manifest files. The full per-client map: [`integrations/README.md`](../integrations/README.md).

---

## Architecture

```
AI agent (Claude Code / Cursor / Codex / ...)
    |  stdio (MCP) or shell (CLI)
    v
summer-engine (this package - Node.js)
    |  HTTP (localhost, per-instance port + token)
    v
Summer Engine app (LocalApiServer -> OpsExecutor)
```

- **Lazy connect** (`src/mcp/server.ts`): the MCP server starts without a running engine, registers tools immediately, and connects on first call; if the engine restarts, the next call retries.
- **Multi-editor discovery**: each live editor publishes `~/.summer/instances/<id>.json`; the MCP walks up from CWD to find `project.godot` and binds to the matching instance, failing closed when ambiguous. Explicit `--project` / `--instance` override.
- **Shared `~/.summer/` store** (`src/core/store.ts`): `0700` dir, `0600` files, atomic replacement, symlink refusal. Filenames (`api-token`, `auth-token`, `creator-token`, `user.json`, `config.json`, `credential-metadata.json`, `creator-audit.jsonl`) are shared with the desktop engine — do not rename them.
- **Ops values are engine variant strings** (`"Vector3(0, 10, 0)"`, `"Color(1, 0.9, 0.8)"`), never JSON objects. This crosses both repos; coordinate changes.

No environment variables are required for normal use. Optional: `SUMMER_GATEWAY_URL` (gateway override; `gateway.url` in `~/.summer/config.json` does the same for every gateway caller), `SUMMER_TOKEN` (auth token override for CI/cloud sessions), `SUMMER_ENGINE_BINARY` (engine binary override), `SUMMER_MCP_DEBUG=1` (structured stderr line per tool call), `SUMMER_NO_TELEMETRY=1` / `DO_NOT_TRACK=1` (disable the feedback mailbox), `SUMMER_CAPABILITY_PREFLIGHT=off` (send every call even when the engine lacks the op), `SUMMER_HEADLESS_ROUTING=1` (headless worker routing — needs an engine build with worker mode), `SUMMER_TRAJECTORY_DIR` (opt-in per-tool-call JSONL capture, redacted), `SUMMER_TRAJECTORY_EVAL=1` (with the directory set: additionally writes an unredacted `trajectory.full.jsonl` with a bounded result summary — for eval fixtures only, never a default; `summer_get_project_context` reports `trajectory_eval_mode: true` while it is on), `SUMMER_PRE_COMMIT_DOCTOR=1` (the opt-in pre-commit hook), `SUMMER_EMBED_URL` (embedding endpoint for semantic library search and `generate-registry --embed`, default `<gateway>/api/mcp/embed`; `off` forces lexical-only search), `SUMMER_ENGINE_REPO` (tests only, above), `SUMMER_EDITOR_BIN` (outcome evals: the editor binary to boot).

---

## Working in a shared worktree (multi-agent)

The v3 build ran several agents in one checkout at once and lost work to it (DECISIONS D14). When more than one agent — or one agent and a human — edits the same worktree, these are not suggestions:

- **Own disjoint paths.** Before starting, agree who owns which files or directories for the duration of the task. Do not touch files outside your set; if you must, ask the owner.
- **Commit with `--only`.** `git commit --only -m "…" -- <your exact paths>`. Never `git add`, never a bare `git commit` (it sweeps whatever anyone else staged), never `--amend`, `git reset`, `git stash`, or `git checkout -- <file>` — each of those can silently destroy or revert a sibling's work.
- **Check the index first.** `git diff --cached HEAD --stat` before every commit; if it lists anything you did not stage, stop and find out whose it is.
- **Review is read-only.** A review agent edits nothing and never runs product commands with side effects on the machine it audits (`summer login/logout/install/run/setup/publish`). Read the code; run the tests; say what you found.
- **Green means the real artifact.** A test written alongside a fix that only exercises a mock is not verification. Prefer the gates that load the real thing: `generate-registry --check`, `validate:library`, the parity test, a cold install into a fake `HOME`.

---

## Releasing

The CLI/MCP/library ship together as the npm package; the engine app and the web platform deploy independently. A release means the reviewed changes and version bump are on this repo's `main`, then npm is published from a fresh clone of that exact commit — never publish first and sync later.

- Release contract: [`RELEASING.md`](RELEASING.md)
- Copy-paste procedure: [`NPM_PUBLISH_QUICK_COMMANDS.md`](NPM_PUBLISH_QUICK_COMMANDS.md)
- Versioning: semver, independent of engine versions; the package stays backwards-compatible with older engines (tools report unsupported capabilities gracefully).
- npm account: `summer-engine` (2FA required). Reserved placeholder names (`summer`, `summer-mcp`, `@summerengine/*`, …) stay reserved; never publish to them casually.

An engine-repo mirror of this package exists for historical reasons; its `package.json` is `private: true` specifically so `npm publish` fails from there. This repo owns the releasable package.

---

## Related docs

- v2 → v3: what moved and why nothing breaks — [`MIGRATION-V2-V3.md`](MIGRATION-V2-V3.md)
- The rules — [`design/CONTRACT.md`](design/CONTRACT.md) · the reasoning — [`design/DECISIONS.md`](design/DECISIONS.md) · the sequence — [`design/ROADMAP.md`](design/ROADMAP.md)
- Evals and their CI gates — [`../evals/README.md`](../evals/README.md)
- Test an unpublished build end to end (local-dev setup, engine-less checks, expected failures, gates) — [`TESTING.md`](TESTING.md)
- Engine-side tool mechanics — [`ADDING_TOOLS.md`](ADDING_TOOLS.md) · architecture tour — [`OVERVIEW.md`](OVERVIEW.md)
