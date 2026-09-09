# Summer v3 Foundation — The Contract

**Normative spec. Everything in the v3 build is generated from or validated against this document. Changing this file after migration is a breaking change; get sign-off.**

Locked 2026-09-01 by Mathias + Claude (orchestrator) + Codex (reviewer), after a repo audit and a four-agent design board. Reasoning lives in `docs/design/DECISIONS.md`; this file is the rules.

Truth pass 2026-09-02: every rule below was re-checked against the code on `v3-foundation`. Where the code does not yet do what the design intends, the rule is marked **planned, not implemented** rather than stated as fact. What is verified and what is not: `STATUS.md`.

---

## 1. What Summer is

Summer is the open-source game-development system for AI agents. One repo (`SummerEngine/summer`), one npm package (`summer-engine`), one binary (`summer`). It combines:

1. **The Library** — the largest game-development knowledge base for agents (six kinds, below).
2. **Live tools** for operating Summer Engine (MCP + CLI, same implementations).
3. **Project memory** (`.summer/`) so any agent can resume any project.
4. **Evidence** that entries and built games actually work (evals, verified outcomes).

Summer is agent-neutral: Codex, Claude, Cursor, Gemini, OpenCode, and future agents all consume the same library through generated integrations.

## 2. Repository layout (top two levels, fixed)

```
summer/
├── README.md            # humans + the one-paste install prompt
├── AGENTS.md            # fresh-agent router: trust, understand, navigate, work
├── package.json
├── src/                 # the Summer software (TypeScript)
│   ├── bin/             # entry point — composes cli + mcp
│   ├── core/            # config, auth, engine connection, store, feedback/, headless/, capabilities/
│   ├── cli/             # commander wiring (src/cli/commands/*) + capabilities/tool-dispatch.ts as the `summer tool` face
│   ├── mcp/             # MCP server + src/mcp/tools/*.ts — today the home of most tool implementations (see §3)
│   ├── lib/             # registry helpers shared with scripts/ (capability lint)
│   ├── project-memory/  # .summer/ read/write (project.json, memory index)
│   └── installer/       # agent detection, config writing, skill install, version checks
├── library/             # the Library — content, agent-neutral
│   ├── tools/<slug>/    # DESCRIPTORS only (resource.yaml); `implementation.module` names the file that implements it
│   ├── skills/<slug>/   # resource.yaml + SKILL.md (+ references/)
│   ├── examples/<slug>/ # resource.yaml + README.md + project/ + evidence/
│   ├── templates/<slug>/# resource.yaml (pin manifest; code lives in satellite repos)
│   ├── collections/<slug>/ # resource.yaml + collection.yaml + preview/ + style/ + presets/
│   └── references/<slug>/  # resource.yaml + body markdown
├── registry/
│   ├── schemas/         # JSON Schemas for resource.yaml, per kind
│   └── generated/       # BUILD ARTIFACT. Never hand-edited. CI enforces parity.
├── evals/               # routing/ skills/ examples/ tools/ templates/ collections/ end-to-end/
├── integrations/        # per-agent adapters (claude/ codex/ cursor/ gemini/ opencode/ factory/)
├── docs/
└── scripts/             # generate-registry/ validate-library/ build-integrations/
```

Rules:
- **Flat per kind.** `library/skills/<slug>/` — never nested category folders. Categories are metadata (facets), not directories.
- **Folders store resources; the registry teaches agents what they mean.** No agent is expected to navigate `library/` by hand.
- **Media out of git.** Screenshots ≤ 200KB each are allowed as evidence; anything larger (video, audio, models) is referenced by URL + sha256 in resource.yaml.
- Lifecycle stages (build / launch / grow / support) are **facets**, never folders. Summer Games / Store / analytics / growth capability arrives as new entries, not new structure.
- **Import direction** is a tested invariant (`src/import-direction.test.ts`): `cli/` never imports `mcp/`; `bin/` composes the two. The layering *aspiration* — every implementation in `core/`, `cli/` and `mcp/` as thin adapters — is not the state of the code today; §3 says what is.

## 3. The six kinds

| Kind | One line | Body |
|---|---|---|
| `tool` | What the agent can do (executable capability) | descriptor only; implementation in `src/` at the path named by `implementation.module` (today mostly `src/mcp/tools/*.ts`; see the tool rule below) |
| `skill` | How to do something well (procedure + judgment) | `SKILL.md` (open Agent Skills format) |
| `example` | A proven, working instance to study/reuse | real code + explanation + **required evidence** |
| `template` | Working foundation that becomes the user's project | pin manifest → satellite repo at exact commit |
| `collection` | Curated compatible creative materials | manifest of immutable asset refs + style rules + presets |
| `reference` | Facts and technical knowledge (passive) | markdown body |

Disambiguation rule: a **skill explains the process**; an **example is a finished working instance**. If one folder contains both, split it and link them via `related`.

**Tool rule — one behavior, two faces, parity-tested.** Every tool has exactly one behavior and is reachable two ways: as an MCP tool (`surfaces.mcp.tool_name`) and from the CLI as `summer tool <slug> --args '<json>'` (plus a dedicated command for the five that declare `surfaces.cli.command`). How that is implemented today:

- most tools are registered in `src/mcp/tools/*.ts` with hand-written zod shapes; a handful live in `src/core/capabilities/` and `src/core/feedback/` (exact split: `docs/DEVELOPMENT.md`).
- `src/core/capabilities/tool-dispatch.ts` is the CLI face: a dispatch table that validates `--args` with the same zod schemas and calls into the same functions. It is a mirror, not a second implementation of behavior, but it is a second registration.
- The descriptor's `input_schema` is **not** the source the zod is derived from. Instead `src/mcp/tools/descriptor-parity.test.ts` converts each registered zod shape to a structural JSON-Schema form and fails the build when it disagrees with `input_schema` (types, required, property names, enums). `scripts/validate-library` additionally checks that `implementation.module` exists, that `surfaces.mcp.tool_name` is a real registration, and that `input_schema` is a legal schema.

The invariant the contract holds is the parity test, not the folder. Folding the mirrors into a single shared-capabilities registration is scheduled as the post-hardening consolidation pass (REVIEW-2026-09-02.md, P2; tracked in STATUS.md), not claimed here.

## 4. Identity

- **ID** = `<kind>/<slug>`, slug is kebab-case, globally unique within kind. Official namespace is implicit. The schema also accepts a namespaced form `"<publisher>/<kind>/<slug>"` for **side-loaded external resources only** (§11); the official `library/` tree must use bare ids — a namespaced id in `library/` is a validation error.
- **IDs are permanent.** Renames create a new ID plus an `aliases` entry on the new resource. The registry rejects duplicate IDs and duplicate aliases.
- **`version`** — semver, bumped by authors on content change.
- **`content_hash`** — sha256 of the resource dir (computed by the compiler, stored only in generated output). Feedback, stats, and evidence attribute to `id@content_hash`, so a fixed entry starts a clean record.

## 5. resource.yaml (the universal descriptor)

Required for every resource, validated by `registry/schemas/`:

```yaml
id: skill/create-environment-kit     # permanent
kind: skill                          # tool|skill|example|template|collection|reference
version: 2.0.0
summary: One sentence, ≤160 chars, plain language.
use_when:
  - building a coherent reusable environment set
do_not_use_when:                     # optional but strongly encouraged
  - importing one finished prop
facets:
  lifecycle: [build]                 # build|launch|grow|support
  domains: [world, level-design, 3d] # closed vocabulary: registry/schemas/domains.json (60 tokens); unknown token = validation error
  modalities: [scenes, assets]
compatibility:
  engine: ">=4.6"
  toolkit: ">=3.0.0"
related:                             # IDs only, checked by the compiler
  skills: []
  examples: [example/stylized-forest-scene]
  collections: [collection/fantasy-forest]
  references: []
source: official                      # official | <publisher>
license: MIT
status: stable                        # stable | preview | deprecated
aliases:                              # legacy paths/names this resource replaces
  - skills/level-design/create-environment-kit
lint_exceptions: [rule-id]           # optional; capability-lint rules this resource is allowed to trip —
lint_exception_reason: "why"          #   REQUIRED whenever lint_exceptions is present (schema-enforced)
evidence:                             # REQUIRED for example; optional otherwise
  engine_version: "4.6.1"
  verified_at: 2026-09-01
  checks: [runs, screenshot]
  media:
    - path: evidence/final.png        # in-repo if ≤200KB
    - url: https://…                  # else URL + hash
      sha256: …
```

Per-kind extensions (defined in the per-kind schemas):
- **tool** (`tool.schema.json`; required: `implementation`, `surfaces`, `input_schema`, `authority`):
  - `implementation` — `module` + `export`: the `src/` file and export that implements the tool (validated to exist).
  - `surfaces` — `mcp: {tool_name, remote}` (both **required**; `remote: true` = needs no local engine, eligible for the hosted stateless endpoint below) and/or `cli: {command}` (only the five tools with a dedicated command declare it; every tool is also reachable as `summer tool <slug>`).
  - `input_schema` — JSON Schema, what agents and the index read. Kept in agreement with the registered zod by the parity test (§3), not derived from it.
  - `authority` — the five booleans `filesystem`, `editor_mutation`, `network`, `credentials`, `publish`, all required. `filesystem: true` whenever the tool writes anything under the project or `~/.summer/` (screenshots, generated assets, publish audit rows included).
  - `evidence_checks` — **optional** list of check names (42 of 86 tools carry it today).

MCP protocol posture: the local server stays stdio (unchanged in MCP v2, spec 2026-07-28); the SDK is kept on the v2-supporting major (`@modelcontextprotocol/sdk` ^1.30); no elicitation patterns. Engine-free tools (`mcp.remote: true`) may additionally be served by a hosted stateless Streamable-HTTP endpoint (`summerengine.com/mcp`) — a fast-follow, not built (ROADMAP §3.1).
- **skill** (`skill.schema.json`): `recommended` (boolean, omitted = false) — the subset installed by `summer skills install --recommended` / `summer setup --recommended`. Plain `summer setup <agent>` installs **all** skills regardless of this flag.
- **template** (`template.schema.json`): exactly one shape. **Pinned**: `repo`, `commit` (40-hex SHA), `tree_digest` (sha256), optional `default_branch` (informational only — never used for resolution) and `zip` (release-asset URL + sha256). **Built-in**: `builtin: true` and no pin — generated in-process by `summer create`, nothing downloaded. Declaring both or neither is a schema error. Both shapes may carry `systems` (list) and `smoke_test` (eval ref).
- **collection** (`collection.schema.json`): `items` (asset refs: `slug` + `license` required; per-item `sha256` required for `status: stable`), `style` (`rules`), `presets` (named subsets), `recommended` (skill/template IDs). Collections carry **no executable instructions** — they may only *reference* trusted skills by ID. No collection ships yet (`counts.json`: 0).

## 6. The registry compiler (drift is a build failure)

`scripts/generate-registry` reads every `library/**/resource.yaml` and emits into `registry/generated/`:

1. `index.json` — the searchable catalog: id, kind, version, content_hash, summary, use_when, facets, compatibility, related, status. Tool records additionally carry `mcp_tool_name`, `remote`, `authority`, and `cli_command` (when a dedicated command exists) so an index hit can be turned into a call. This is what agents (and later the gateway API) search.
2. Every agent integration: `.claude-plugin/plugin.json` + `marketplace.json`, `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json`, `.factory-plugin/plugin.json`, `gemini-extension.json`, `.mcp.json`, OpenCode plugin data — all skill lists, counts, and version fields stamped from `package.json`.
3. `skills-registry.json` — the data behind `summer skills list/install/info` and `summer setup` (replaced the hand-written `SKILL_REGISTRY`).
4. `templates-registry.json` — the only thing `summer create` / `summer list templates` read (§7).
5. `counts.json` — canonical numbers (tools, skills, …) for README badges and the website (`toolsNumber`).
6. `aliases.json` — legacy path/name → ID map. **Generated; runtime resolution planned.** Nothing in `src/` reads this file yet. Today legacy *template* names resolve through the `aliases` compiled into `templates-registry.json`; legacy tool and skill names do not resolve at runtime (§12).

Not generated: MCP tool registrations and CLI dispatch are written in `src/` and checked against the descriptors by the parity test and the validator (§3).

**Invariant: no capability, skill, template, collection, or integration is manually registered twice** — with the one documented exception of the tool-dispatch mirror in §3, which is parity-tested until it is folded. CI (`scripts/validate-library` + `npm test` + `generate-registry --check`) fails on: schema violation; duplicate ID/alias; `related` pointing at a missing ID; regenerated output differing from committed `registry/generated/` and applied root manifests (parity gate); manifest version fields ≠ `package.json`; numeric tool/skill count claims in `README.md`, `AGENTS.md`, `GEMINI.md`, `CLAUDE.md`, `library/references/**`, `integrations/**`, `.opencode/**` ≠ `counts.json`; descriptor ↔ zod shape drift; descriptors naming a module, export, or MCP tool that does not exist; capability-lint violations (below).

**Capability lint (every resource, every PR, human- or agent-authored):** no URLs outside the committed allowlist; no install commands or pipe-to-shell; no credential/env references; no encoded blobs; no invisible/bidi unicode; no imperative text steering agents on non-Summer behavior. Entries can never reach the network, credentials, or the package manager.

## 7. Templates: pinned, always

`summer create <slug> [name]` resolves through the compiled pin manifests **only** (`registry/generated/templates-registry.json`, built from `library/templates/*/resource.yaml`): `git fetch --depth 1 origin <commit>` — the exact SHA, never a branch — recompute and verify `tree_digest` (mismatch removes the directory and writes nothing), detached checkout, `.git` removed unless `--keep-git`. Built-in templates (`builtin: true`) are generated in-process. Never resolve a default branch at runtime. There is no GitHub-org listing anywhere in the CLI: a template not in `library/templates/` is not installable.

The pin is recorded into the project's `.summer/project.json` (`src/project-memory/project-manifest.ts`, merged into an existing file, other keys preserved):

```json
{
  "template": { "id": "template/2d-platformer", "version": "1.0.0",
                "repo": "https://github.com/SummerEngine/template-2d-platformer",
                "commit": "<40 hex>", "tree_digest": "<64 hex>" },
  "toolkit_version": "<summer-engine package version>",
  "created_at": "<ISO 8601, set once>"
}
```

Built-ins record `"template": { "id", "version", "builtin": true }` instead of a pin. Nothing else writes `project.json` today; collection installs (§11) are not yet recorded.

## 8. Project memory (`.summer/`) — the consumer-side contract

Extends what exists (GameSoul.md, memory tree, locked flags — do not reinvent). What the code reads and writes today (`src/project-memory/`, `summer memory`, `summer_get_project_context`):

```
.summer/
├── project.json      # template pin + toolkit_version + created_at (§7) — written by summer create
├── GameSoul.md       # the game's promise — written by the brainstorm-game skill
├── art-bible.md      # art-direction skill
├── audio-bible.md    # audio-direction skill
├── build-plan.md     # make-game skill
├── voice-cast.md     # legacy casting file (read, no longer written)
├── memory/           # classified tree: casting/ characters/ world/ systems/ decisions/ conflicts/ + index.json
├── mechanics/        # design-mechanic skill, one file per mechanic
├── levels/           # design-level skill
└── npcs/             # design-npc skill
```

**Planned, not implemented** — named by the design, written by nothing yet:

```
├── state.json        # current mission/task state: what's built, verified, next  (ROADMAP §3.2)
├── decisions.ndjson  # append-only decision log
└── receipts/         # verification receipts (playtest passed, screenshot, eval)
```

Until those land, "what's done / verified / next" lives in `build-plan.md` and `memory/decisions/`. The goal stands: a fresh agent entering a project must be able to answer what game this is, what's done, what's verified, what's next, and exactly which library versions were used — without the original conversation. Today it can answer the first and the last from files; the middle three depend on how well the skills kept `build-plan.md` current.

## 9. Agent entry (AGENTS.md is a router, not an encyclopedia)

AGENTS.md serves four jobs for a fresh agent, in order: **trust** (what Summer is, what it will/won't do, telemetry disclosure, license), **understand** (the six kinds in six lines, the loop: search → load → build → verify → remember), **navigate** (search the registry index; never walk folders; how IDs and related links work), **work** (the verification ladder: build → play → screenshot → check diagnostics; `.summer/` conventions; when to report feedback). Everything else is one link deep.

## 10. Feedback (v1 = mailbox)

MCP tool `summer_library_feedback` (`src/mcp/tools/feedback-tools.ts` → `src/core/feedback/client.ts`). The payload — every field, matching `FEEDBACK_FIELDS_SENT` in the client, which is also the text agents are shown:

- `reports[]` — `{entry_id, outcome, note?, deviation?}`; `outcome` ∈ `worked | worked_with_fixes | wrong | outdated | incomplete | did_not_apply | misrouted`; `note` and `deviation` ≤ 280 chars each, about the entry only.
- `engine_version` (required), `agent_model` (required; the agent's self-reported model id, `"unknown"` allowed), `toolkit_version` (this CLI's version), `client` (host app name/version, captured from the MCP handshake), `session_id` (random uuid per MCP server process, never persisted).
- `install_id` — random uuid stored in `~/.summer/`, sent **only when not logged in**; when logged in the Summer account bearer token is sent instead. No hardware, user, or project identity.

Fire-and-forget, 1s timeout, no retry, never blocks; `{recorded: true}` only on a 2xx within the timeout, otherwise `{recorded: false, dropped: true}`. POSTs to `/api/mcp/library-feedback` (web repo) → append-only Postgres table, API-writes only, no anon insert policy. Nothing reads the table into any agent context. `SUMMER_NO_TELEMETRY=1` or `DO_NOT_TRACK=1` → nothing is ever sent. **First-run notice precedes the first event:** the first call ever made on a machine sends nothing and returns `{recorded: false, first_run: true, notice}`; the agent must call again to send.

**Planned, not implemented:** the Tier-1 opt-in longer note (≤1500 chars) — the schema caps at 280 today (ROADMAP §4, Later). Entry `content_hash` attribution is carried inside `entry_id` by the caller; there is no separate field. The full Librarian pipeline (triage → PRs → ranking → automation ladder) is specced in `docs/design/SELF_IMPROVING_LIBRARY.md` and is explicitly NOT v1.

## 11. Extension model

- Official resources: this repo, PR + CI gate.
- Side-loading: standard Agent Skills format means external skill folders work in any host today the same way Summer's own do (drop them in the host's skill directory). Summer-aware side-loading — installing external Summer-format resources project-/user-/studio-scoped and recording them in `.summer/project.json` — is **planned, not implemented**; the schema already accepts the namespaced IDs (§4) so an external resource can never silently shadow an official one.
- Community registry, packs, trust tiers: later; design constraints recorded in DECISIONS.md.
- Third-party executable tools: never hosted by Summer — that's what separate MCP servers are for.

## 12. Compatibility promises (v2 → v3)

Preserved: user projects and `.summer/` data; the `summer` binary and every v2 CLI command except the three removed in 3.0.0 (`summer cloud`, `summer agent`, `summer logs` — CHANGELOG); npm name `summer-engine`; auth/token state (`~/.summer/` filenames unchanged); agent MCP configs (re-written idempotently by `summer setup <agent>`).

Aliases — the honest state: every pre-v3 skill path/name is recorded as an `aliases` entry on its resource and compiled into `registry/generated/aliases.json`. **Runtime resolution of those aliases is planned, not implemented**: no code reads `aliases.json`; `summer create` resolves legacy `template-<slug>` names through the aliases compiled into `templates-registry.json`; `summer skills install <old-name>` and `summer tool <old-name>` do not resolve legacy names yet. Old prose that used `summer:<category>/<name>` was rewritten to bare slugs (`docs/DEVELOPMENT.md`, "How skills reference each other") rather than relying on aliases.

Not preserved: internal skill paths, hand-written manifests, the TS `SKILL_REGISTRY`, mutable template resolution, category folders. Alias data is kept for one major release minimum; removal requires a changelog entry and sign-off.
