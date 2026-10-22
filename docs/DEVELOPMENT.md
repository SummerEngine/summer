# Summer: Development Guide

This repo (npm: `summer-engine`, GitHub: `summerengine/summer`) is **MIT, open source**. Treat all commits and code comments as public.

Commits may carry a `Co-Authored-By:` line for the AI agent that wrote them; nothing else in a commit or comment should name the tool. Don't reference internal pricing, revenue, or private endpoints. Don't commit secrets. Auth tokens are read from `~/.summer/` at runtime, never hard-coded.

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
| GitHub repo | `summerengine/summer` | GitHub URLs are case-insensitive; write it lowercase. |
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

The import direction is a tested invariant (`src/import-direction.test.ts`): `cli/` never imports `mcp/`; `bin/` composes the two. The *layering* is not yet the ideal the contract describes: most tools are implemented in `src/mcp/tools/*.ts` with hand-written zod, and `core/capabilities/tool-dispatch.ts` mirrors them so `summer tool <slug>` reaches the same functions. Newer tools (fabricate, UI control, runtime control) share one zod schema and op builder from `core/capabilities/`; the kit-placement tools (`core/capabilities/placement.ts`), the five seeing tools (`core/capabilities/seeing/`) and `summer_scene_audit` (`core/capabilities/audit/`, kernel `assets/audit/scene_audit.gd`) share the whole implementation. What keeps the two faces honest is `src/mcp/tools/descriptor-parity.test.ts` (zod shape ↔ `library/tools/*/resource.yaml` `input_schema`) plus the validator's cross-checks; folding the mirror into one registration is the scheduled consolidation pass (CONTRACT §3, DECISIONS D13).

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

The registry and validation scripts run TypeScript natively and need **Node >= 22.18**; the published package requires Node 22+ (`engines.node`).

Every test file runs under a throwaway `HOME` (`vitest.config.ts` → `src/test-helpers/fake-home.ts`), so `os.homedir()`, `getSummerDir()` and every default store path land in a temp dir; `setSummerDirForTests(null)` restores that fake home, never the real one. A global guard (`src/test-helpers/real-summer-dir-guard.ts`) snapshots the real `~/.summer` before the suite and fails the run if any test created, deleted or changed something in it (files a live engine/MCP process rewrites are reported, not failed). No test may touch the real `~/.summer`.

The suite needs Node 22 or newer (`.nvmrc`; CI uses 22.23.4), the same as the published CLI. Three tests need more than the checkout and **skip loudly** otherwise: `src/core/op-registry-drift.test.ts` (this package never sends an op the engine lacks) and `src/core/autopilot-assets.test.ts` (the vendored probe base matches the engine's) read the engine source's `origin/main` with `git show`, never its working tree, so they run only for maintainers with engine source access: set `SUMMER_ENGINE_REPO=/path/to/engine` (default: a `summerengine` sibling directory) and keep it fetched. The headless real-binary test needs an engine build with worker mode. A skip is printed by name; do not read a skip as a pass.

### CLI command reference

`summer --help` is the source of truth; this is its current shape (every command plus `help`).

| Command | Does |
|---|---|
| `summer install [--yes] [--path <dir>]` | Download and install Summer Engine (macOS, Windows, Linux x86_64). Never replaces an installed engine without `--yes` or a TTY confirmation. |
| `summer login [--store \| --no-store] [--force]` | One browser sign-in: the Summer account (CLI token, `~/.summer/auth-token`), then the store OAuth grant (`~/.summer/oauth-token`) for `store.upload_file` (3.x `summer_publish_build`) and the cloud operations (plans, the store, publishing, Grow), in the same browser. That page also shows the person's Agent permissions switches. `--store` runs only the store step; `--no-store` skips it. A failed store step keeps the account sign-in. |
| `summer logout` | Clear stored tokens (says so when `SUMMER_TOKEN` is in effect instead). |
| `summer status [--json]` | Engine state, port, auth. |
| `summer run [path] [--no-project] [--background\|--focus] [--bin <executable>]` | Launch the engine with a project; bare editor needs `--no-project`. `--bin` (env `SUMMER_BIN`) launches a build that is not installed — the in-bundle executable on macOS, never the `.app`. Background (no focus steal) is the default when stdout is not a TTY, i.e. an agent; a human in a terminal gets focus. See `TESTING.md` "Working in the background". |
| `summer open <path \| target> [--print] [--list] [--web \| --editor] [--json] [--path <res>] [--node <p>] [--scene <res>] [--param k=v]` | A project directory (contains `project.godot`) opens in the engine as before. Anything else is a navigation target — a product-map id (`billing`, `my-games`, `mcp-guide`, `scene`, `inspector`), an intent phrase, a `res://` path, or a summerengine.com path — opened in the browser (through `/login?returnUrl=` when needed) or sent to the running editor; `--print` resolves without opening. Same behavior as the `summer_open` MCP tool and `summer tool open` (`library/references/product-map`). |
| `summer dev [template] [dir] [--yes] [--background\|--focus] [--bin <executable>] [--no-launch-json]` | One step to an editor an agent can drive (`src/cli/commands/dev.ts`): installs the engine when none is installed (`installEngine`; only with `--yes` or the person's yes at a terminal, else `needs_confirmation` with the question to ask), creates the project (`createProject`; `3d-basic` unless a template is named; the project the current folder is in, else the current folder when it is empty or only dotfiles and not the home folder or a filesystem root, else `./my-game`), opens it with `summer run`'s launch (`core/engine-launch.ts`) and waits up to 180 s for the local API. It adds `summer-preview` to `<this folder>/.claude/launch.json` (`core/preview/launch-config.ts`; not in the home folder; `--no-launch-json` skips it) and ends with the preview URL. A folder with `project.godot` is just opened. Every failure has a code in the usage line (`download`, `disk_space`, `template`, `not_empty`, `other_project`, `timeout`, ...). |
| `summer create <template> [name] [--keep-git]` | Scaffold from a pinned (or built-in) template; writes `.summer/project.json`, and AGENTS.md plus a CLAUDE.md that holds `@AGENTS.md` (`src/project-memory/agent-instructions.ts`; the five commands come from the `summer-cli` skill's project-commands list). An existing AGENTS.md or CLAUDE.md gets one marked Summer block instead; later runs update only that block. |
| `summer list templates \| projects [--json]` | Browse the template registry / local projects. |
| `summer memory [show <file>]` | Inspect `.summer/` project memory. |
| `summer skills list \| info <name> \| install [name] [--all \| --recommended \| --assets] [--stable-only] [--agent <a>] [--scope user\|project] [--force] [--no-commands]` | Skill installer over `skills-registry.json`. Bulk installs take every `stable` and `preview` skill (`deprecated` only by name); `--stable-only` skips preview; `--assets` takes only the asset skills (`isAssetSkill`: the generation skills plus `summer-assets`, each with a "Without Summer Engine" section) and no Claude Code commands; `--no-commands` leaves the Claude Code commands out too (`setup --cli`); `skills list` tags them `[preview]`. |
| `summer mcp [--project <path> \| --instance <id>] [--profile <p>] [--toolsets <list>] [--surface v4\|v3]` | Start the MCP server (stdio). `--surface` / `SUMMER_SURFACE`: `v4` (default) lists the engine tools, `summer_docs_search`, `summer_docs_read`, `summer_search` and `summer_call` (the operation catalog, `src/mcp/ops-surface.ts`) plus the hosted v4 direct tools; `v3` serves the 3.x tools. `--profile` / `SUMMER_PROFILE`: `full` (default, every tool), `engine` (core, assets, engine, ship; stays within the per-request tool cap of VS Code Copilot, which is 128), `assets` (core, assets, Tool Factory; no engine tools). `--toolsets` / `SUMMER_TOOLSETS` adds toolsets (alone: core plus those). Unknown names are ignored with one stderr line. `summer mcp setup <agent>` is a deprecated alias of `summer setup`. |
| `summer setup [agent] [--yes] [--force] [--recommended] [--stable-only] [--scope …] [--channel <dist-tag>] [--local-dev] [--runtime <node> --package-dir <dir>] [--json]`, `summer setup --detect [--json]` | MCP config + all skills (preview included; `--stable-only` skips them) + doctor, one shot, idempotent. `--channel <dist-tag or exact version>` (or `SUMMER_CHANNEL`) picks what the entry runs (`npx -y summer-engine@<channel> mcp`). Default `latest`; a CLI newer than npm `latest` writes `next` only when `next` is this exact version, else this exact version (`summer-engine@4.0.0`), and a build that is not on npm writes `latest` with a note to use `--local-dev`. It never writes a tag that resolves to an older release than the CLI that ran setup. `--local-dev` (or `SUMMER_DEV=1`) points the agent at this checkout's `dist/bin/summer.js` instead of `npx summer-engine@latest`. For agents with `remoteMcp` in `agent-table.ts` (every agent whose OAuth redirect api.summer.games accepts) it also adds the remote `summer-games` server (`https://mcp.summer.games/mcp`) to the same file, unless an entry with that URL already exists under any name; the agent does the OAuth sign-in itself, so no credential is written. `--no-games` skips it. `--profile <p>` writes `SUMMER_PROFILE` into the entry (`vscode-copilot` defaults to `engine`); `--assets-only` = the `assets` profile, `skills install --assets`, no Summer Games. Run with `--yes` inside a project (`findSetupProjectRoot`: `project.godot` at or above the working directory, no higher than the git top level, never home), it adds the project's AGENTS.md and CLAUDE.md the same way `summer create` does; without `--yes` it plans them, and `--no-project-files` or `--assets-only` leaves the project alone. `--cli` (alias `--no-mcp`): the skills (the asset skills with `--assets-only`) and no MCP entry, no Summer Games, no Claude Code slash commands; it refuses `--print`, `--profile`, `--local-dev` and `--channel`, and the agents `cliSetupRefusal` in `agent-table.ts` names (no skills folder, Gemini CLI, rule-file agents), and warns when the agent's file still lists `summer-engine` in any shape. Doctor's skills refresh adds `--cli` for an agent whose file lists no `summer-engine` and that `--cli` can set up. `--runtime <node> --package-dir <dir>` (both, both must exist; for installers that ship their own Node.js) writes `<node> <dir>/dist/bin/summer.js mcp` in every file format; doctor's refresh keeps that shape. `--json` adds `steps`: `mcp_entry`, `summer_games`, `skills`, `project_files` and `doctor`, each `{ok, status, error: {code, message}}`; a failed step does not stop the others, and any failure exits 1 (an error before the steps prints `{ok: false, error}`). `--detect` reads only: every agent in `agent-table.ts` with `installed`, `programFound`, `detectedBy` (bins on PATH and the usual install folders, app bundles, folders, VS Code extensions; the per-agent `detect` field), `configPath` and `mcpEntry` (`src/installer/agent-detect.ts`). |
| `summer doctor [--json]` | Checks: `node-version`, `cli-version`, `cli-version-current`, `skills-version-stale`, `login`, `store-access` (with a store sign-in: asks the store for your games through the hosted MCP and shows its answer), `engine-install`, `local-api`, `project-memory`, `mcp-boot`, `mcp-tools-list`. `ok` = no failures. |
| `summer debug [issue…]` | Support-ready Markdown debug report. |
| `summer plan <goal…>` | Route a goal to skills / tools / gates. |
| `summer config [get \| set \| unset \| path]` | Shared non-secret `~/.summer/config.json` (`gateway.url`, …). |
| `summer events [--follow] [--kinds <csv>] [--since <seq>] [--limit <n>] [--json]` | Engine events channel: the newest events, or `--follow` to stream them live (long-poll over `/api/events/poll`, one line per event, JSON when piped). Builds without the channel print a structured `engine_lacks_events` receipt and exit 1. |
| `summer preview [--port <n>] [--no-launch-json] [--open] [--json]` | The running game in a local web page an agent's own browser can see (`src/core/preview/`): it serves `http://127.0.0.1:5199` (the next free port when that one is taken; `--port` asks for exactly one; a `PORT` variable is not read), shows the running game's frames, or the editor viewport when no game runs, with the project and scene names and a status line ("Editor not running: run npx -y summer-engine@latest dev", "Game not running: showing the editor"). It shows only the editor of the project it was started for: the project at or above the folder it runs in, else the one project below it (several below is an error). The pace comes from the measured capture time: up to 5 frames a second while the editor view changes and 2 once it stops changing; a game frame about every 20 s, because reading one stalls the game. `/api/frame?fresh=1`, the page's first frame and its Refresh button capture now (at most one every 2 s), and the header says how old a game frame is. A hidden tab asks for nothing. While the game runs, keys and clicks on the frame go to it (`SimulateInputScript`); key releases always go through. The page makes no request off 127.0.0.1 and holds no token; the API refuses requests another site makes (`Sec-Fetch-Site`). It adds a `summer-preview` entry to `.claude/launch.json` in the folder it runs in (where Claude Code Desktop reads it when the session starts there; the entry carries `cwd` when the project is below), so the Browser pane starts the preview and checks it after each edit; other entries, a person's `autoVerify`, the file's indentation and an existing `summer-preview` entry stay as they are, and a file with comments is left alone (`writeClaudeLaunchConfig`, also for `summer dev`). The Codex app's docs describe no such file: open the URL in its in-app browser. |
| `summer tool [name] [--args '<json>'] [--list]` | Run any tool with the MCP implementation; `--list` prints every slug. With a store sign-in it also lists and runs the hosted store and publishing tools (`summer tool summer_store_list_games`). |
| `summer <area> <action> [--<field> <value> …] [--input '<json>'] [--dry-run] [--idempotency-key <k>] [--wait] [--json]` | Run one operation of the catalog (`src/cli/commands/ops.ts`). Kebab-case actions and flags (`summer assets generate-image --aspect-ratio 16:9`); flags are typed from the input schema; objects go in `--input`. Engine and local operations run in this process; cloud operations run on the hosted server with the person's sign-in. `--wait` follows a job or an approval to the end; `--json` prints only the answer; exit 0 for any `ok` answer, 1 for an error. |
| `summer whoami` | The signed-in account (`whoami`). |
| `summer ops search <words…>` / `summer ops describe <op>` | Find operations, local and cloud, with their exact input; print one operation's wire form. Signed out, cloud operations come from the shipped catalog (`registry/operations/public-catalog.json`), marked needs sign-in. |
| `summer mcp --toolsets legacy` | Also list every 3.x tool name (or `SUMMER_LEGACY_TOOLS=on`). It is on by itself while the installed skills are older than 4.0; `SUMMER_LEGACY_TOOLS=off` turns it off. The first `summer mcp` start after an upgrade refreshes the installed Summer skill folders first (`src/installer/skills-refresh.ts`), so upgraded skill folders do not turn it on. |
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

Templates (`summer list templates`, `summer create <template> [name]`) resolve only through the pin manifests in `library/templates/` — how resolution, digest verification, and `.summer/project.json` work is documented in [`library/templates/README.md`](../library/templates/README.md).

---

## One definition, every surface

Nothing is registered twice. Every skill, template, reference, and tool descriptor is a `library/<kind>/<slug>/resource.yaml`; `scripts/generate-registry` compiles them into `registry/generated/` (the searchable `index.json`, `counts.json`, `aliases.json`, `skills-registry.json`, `templates-registry.json`) and applies the agent manifests (`.claude-plugin/plugin.json`, `gemini-extension.json`, …) to the repo root. Those root dot-files are build artifacts — edit the source, rerun the compiler, commit both.

CI (`--check` + `npm test`) fails on: schema violations, duplicate IDs/aliases, dangling `related` links, capability-lint violations, regenerated output differing from what's committed, manifest versions ≠ `package.json`, and numeric "N tools"/"N skills" claims in `README.md`/`AGENTS.md`/`GEMINI.md` that contradict `counts.json`. **Don't write literal tool/skill counts in those files** — phrase around them or the guard will (correctly) fail your PR.

### Adding a library entry

1. Create `library/<kind>/<slug>/resource.yaml` per the schema in `registry/schemas/` (skills also get `SKILL.md`; templates are pin manifests — see [`library/templates/README.md`](../library/templates/README.md) for the commit + tree-digest rules).
2. `npm run validate:library` — schema + capability lint (no URLs off the allowlist, no install commands, no credential references).
3. `node scripts/generate-registry/cli.ts` — regenerate; commit the generated diff together with the entry. It also writes each skill's "From a shell" section at the end of its SKILL.md: the `summer` command for every MCP tool and operation the skill names, from the operation catalog (`scripts/validate-library/shell-commands.ts`). Never edit that section by hand; `validate:library` fails when it is stale.
4. `npm run eval:routing` — if your entry serves one of the known gap queries, update `evals/routing/queries.yaml` + baseline in the same PR.

IDs (`<kind>/<slug>`) are permanent. Renaming means a new ID plus an `aliases` entry on the new resource — never a silent move.

### How skills reference each other

Inside `library/skills/**/SKILL.md` and `library/references/**/*.md`, refer to another skill by its **bare slug** — the `library/skills/<slug>` directory name, which is also the `name:` in its SKILL.md frontmatter and the `<slug>` half of its `skill/<slug>` id. Write it as inline code or as an explicit instruction: `` `vfx-fire` ``, "use the `design-mechanic` skill", `Skill: gdscript-patterns`, `/play`.

Why the bare slug and not a namespaced form: skills reach a host along two paths that name them differently.

- `summer setup <agent>` / `summer skills install` (the canonical path) copies each skill into the host's user-skill directory (`~/.claude/skills/<slug>/`, and the equivalent for Cursor, Codex, Gemini, …). Hosts expose those as plain user skills — Claude Code as `/<slug>` — and there is no `summer:` namespace.
- The plugin-marketplace path (`.claude-plugin/plugin.json`, generated from `integrations/claude`) loads the same directories as plugin skills, which Claude Code exposes as `/summer:<slug>`.

Hosts match on the skill name in both cases, so the bare slug resolves under either install; `summer:<slug>` resolves only under the second. Never use the v2 forms `summer:<category>/<name>`, `<category>/<name>`, or `skills/<category>/<name>` — categories are gone (`library/skills/` is flat) and the VFX recipes are `vfx-<effect>` (`vfx-fire`, `vfx-smoke`, …). Shared documents are named by their library id, never by a relative path: `summer setup` copies each skill folder alone, so `../../references/<slug>/<slug>.md` resolves in the repo and the plugin but not in the default install. Write `` `summer_read_library` id `reference/<slug>` `` for a reference, the bare slug for another skill, and `<entry id>/<path>` for a file another entry ships (`skill/character-movement/references/movement-3d.md`); links inside the skill's own folder (`references/…`) are fine. `validate:library` rejects any path that climbs out of the skill folder. Legacy names are *recorded* in `registry/generated/aliases.json` but nothing resolves them at runtime yet (only `summer create` resolves legacy template names) — new prose must use the bare slug.

### Adding an MCP tool

Today a tool is four edits, kept in step by tests:

1. Register it in the relevant `src/mcp/tools/*.ts` (`server.registerTool` with a zod raw shape) — or, for engine-free logic, implement in `src/core/capabilities/` and register there.
2. Add a dispatch entry in `src/core/capabilities/tool-dispatch.ts` so `summer tool <slug>` reaches the same function with the same zod validation.
3. Add `library/tools/<slug>/resource.yaml` (descriptor: `implementation.module/export`, `surfaces.mcp.tool_name` + `remote`, `input_schema`, the five `authority` booleans).
4. `npm run generate:registry`; then `npm test` — `descriptor-parity.test.ts` fails if the zod shape and `input_schema` disagree, `tool-dispatch.test.ts` if the CLI face is missing, and the validator if the descriptor names a module/export/tool that does not exist.
5. An engine tool is also an operation of the catalog (`engine.<name>`): add its row to `registry/operations/legacy-names.json` (`contract.test.ts` fails without it), its title, a summary of 300 characters or fewer, its effect and one example to `src/core/ops/engine.ts` (`engine.test.ts` checks them against the contract and the descriptor), and its guide: `npm run generate:tool-guides && npm run generate:registry` writes the tool's MCP description to `library/tools/<slug>/GUIDE.md`, which `summer_read_library tool/<slug>` returns and the v4 surface points at (`tool-guides.test.ts` fails when they drift).
6. Check its place in `src/mcp/tool-surface.ts`: a local tool joins the `engine` toolset unless a list there names it (`core`, `assets`, `ship`, `ui`; `summer_app_*` is `apps`), its MCP annotations come from `authority` plus the refinement sets there (a render that only writes an image is a read; a change that only adds is not destructive), and a tool with large text output can join `OUTPUT_CAPS` (then its descriptor lists `maxCharacters`). `tool-surface.test.ts` fails on a tool without annotations.

### The shipped operation catalog

`registry/operations/public-catalog.json` is a byte copy of the hosted server's public catalog (PublicSummerEngine `src/lib/ops/public-catalog.json`), so search and describe list every cloud operation with no sign-in. `npm run sync:catalog` copies it from PublicSummerEngine main (with `gh`, or `-- --from <checkout>`); `npm run sync:catalog -- --check` fails when the copy differs, and runs before every release. `public-catalog.test.ts` fails when the copy and `legacy-names.json` disagree. Ranking is `src/core/ops/search.ts`; `search.test.ts` holds the plain-English phrases each operation must win.

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
- **Shared `~/.summer/` store** (`src/core/store.ts`): `0700` dir, `0600` files, atomic replacement, symlink refusal. Filenames (`api-token`, `auth-token`, `oauth-token` and `oauth-client` (the store sign-in, `src/core/oauth.ts`), `creator-token` (legacy; only removed, by logout), `user.json`, `config.json`, `credential-metadata.json`, `creator-audit.jsonl`) are shared with the desktop engine — do not rename them.
- **Ops values are engine variant strings** (`"Vector3(0, 10, 0)"`, `"Color(1, 0.9, 0.8)"`), never JSON objects. This crosses both repos; coordinate changes.

No environment variables are required for normal use. Optional: `SUMMER_GATEWAY_URL` (gateway override; `gateway.url` in `~/.summer/config.json` does the same for every gateway caller), `SUMMER_TOKEN` (auth token override for CI/cloud sessions), `SUMMER_CHANNEL` (npm dist-tag or exact version `summer setup` writes into the agent's MCP entry — same as `--channel`), `SUMMER_BIN` (engine executable to launch/probe — the flag form is `summer run --bin`; on macOS the in-bundle `…/Summer.app/Contents/MacOS/Summer`, never the `.app`), `SUMMER_ENGINE_BINARY` (alias of `SUMMER_BIN`), `SUMMER_ENGINE_PROJECT` / `SUMMER_ENGINE_INSTANCE_ID` (pin the editor for the CLI face, same names `summer mcp` reads; without them the CLI uses the global api-token pointer, then the instance registry), `SUMMER_MCP_DEBUG=1` (structured stderr line per tool call), `SUMMER_NO_TELEMETRY=1` / `DO_NOT_TRACK=1` (also `true`, `yes` or `on`; disable the feedback mailbox, the agent-app and tool headers on requests to Summer's servers, and the signed-in usage lines: one per MCP session and one per tool call, with tool name, success or its error code, duration and host app name, `src/core/telemetry.ts`; and one per CLI command, with the command or operation name, success or error code, duration, version and agent app, sent by a detached child at exit, `src/core/cli-usage.ts`), `SUMMER_AGENT_HOST` (override the agent app id sent as `X-Summer-Agent-Host` on requests to Summer's servers; otherwise the MCP handshake's clientInfo, then the agent's environment; `src/core/agent-host.ts`), `SUMMER_SURFACE=v3` (the 3.x tools in `summer mcp`, and no `summer <area> <action>` commands; default `v4`; `src/core/tool-profiles.ts`), `SUMMER_PROFILE` / `SUMMER_TOOLSETS` (the `summer mcp --profile` / `--toolsets` tool selection; `src/core/tool-profiles.ts`, `src/mcp/tool-surface.ts`), `SUMMER_LEGACY_TOOLS=on|off` (the v4 surface's legacy toolset, which lists every 3.x tool name again: on while installed Summer skills are older than 4.0, or with `--toolsets legacy`; `src/mcp/legacy-toolset.ts`), `SUMMER_CAPABILITY_PREFLIGHT=off` (send every call even when the engine lacks the op), `SUMMER_HEADLESS_ROUTING=1` (headless worker routing — needs an engine build with worker mode), `SUMMER_AUTO_LAUNCH=0` (the MCP does not open the session's project in Summer Engine when no editor runs; `core/engine-self-start.ts`; an explicit `projects.open_local` still opens; the test setup sets it so no test launches an installed engine), `SUMMER_TRAJECTORY_DIR` (opt-in per-tool-call JSONL capture, redacted), `SUMMER_TRAJECTORY_EVAL=1` (with the directory set: additionally writes an unredacted `trajectory.full.jsonl` with a bounded result summary — for eval fixtures only, never a default; `summer_get_project_context` reports `trajectory_eval_mode: true` while it is on), `SUMMER_PRE_COMMIT_DOCTOR=1` (the opt-in pre-commit hook), `SUMMER_EMBED_URL` (embedding endpoint for semantic library search and `generate-registry --embed`, default `<gateway>/api/mcp/embed`; `off` forces lexical-only search), `SUMMER_FETCH_TIMEOUT_S` (seconds before `summer create` kills a hanging template fetch; default 120), `SUMMER_ENGINE_URL` (artifact URL `summer install` downloads instead of the release feed: a `.tar.gz`, `.zip`, or raw executable), `SUMMER_SKILLS_DIR` (directory `summer skills install` / `summer setup` write skills into, overriding the per-agent default; for Cursor, Windsurf and Cline it is the rules directory), `SUMMER_ENGINE_REPO` (tests only, above), `SUMMER_E2E=1` (tests only: opt into the network test that fetches a real pinned template repository), `SUMMER_EDITOR_BIN` (outcome evals: the editor binary to boot).

---

## Working in a shared worktree (multi-agent)

When more than one agent, or an agent and a human, edit the same worktree:

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

---

## Related docs

- v2 → v3: what moved and why nothing breaks — [`MIGRATION-V2-V3.md`](MIGRATION-V2-V3.md)
- The rules — [`design/CONTRACT.md`](design/CONTRACT.md) · the reasoning — [`design/DECISIONS.md`](design/DECISIONS.md)
- Evals and their CI gates — [`../evals/README.md`](../evals/README.md)
- Test an unpublished build end to end (local-dev setup, engine-less checks, expected failures, gates) — [`TESTING.md`](TESTING.md)
- Architecture tour — [`OVERVIEW.md`](OVERVIEW.md)
