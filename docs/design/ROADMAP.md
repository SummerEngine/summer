# Summer v3 — Roadmap: What Exists, What's Next

Single source of truth for sequencing. Every "later" from the v3 design sessions (2026-09-01) lives HERE, not in chat history. Update this file when anything ships or gets re-scoped. Rules live in `CONTRACT.md`, reasoning in `DECISIONS.md`, the feedback flywheel in `SELF_IMPROVING_LIBRARY.md`.

## 1. What is there (before this build)

- npm `summer-engine` 2.8.2 (~2.9k installs/mo), stdio MCP (62 tools), CLI (21 commands), 79 skills, 12-agent setup support.
- `.summer/` project memory (GameSoul.md, classified memory tree, locked flags). The v2 Summer Cloud sync (atomic writes, lock, 11 test files) that lived beside it was **removed in this build** — unmaintained research preview, Platform publish/releases is the wired path. Web-repo counterpart (`/cloud` page, `app/api/cloud/*` routes, cli-login `cloudToken` minting) is a separate cleanup PR.
- Update/staleness checks (`.summer-version` markers across 7 agent dirs; npm-latest doctor check).
- 21 prose eval specs (6 TBD stubs incl. make-game), no automated runner.
- Known debts fixed by this build: 6-way manifest drift, unpinned templates (mutable branch clone + `.git` deleted), hand-written registries, dead `summer skills count` hook call, stale count claims (44/50+/52/62).
- Platform-side Collections: web repo PR #274 (Tim) — 344 curated assets, 11 collections, R2 `collection.yaml` catalogs, project pinning, import tools. OPEN, 2 test failures + Vercel deploy failure at last check.

## 2. In flight (this build — branch `v3-foundation`)

Waves; each gated by tsc + vitest + validate-library:

1. ✅ Contract + decisions + self-improving-library spec (`docs/design/`).
2. ✅ Inventory extraction (`migration/*.json`) — skills/tools/manifests/templates/references ground truth.
3. ✅ `registry/schemas/` + `scripts/validate-library` + capability lint + tests.
4. ✅ `src/` restructure → core / cli / mcp / project-memory / installer, import-direction test.
5. ✅ Registry compiler (`scripts/generate-registry`) → `registry/generated/` (index, all agent manifests, counts, aliases) + CI parity gate.
6. ✅ Library migration fleet: 79 skills → `library/skills/<slug>/` + resource.yaml (aliases for every old path); 63 tools → `library/tools/<slug>/` descriptors; references/ + docs → `library/references/`; templates → `library/templates/<slug>/` pinned (commit + tree_digest, resolved from live repos).
6b. ✅ Cutover: `summer skills list/install/info` + `summer setup` read `registry/generated/skills-registry.json` (installer copies from `library/skills/<slug>/`; `recommended` lives in resource.yaml, compiled into the registry); hand-written `SKILL_REGISTRY` deleted; legacy `skills/` + `references/` trees deleted (aliases keep old paths resolving); guard tests repointed at library/; package `files` ships `library/`, `registry/generated/`, `registry/schemas/`, `integrations/`.
7. ✅ MCP SDK pinned ^1.30.0 (no v2 major published yet — see watch item) (`@modelcontextprotocol/sdk` → v2 major; stdio unchanged; no elicitation to migrate).
8. ✅ AGENTS.md rewrite (trust / understand / navigate / work router) + README update; docs/.
9. ✅ Evals: routing eval suite (84 queries, recall@5 0.958 baseline) (query → expected entries) + per-kind scaffolding + CI workflow.
10. ✅ Feedback mailbox v1 (+ agent_model/client attribution): `summer_library_feedback` MCP tool (agent repo) + `/api/mcp/library-feedback` route + append-only table (web repo; table via Supabase direct SQL — Drizzle migrator history is unreliable; API-writes only, no anon insert policy, capped fields) + first-run telemetry notice + `SUMMER_NO_TELEMETRY` / `DO_NOT_TRACK`.
11. ✅ Full verify (tsc clean, 560/560, parity no-drift, npm pack verified) + branch pushed. PR open for Mathias sign-off.

**Human-gated actions (Mathias only):** merge the PR; npm publish 3.0.0; GitHub repo rename → `summer` + org casing → `summerengine` (do both together when the new README lands); web-repo rename copy pass (one constant `src/lib/data/agent-guides.ts` + ~25 hard-coded spots: 6× i18n `home.json` L119, 3 blog MDX + 15 translations, `source-status/page.tsx` L7, Docs/plans).

## 3. Next (ordered fast-follows, design already locked)

1. **Remote stateless MCP (MCP v2, spec 2026-07-28).** Serve every `mcp.remote: true` tool (library search, generation, templates, feedback — engine-free) at `summerengine.com/mcp` as stateless Streamable HTTP on Vercel. Zero-install funnel. Depends on: registry compiler. Bonus: makes the already-published blog config (`"url": "https://www.summerengine.com/mcp"`) true instead of wrong.
2. **`.summer/state.json` deep spec.** Long-horizon resumability (what's built/verified/next, per-task state) — the thinnest part of the contract, flagged in DECISIONS D-audit. Must let a fresh agent resume a 3-week build with no conversation history.
3. **Collections unification.** Reconcile `library/collections/` schema with Tim's #274 platform system: add versioned/immutable asset refs (sha256 — today a curator re-upload silently changes content), style-rules + presets + recommended fields, agent-repo manifests bridging the R2 catalog, curator tooling. Extend his system; never build a parallel one.
4. **Eval runner (evidence stays live).** Execute examples/templates headless against pinned engine versions in CI; re-run the library on each engine release; auto-flag broken entries. Turns the 21 prose specs into executable gates; expands routing evals to admission-gate every new entry.
5. **Content factory.** Generalize the gameskill-capture pattern: verified moments from real sessions → candidate entries → CI gate → review. This is how "thousands of examples" actually happens; without it the library ambition has no production line.
6. **Librarian pipeline L1** (per SELF_IMPROVING_LIBRARY.md §4): daily isolated triage cron (no tools/no network/JSON-only), `/admin` verdict queue, Railway repair job → scoped PRs, merge webhook. Then ranking (Beta prior, per entry-version, weekly `health.json` PR) and the loop-health metrics dashboard.
7. **`summer_get_help` support channel.** v1 = registry/knowledge lookup + stuck-report capture (the highest-value gap signal); later = live support agent. Humans route through it too.
8. **`summer_library_contribute`.** Candidate examples from users' verified builds — double consent gate (chat ask + native app sheet showing the literal payload), ≤5 files / ≤32KB, evidence by captured asset id, candidate queue only.

### Added 2026-09-01 (CLI/MCP parity + Node-less distribution)
- **MCP SDK v2 watch:** the 2026-07-28 spec is live but `@modelcontextprotocol/sdk` has published no v2 major (latest 1.30.0, protocol 2025-11-25). We are pinned at ^1.30.0; adopt the v2 SDK when it ships. stdio is unaffected by v2's statelessness change; the remote MCP endpoint (below) is where v2 matters.
- **Full CLI parity (this build):** generic `summer tool <name> --json '<args>'` passthrough exposing every tool via the shared capability layer, so shell-native agents get 100% of MCP capability with zero config. Both surfaces generated from one descriptor — parity is enforced, never maintained.
- **Native single-file binaries (fast-follow):** compile the CLI+MCP into per-platform executables (Bun/Deno compile) so Node is no longer required at all — the Unity CLI Loop v3 lesson without dropping MCP. One binary serves `summer …` and `summer mcp`.
- **Two setup modes (fast-follow):** `summer setup <agent>` default = MCP (one-paste onboarding, host permission UX); `--mode cli` = no MCP config at all — CLI-first for power users, headless, CI, and scripting loops (MCP's one-shot RPC can't express loops/pipes; CLI discovery via --help costs zero standing context vs ~62 always-loaded schemas). Watch real usage; flipping the recommended default for technical users is a docs change, not a rebuild. The incoming MCP-scripting and fully-headless agent work slots into this lane.
- **Headless per-project routing (ported, ships dark):** `src/core/headless/` + `docs/HEADLESS_ROUTING.md` — editor → live worker → spawned worker resolution behind `SUMMER_HEADLESS_ROUTING=1` (flag unset = byte-for-byte inert; the module is not even imported). Activation depends on the engine half: the `summerengine` branch `feature/headless-worker` (`--summer-worker` mode, `summer_processes.cfg` registry, v1.1 mutual-auth handshake) must merge and be rebased over 4.7.x before the flag does anything on a shipped build. Binary discovery reuses `src/core/engine-install.ts findEngineBinary` (`SUMMER_ENGINE_BIN` stays as the routing layer's own override on top of `SUMMER_ENGINE_BINARY`).

## 4. Later (design constraints recorded; not scheduled)

- **Automation ladder L2/L3** — auto-merge bounded classes then post-hoc review; written promotion criteria in SELF_IMPROVING_LIBRARY.md §6 are binding; per-class, auto-demotion on any revert.
- **Tiered feedback caps** — Tier 1 opt-in notes ≤1500 chars (anonymous stays ≤280).
- **Community registry / packs / trust tiers** — namespaced third-party resources searchable but labeled; capability lint applies to anything Summer's index serves; ClawHub incident (≈12% malware) is the reason this door opens last. Third-party *executable* tools are never hosted — separate MCP servers exist for that.
- **Registry as API** — gateway serves `index.json` (+ health) so agents query instead of reading files; repo stays source of truth.
- **Engine crash reports → same quarantine pipe** as agent feedback (endpoint/payload change only; engine work otherwise paused per the 180).
- **Editor surfacing of `.summer/`** (panel: GameSoul/plan/receipts) — engine, someday.
- **Engine-signed verified receipts** ("this playtest really ran") — L3-era trust upgrade.
- **Telemetry "what we collect" page** on summerengine.com + docs.
- **Summer Games / Store / analytics / grow / support tooling** — arrives as library entries with lifecycle facets (launch/grow/support): store publishing tools, read-analytics tools, retention skills, live-ops references. Structure never changes for this (DECISIONS D9).
- **Media/asset service for evidence at scale** — >200KB evidence media by URL+sha256; enforcement exists in lint; a proper upload path for contributors is needed when examples multiply.
- **Fix stale public claims** — blogs saying "37 tools", advertising the not-yet-real HTTP MCP; sweep after the remote MCP or correct outright.
- **Alias sunset** — legacy path/name aliases live ≥1 major release; removal needs changelog + sign-off.
- **Deprecate `references/template-registry.md`** once pinned template resources are live (it is a fourth hand-maintained mapping with 5 TBD rows).

## 5. North star

Build the deepest verified game-development library for AI agents — index quality + evidence quality compounding through real usage — wrapped in tools, memory, and proof, agent-neutral, one front door: `summerengine/summer`.
