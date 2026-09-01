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
| npm package | `summer-engine` | What users install. Never recommend `summer-cli` (an unrelated, inactive package we do not own). |
| GitHub repo | `summerengine/summer` | Renamed from `SummerEngine/summer-engine-agent`; redirects hold. |
| Binary | `summer` | The CLI entry point. |
| Copy rule | — | "Summer" for the system, "`summer-engine` npm package" for the package, "Summer Engine app" for the closed desktop engine. |

---

## Repository layout

```
src/
├── bin/              # entry point — composes cli + mcp
├── cli/              # commander wiring ONLY (src/cli/commands/*) — no business logic
├── mcp/              # MCP server + tool adapters ONLY (src/mcp/tools/*) — no business logic
├── core/             # shared implementations: auth, config, engine connection, store,
│                     #   capabilities/ (logic shared by CLI and MCP)
├── project-memory/   # .summer/ read/write, cloud sync locks
└── installer/        # agent detection, per-client config writing, version checks

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

The import direction is a tested invariant (`src/import-direction.test.ts`): `cli/` and `mcp/` are thin surfaces over `core/`; logic lives in `core/` (notably `core/capabilities/`) so every capability exists once and is exposed twice.

---

## Commands

```bash
npm install
npm run build              # tsc -> dist/
npm run dev                # tsc --watch
npm test                   # vitest + validate:library
npm run validate:library   # schema validation + capability lint over library/
npm run eval:routing       # routing eval: real asks vs the index, gated on baseline.json
node scripts/generate-registry/cli.ts          # regenerate registry/generated/ + root manifests
node scripts/generate-registry/cli.ts --check  # CI parity gate: fails on any drift, writes nothing
bash scripts/smoke-test.sh # CLI smoke test
```

The registry and validation scripts run TypeScript natively and need **Node >= 22.18**; the published package itself supports users on Node 18+.

### Test the CLI and MCP locally

```bash
node dist/bin/summer.js status
node dist/bin/summer.js list templates
node dist/bin/summer.js mcp                       # requires a running engine
node dist/bin/summer.js mcp --project /abs/path   # explicit selectors for hosts
node dist/bin/summer.js mcp --instance <id>       # launched outside a project dir
```

To point an agent at the local build, set its MCP config command to `node <abs-path>/dist/bin/summer.js mcp`.

---

## One definition, every surface

Nothing is registered twice. Every skill, template, reference, and tool descriptor is a `library/<kind>/<slug>/resource.yaml`; `scripts/generate-registry` compiles them into `registry/generated/` (the searchable `index.json`, `counts.json`, `aliases.json`, `skills-registry.json`) and applies the agent manifests (`.claude-plugin/plugin.json`, `gemini-extension.json`, …) to the repo root. Those root dot-files are build artifacts — edit the source, rerun the compiler, commit both.

CI (`--check` + `npm test`) fails on: schema violations, duplicate IDs/aliases, dangling `related` links, capability-lint violations, regenerated output differing from what's committed, manifest versions ≠ `package.json`, and numeric "N tools"/"N skills" claims in `README.md`/`AGENTS.md`/`GEMINI.md` that contradict `counts.json`. **Don't write literal tool/skill counts in those files** — phrase around them or the guard will (correctly) fail your PR.

### Adding a library entry

1. Create `library/<kind>/<slug>/resource.yaml` per the schema in `registry/schemas/` (skills also get `SKILL.md`; templates are pin manifests — see [`library/templates/README.md`](../library/templates/README.md) for the commit + tree-digest rules).
2. `npm run validate:library` — schema + capability lint (no URLs off the allowlist, no install commands, no credential references).
3. `node scripts/generate-registry/cli.ts` — regenerate; commit the generated diff together with the entry.
4. `npm run eval:routing` — if your entry serves one of the known gap queries, update `evals/routing/queries.yaml` + baseline in the same PR.

IDs (`<kind>/<slug>`) are permanent. Renaming means a new ID plus an `aliases` entry on the new resource — never a silent move.

### Adding an MCP tool

The implementation lives in `src/` (`src/mcp/tools/` adapter over `src/core/`), the descriptor in `library/tools/`. Mechanics of the engine side: [`ADDING_TOOLS.md`](ADDING_TOOLS.md).

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
- **Shared `~/.summer/` store** (`src/core/store.ts`): `0700` dir, `0600` files, atomic replacement, symlink refusal. Filenames (`api-token`, `auth-token`, `cloud-token`, `creator-token`, `user.json`, `config.json`, `credential-metadata.json`, `creator-audit.jsonl`) are shared with the desktop engine — do not rename them.
- **Ops values are engine variant strings** (`"Vector3(0, 10, 0)"`, `"Color(1, 0.9, 0.8)"`), never JSON objects. This crosses both repos; coordinate changes.

No environment variables are required for normal use. `SUMMER_GATEWAY_URL` is an optional gateway-development override; `SUMMER_MCP_DEBUG=1` logs a structured stderr line per tool call; `SUMMER_NO_TELEMETRY=1` / `DO_NOT_TRACK` disable the library feedback mailbox.

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
- Engine-side tool mechanics — [`ADDING_TOOLS.md`](ADDING_TOOLS.md) · architecture tour — [`OVERVIEW.md`](OVERVIEW.md)
