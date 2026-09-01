# Summer v3 Foundation — The Contract

**Normative spec. Everything in the v3 build is generated from or validated against this document. Changing this file after migration is a breaking change; get sign-off.**

Locked 2026-09-01 by Mathias + Claude (orchestrator) + Codex (reviewer), after a repo audit and a four-agent design board. Reasoning lives in `docs/design/DECISIONS.md`; this file is the rules.

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
│   ├── core/            # config, auth, engine-connection, capabilities/ (shared CLI+MCP impls)
│   ├── cli/             # commander surface only — no business logic
│   ├── mcp/             # MCP server + tool adapters only — no business logic
│   ├── project-memory/  # .summer/ read/write, locks, receipts
│   └── installer/       # agent detection, config writing, migrations
├── library/             # the Library — content, agent-neutral
│   ├── tools/<slug>/    # DESCRIPTORS only (resource.yaml); implementations live in src/core/capabilities
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

## 3. The six kinds

| Kind | One line | Body |
|---|---|---|
| `tool` | What the agent can do (executable capability) | descriptor only; implementation in `src/core/capabilities/` |
| `skill` | How to do something well (procedure + judgment) | `SKILL.md` (open Agent Skills format) |
| `example` | A proven, working instance to study/reuse | real code + explanation + **required evidence** |
| `template` | Working foundation that becomes the user's project | pin manifest → satellite repo at exact commit |
| `collection` | Curated compatible creative materials | manifest of immutable asset refs + style rules + presets |
| `reference` | Facts and technical knowledge (passive) | markdown body |

Disambiguation rule: a **skill explains the process**; an **example is a finished working instance**. If one folder contains both, split it and link them via `related`.

## 4. Identity

- **ID** = `<kind>/<slug>`, slug is kebab-case, globally unique within kind. Official namespace is implicit; external resources are namespaced `"<publisher>/<kind>/<slug>"`.
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
  domains: [world, level-design, 3d] # open vocabulary, curated list in schemas
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
- **tool**: `implementation` (module + export in `src/core/capabilities/`), `surfaces` (`cli`, `mcp`, or both — including CLI command path and MCP tool name; `mcp.remote: true` marks tools that require no local engine and are eligible for the hosted stateless MCP v2 endpoint), `input_schema` (JSON Schema; the single source for both zod and commander), `authority` (`filesystem`, `editor_mutation`, `network`, `credentials`, `publish` — booleans), `evidence_checks`.

MCP protocol posture: the local server stays stdio (unchanged in MCP v2, spec 2026-07-28); the SDK is kept on the v2-supporting major; no elicitation patterns. Engine-free tools (`mcp.remote: true`) may additionally be served by a hosted stateless Streamable-HTTP endpoint (`summerengine.com/mcp`) — a fast-follow after the registry compiler, not part of the v1 cut.
- **template**: `repo`, `commit` (full SHA), `tree_digest` (sha256), `default_branch` (informational only — never used for resolution), `zip` (optional release-asset URL + sha256), `systems` (list), `smoke_test` (eval ref).
- **collection**: `items` (asset refs: catalog id or URL + sha256 + license each), `style` (rules text/file), `presets` (named subsets), `recommended` (skill/template IDs). Collections carry **no executable instructions** — they may only *reference* trusted skills by ID.

## 6. The registry compiler (drift is a build failure)

`scripts/generate-registry` reads every `library/**/resource.yaml` and emits into `registry/generated/`:

1. `index.json` — the searchable catalog: id, kind, version, content_hash, summary, use_when, facets, compatibility, related, status. This is what agents (and later the gateway API) search.
2. Every agent integration: `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json`, `.factory-plugin/plugin.json`, `gemini-extension.json` content, OpenCode plugin data — all skill lists, counts, and version fields stamped from `package.json`.
3. The data behind `summer skills list/install/info` (replaces the hand-written `SKILL_REGISTRY`).
4. MCP tool registrations + CLI command metadata for `tool` resources (zod + commander both derived from `input_schema`).
5. `counts.json` — canonical numbers (tools, skills, …) for README badges and the website (`toolsNumber`).
6. `aliases.json` — legacy path/name → ID map, used by `summer` to resolve old references.

**Invariant: no capability, skill, template, collection, or integration is manually registered twice.** CI (`scripts/validate-library`) fails on: schema violation; duplicate ID/alias; `related` pointing at a missing ID; regenerated output differing from committed `registry/generated/` (parity gate); manifest version fields ≠ `package.json`; count claims in README/AGENTS.md ≠ `counts.json`; capability-lint violations (below).

**Capability lint (every resource, every PR, human- or agent-authored):** no URLs outside the committed allowlist; no install commands or pipe-to-shell; no credential/env references; no encoded blobs; no invisible/bidi unicode; no imperative text steering agents on non-Summer behavior. Entries can never reach the network, credentials, or the package manager.

## 7. Templates: pinned, always

`summer create <slug>` resolves through the template's resource.yaml **only**: clone `repo` at `commit`, verify `tree_digest`, record `{template_id, version, commit, tree_digest}` into the project's `.summer/project.json`. Never resolve a default branch at runtime. GitHub-org listing survives only as discovery UX for humans, never as resolution truth.

## 8. Project memory (`.summer/`) — the consumer-side contract

Extends what exists (GameSoul.md, memory tree, locked flags, cloud state — do not reinvent):

```
.summer/
├── project.json      # engine/toolkit versions, template pin, collection installs
├── GameSoul.md       # the game's promise (existing)
├── memory/           # existing classified tree + index.json
├── state.json        # current mission/task state: what's built, verified, next
├── decisions.ndjson  # append-only decision log
└── receipts/         # verification receipts (playtest passed, screenshot, eval)
```

A fresh agent entering a project must be able to answer: what game is this, what's done, what's verified, what's next, exactly which library versions were used — without the original conversation.

## 9. Agent entry (AGENTS.md is a router, not an encyclopedia)

AGENTS.md serves four jobs for a fresh agent, in order: **trust** (what Summer is, what it will/won't do, telemetry disclosure, license), **understand** (the six kinds in six lines, the loop: search → load → build → verify → remember), **navigate** (search the registry index; never walk folders; how IDs and related links work), **work** (the verification ladder: build → play → screenshot → check diagnostics; `.summer/` conventions; when to report feedback). Everything else is one link deep.

## 10. Feedback (v1 = mailbox)

MCP tool `summer_library_feedback`: batched reports `{entry_id (with content_hash, pre-filled by loader), outcome enum (worked|worked_with_fixes|wrong|outdated|incomplete|did_not_apply|misrouted), note ≤280 chars (Tier 1 opt-in: ≤1500), deviation ≤280}` + `engine_version`. Fire-and-forget, 1s timeout, silent failure, never blocks. POSTs to `/api/mcp/library-feedback` (web repo) → append-only Postgres table, API-writes only, no anon insert policy. Nothing reads the table into any agent context. Disclosure in the tool description; `SUMMER_NO_TELEMETRY=1` + `DO_NOT_TRACK` honored; first-run notice before first event. The full Librarian pipeline (triage → PRs → ranking → automation ladder) is specced in `docs/design/SELF_IMPROVING_LIBRARY.md` and is explicitly NOT v1.

## 11. Extension model

- Official resources: this repo, PR + CI gate.
- Side-loading: standard Agent Skills format means external repos of Summer resources work day one, installed project-/user-/studio-scoped; recorded in `.summer/project.json`. Namespaced IDs; an external resource may not silently shadow an official ID.
- Community registry, packs, trust tiers: later; design constraints recorded in DECISIONS.md.
- Third-party executable tools: never hosted by Summer — that's what separate MCP servers are for.

## 12. Compatibility promises (v2 → v3)

Preserved: user projects and `.summer/` data; the `summer` binary; npm name `summer-engine`; auth/token state; agent MCP configs (migrated by `summer setup`/`installer/migrations`); `aliases.json` resolves every old skill path/name.
Not preserved: internal skill paths, hand-written manifests, the TS `SKILL_REGISTRY`, mutable template resolution, category folders. One release of alias support minimum; removal requires a changelog entry and sign-off.
