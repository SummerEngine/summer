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

**Ship posture for the hackathon (Sat 2026-09-06), recommended 2026-09-03:** do NOT flip `latest` before the event. Publish v3 as `npm publish --tag next` so `npx -y summer-engine@next` exists for team dogfooding Thu/Fri while participants stay on stable 2.8.2 (`@latest`). The 57 engine tools work on the shipped engine 0.5.65 (live-verified); the 11 gated tools need engine PRs #147/#155/#156/#158 built + merged + a new engine release — none built yet. Flip `latest` after a real end-to-end dogfood session (Claude Code + a game build) and ideally one Windows check; the flip is one `npm dist-tag add` away.

**Human-gated actions (Mathias only):** merge the PR; npm publish 3.0.0 (`next` first, then `latest`); GitHub repo rename → `summer` + org casing → `summerengine` (do both together when the new README lands); web-repo rename copy pass (one constant `src/lib/data/agent-guides.ts` + ~25 hard-coded spots: 6× i18n `home.json` L119, 3 blog MDX + 15 translations, `source-status/page.tsx` L7, Docs/plans).


### Port wave 2026-09-02 (other sessions' MCP work → v3-foundation) ✅
- **Headless routing layer** ported (`src/core/headless/`, flag `SUMMER_HEADLESS_ROUTING=1`, byte-inert off; contract `docs/HEADLESS_ROUTING.md`). Engine half (`--summer-worker` module) lives on engine branch `feature/headless-worker` (now pushed) — must rebase over 4.7.x and merge before routing activates. Smoke: `tests/1summer_engine/headless_worker_smoke.py` (engine repo).
- **Scene scripting + perception** ported: `summer_run_script`, `summer_run_editor_script`, `summer_api_docs` (remote-capable), `summer_world_snapshot`, `summer_snapshot_diff`, `summer_get_runtime_tree`, `summer_inspect_runtime_node`, `summer_import_hdri`; capability-skew pre-flight (engine `/api/health capabilities` authoritative, incl. `singleOnlyOps`); opt-in trajectory capture (`SUMMER_TRAJECTORY_DIR`); playbook as MCP prompt; 3 new skills + 15 skill content fixes. Engine ops (RunSceneScript, snapshots, runtime reads) remain unmerged on `origin/claude/summerengine-python-scene-scripting-qar1us` — tools degrade honestly until merged.
- **Linux/cloud engine install** (`summer install` on Linux, `SUMMER_ENGINE_BINARY`, `~/.summer/engine`), api-docs bundle (500 KB, ships), `running-in-the-cloud` skill; `SUMMER_TOKEN` env override; shared binary resolver.
- **Summer Cloud REMOVED** (unmaintained research preview; Platform is the wired path): 7 tools, `summer cloud`, sync engine, cloud-token auth, skill — −5.8k lines. Web-side cleanup (`/cloud` page, `app/api/cloud/*`, cli-login cloudToken) = separate PR (task chip issued).
- Registry after wave: 173 resources — 64 tools / 82 skills / 19 templates / 8 references. Suite 575 green.
- **Decisions surfaced for Mathias:** (a) `summer-compatibility.ts` still declares engine 4.6.1 while the scripting branch bumped to 4.7.2 — engine-version floor is a product call; (b) `summer_record_feedback` (per-change user verdict accept/reject/correction) was dropped in favor of `summer_library_feedback` — if the Librarian wants a user-verdict signal it becomes a FIELD on library_feedback, never a second tool; (c) routing eval now indexes tools alongside skills — several skill queries surface tool entries in top-5; kind-aware ranking is the next index-quality fix.
- NOT ported (ownership unconfirmed): three Codex spatial branches (6 tools: align/distribute, snap-to-surface, camera framing/visibility, navigation probe, placement test; global text-result cap; exact-SaveScene local-API fix).


### Wave 3 2026-09-02 (Mathias "go") ✅
- **Codex spatial tools ported** (6: snap-to-surface, align-distribute-3d, frame-camera, test-placement, camera-visibility, navigation-probe) + `world-building-3d` skill; all `status: preview` until the engine ops merge — flip to stable then. Blanket 5 KB result cap deliberately NOT ported (contradicts v3's documented no-silent-truncation policy); per-tool compact caps kept. Starcast (`summer_starcast`, PR #147) and its `spatial-placement` skill: first skipped as "superseded", REVERSED 2026-09-03 on Mathias's call — it is complementary directional evidence, ported as a gated tool. Codex `canary-gateway` blind A/B harness: ported into `evals/canary/` (2026-09-03). **frame-camera + camera-visibility REMOVED 2026-09-03** — Marcus (their author) dropped them after further benchmarks showed no significant improvement; they may leave engine PR #158 as well. Spatial suite is now 4 ops + starcast.
- **Engine halves prepared for owners** (git-only, nothing built): SummerEngine/SummerEngine PR #155 (headless worker, 13 commits rebased onto 4.7.2 main) and PR #156 (scene scripting, 34 commits, clean rebase). Both carry "NOT BUILT — owner must build + smoke". The unpushed engine local-main 2.8.2 CLI commit is redundant with public main — abandon; private→public sync is retired.
- **Kind-aware registry search** (`src/core/registry-search.ts`, shared by the eval runner and future runtime search): BM25 + light stemming + compound fallback + kind prior rules + related boost. Routing recall@5 0.838 → 0.934 (ranking) → **1.0** after 9 library metadata fixes (user-phrased use_when, related links). 12 tool-intent queries added (tool routing 1.0). This closed the eval → content-fix → eval loop end to end for the first time.
- Registry after wave: **180 resources — 70 tools / 83 skills / 19 templates / 8 references.** Suite 640 green, parity clean.
- Engine floor kept at 4.6.1 (conservative; revisit when 4.7.x engine is the shipped minimum).


### Hardening 2026-09-02 ✅ (see REVIEW-2026-09-02.md)
- Six adversarial reviews + cold-install e2e → 8 P0 / ~25 P1 fixed in one wave; three follow-up passes (library metadata honesty, docs/contract truth, src consolidation). Final: 179 resources (69/83/19/8), 844 tests, parity clean, held-out routing recall@5 0.80 (tuning 1.0).
- Real template pinning; descriptor↔zod + mirror parity gates; validator cross-checks registrations; hardened capability lint (+destructive-command rule); hooks fire; OpenCode loads skills; setup installs all skills; install/open/run/unknown-command safe; login loop terminal; gateway.url everywhere; Summer Cloud gone; 359 stale refs purged.
- Process rules adopted (DECISIONS D14): single writer per surface, `git commit --only -- <paths>` in shared worktrees, review agents read-only and never run side-effecting product commands.
- NEXT for the index: close the tuning/held-out gap with content (use_when phrasing) — held-out is the number that counts. NEXT for tools: merge engine PRs #155/#156, then flip the 14 preview resources to stable and run the live-engine e2e step.


### Scripting & headless — honest state (2026-09-03)
- **Shipped today (engine 0.5.65):** `RunEditorScript` (editor-side GDScript via `summer_run_editor_script` — was mislabelled preview, now stable), `RunVerification` (runtime probe scripts: report/save_frame/press/key/finish), `RunCommand`. Agents CAN script the editor today; the toolkit exposes it on both faces.
- **Not shipped:** `RunSceneScript` (compile-first, checkpoint/rollback, ctx helpers — the Blender-`bpy`-class door) + world snapshot/diff + runtime tree reads = engine PR #156; headless worker (`--summer-worker`, loopback protocol, per-project routing) = PR #155; spatial ops = #147/#158. Toolkit halves are wired and gated; the engine halves are unbuilt. This is the single largest gap between "what the branch contains" and "what a user can do".
- **Python:** there is no Python scripting of the engine. The "python script" in the headless work is `tests/1summer_engine/headless_worker_smoke.py` — the acceptance test for the worker, engine-side. DECISION for Mathias: if Python control matters (CI, evals, data scientists), add a thin Python client over the local HTTP API / MCP (`pip install summer-engine` shape) — a small toolkit addition, no engine change. Agents themselves use MCP/CLI; Python is for scripts and pipelines.


### Night 2026-09-03 ✅ — navigation, runtime librarian, tag discipline
- **`summer open <target>` / `summer_open`** + product-map reference (64 rows, code is source of truth) + `navigate-summer` skill (CLI-navigation session; research in NAVIGATION-RESEARCH.md, design in NAVIGATION-DESIGN.md). 11 editor targets `planned` → engine ops: SetMainScreen, FocusChat, OpenProjectSettings, OpenEditorSettings, ShowBottomPanel, FocusEditorWindow, OpenScript{line}, more dock ids; `summer://` forwarding = v2. Web PR list: /agent-routes.json from ask-summer-registry.ts, llms.txt section, /dashboard/settings redirect, derived toolsNumber, /open?to= router, public play URL (product gap).
- **Runtime librarian:** `summer_search_library` (BM25 + RRF semantic fusion when `registry/generated/embeddings.json` + a provider exist; lexical offline) and `summer_read_library` (entry + feedback footer `entry_id@hash` — closes the "feedback has no trigger" gap). `generate:registry --embed` builds the sidecar keyed by content_hash (never fails `--check`). Sizes: 200 entries 0.4 MB, 10k 21.5 MB (int8 → ~6 MB). Scale plan: local ≤10k; 10k–100k = hosted search (Supabase pgvector via the remote MCP); external vector SaaS only at millions. NEXT: web `/api/mcp/embed` endpoint + run `--embed` in the publish flow.
- **Tag discipline:** `registry/schemas/domains.json` (60 domains, 12 modalities) enforced via schema `$ref`; ≥2 domains + ≥2 real use_when per entry; 150 violations fixed in 126 files; reciprocity WARN (161 one-way links = content backlog). Held-out recall 0.80 → 0.84 as a side effect.
- Registry: 191 resources — 71 tools / 92 skills / 19 templates / 9 references. 1012 tests.
- Web security: open redirect on `/auth/callback?next=` fixed + adversarially reviewed → PublicSummerEngine PR #328 (unmerged); follow-up filed: pin redirect origin instead of trusting `x-forwarded-host`.

## 3. Next (ordered fast-follows, design already locked)

1. **Remote stateless MCP (MCP v2, spec 2026-07-28).** Serve every `mcp.remote: true` tool (library search, generation, templates, feedback — engine-free) at `summerengine.com/mcp` as stateless Streamable HTTP on Vercel. Zero-install funnel. Depends on: registry compiler. Bonus: makes the already-published blog config (`"url": "https://www.summerengine.com/mcp"`) true instead of wrong.
2. **`.summer/state.json` deep spec.** Long-horizon resumability (what's built/verified/next, per-task state) — the thinnest part of the contract, flagged in DECISIONS D-audit. Must let a fresh agent resume a 3-week build with no conversation history.
3. **Collections unification.** Reconcile `library/collections/` schema with Tim's #274 platform system: add versioned/immutable asset refs (sha256 — today a curator re-upload silently changes content), style-rules + presets + recommended fields, agent-repo manifests bridging the R2 catalog, curator tooling. Extend his system; never build a parallel one.
4. **Eval runner (evidence stays live).** Execute examples/templates headless against pinned engine versions in CI; re-run the library on each engine release; auto-flag broken entries. Turns the 21 prose specs into executable gates; expands routing evals to admission-gate every new entry.
5. **Content factory.** Generalize the gameskill-capture pattern: verified moments from real sessions → candidate entries → CI gate → review. This is how "thousands of examples" actually happens; without it the library ambition has no production line.
6. **Librarian pipeline L1** (per SELF_IMPROVING_LIBRARY.md §4): daily isolated triage cron (no tools/no network/JSON-only), `/admin` verdict queue, Railway repair job → scoped PRs, merge webhook. Then ranking (Beta prior, per entry-version, weekly `health.json` PR) and the loop-health metrics dashboard.
7. **`summer_get_help` support channel.** v1 = registry/knowledge lookup + stuck-report capture (the highest-value gap signal); later = live support agent. Humans route through it too.
8. **`summer_library_contribute`.** Candidate examples from users' verified builds — double consent gate (chat ask + native app sheet showing the literal payload), ≤5 files / ≤32KB, evidence by captured asset id, candidate queue only.

### Added 2026-09-03 (Navigation — `summer open` / `summer_open`) ✅ toolkit side · reworked 2026-09-04 (`NAVIGATION-PLAN.md`)
- **Toolkit (`v3-foundation`):** `tool/open` (MCP `summer_open`, CLI `summer open <target>`, `summer tool open` — one behavior in `src/core/capabilities/navigation/`), `reference/product-map` (generated), `skill/navigate-summer`. The toolkit owns no destinations: web rows come from summerengine.com's `/agent-routes.json` (vendored `assets/navigation/web-routes.json`, `npm run sync:web-routes`); editor ids are forwarded to the engine's `Navigate` op and availability comes from the engine's `capabilities.navigation` advert (legacy fallback for scene/node/script/file/docks on older engines). The three legacy scene tools (`summer_open_scene`, `summer_select_node`, `summer_open_main_scene`) stay as build-workflow tools.
- **Engine PR `feat/navigate-op` (SummerEngine/summerengine, NOT BUILT by us):** one op `Navigate {target, …}` backed by one table (`editor/ops/navigate_ops.cpp`): editor-window, screen-2d/3d/script/game/assetlib, viewport-show/hide, assistant, project-settings, editor-settings, panel(name), dock(name), scene, node, script(path,line,col), file; `/api/health` advertises `capabilities.navigation.targets`; the chat webview bridge (`editor:show-viewport`, `editor:open` script branch) calls the same table so the agent-layout rework edits ONE file. Owner: engine — build, smoke (`summer tool open --args '{"target":"editor-window"}'`), merge, release. The toolkit needs no change when it lands: `summer open --list` starts showing the ids as available.
- **Web PR `feat/agent-routes-catalog` (publicsummerengine):** `src/lib/navigation/routes.ts` (one list; `ask-summer-registry.ts` routes must be in it — tested), `/agent-routes.json` (`force-static`), `agent-catalog.json` `navigation` key + entry point, `llms.txt` "Navigating summerengine.com" section. After deploy: `npm run sync:web-routes` in the toolkit refreshes the snapshot. Still separate: `/auth/callback?next=` validation — **in progress (session main), branch `fix/auth-callback-open-redirect`**; a public play URL for published games is a **product gap** (not invented in the map); v2 `/open?to=<target>` router (Cloudflare `?to=` pattern).
- **v2, not scheduled:** a `summer://` navigation scheme — the engine already registers `summerengine://` (macOS, auth-only) and spawns a second editor when one is running; a navigation scheme must forward to the running instance over the local API first (VS Code pattern), and Windows registration is a TODO stub.
- **Not verified yet:** a live-engine `Navigate` (engine PR unbuilt) and a live `summer open scene`/`node` on 0.5.65 — run TESTING.md §d with `summer open inspector` once an editor is open.

### Added 2026-09-01 (CLI/MCP parity + Node-less distribution)
- **MCP SDK v2 watch:** the 2026-07-28 spec is live but `@modelcontextprotocol/sdk` has published no v2 major (latest 1.30.0, protocol 2025-11-25). We are pinned at ^1.30.0; adopt the v2 SDK when it ships. stdio is unaffected by v2's statelessness change; the remote MCP endpoint (below) is where v2 matters.
- **Full CLI parity (this build):** generic `summer tool <name> --json '<args>'` passthrough exposing every tool via the shared capability layer, so shell-native agents get 100% of MCP capability with zero config. Both surfaces generated from one descriptor — parity is enforced, never maintained.
- **Native single-file binaries (fast-follow):** compile the CLI+MCP into per-platform executables (Bun/Deno compile) so Node is no longer required at all — the Unity CLI Loop v3 lesson without dropping MCP. One binary serves `summer …` and `summer mcp`.
- **Two setup modes (fast-follow):** `summer setup <agent>` default = MCP (one-paste onboarding, host permission UX); `--mode cli` = no MCP config at all — CLI-first for power users, headless, CI, and scripting loops (MCP's one-shot RPC can't express loops/pipes; CLI discovery via --help costs zero standing context vs ~62 always-loaded schemas). Watch real usage; flipping the recommended default for technical users is a docs change, not a rebuild. The incoming MCP-scripting and fully-headless agent work slots into this lane.
- **Headless per-project routing (ported, ships dark):** `src/core/headless/` + `docs/HEADLESS_ROUTING.md` — editor → live worker → spawned worker resolution behind `SUMMER_HEADLESS_ROUTING=1` (flag unset = byte-for-byte inert; the module is not even imported). Activation depends on the engine half: the `summerengine` branch `feature/headless-worker` (`--summer-worker` mode, `summer_processes.cfg` registry, v1.1 mutual-auth handshake) must merge and be rebased over 4.7.x before the flag does anything on a shipped build. Binary discovery reuses `src/core/engine-install.ts findEngineBinary` (`SUMMER_ENGINE_BIN` stays as the routing layer's own override on top of `SUMMER_ENGINE_BINARY`).


### Inputs from #game-dev-dumpster (Slack, 2026-08-28 → 09-02) — content-factory candidates
- Marcus's spatial work: the six-tool suite (`codex/world-tool-balanced-suite-ready`) AND `summer_starcast` (PR #147) are both ported (preview until engine ops merge); the suite's engine half is opened as a PR by us (git-only, like #155/#156). His web PR #290 (embedded-agent `spatial-placement` skill) stays in the web repo. Policy correction (Mathias, 2026-09-03): assume contributors' work is good — `preview` is a label, not a burial; preview skills install by default (`--stable-only` to skip).
- Skill/example candidates surfaced by the team (each = a library entry once verified in-engine): a character movement system skill (valigo thread), particles techniques (video), wet-surface / rain shader look (TenMomo), MotionBricks-style real-time animation notes (NVIDIA), ECS data-oriented scene hierarchies (ajmmertens) as a reference, skin-tokens.cpp auto-rigging/skin weights (jichiep) as an asset-pipeline reference.
- `SummerEngine/summer-gamedev-knowledge` (private) — Marcus's Slack→Codex→SKILL.md pipeline IS the content factory's first intake source (§3.5). Its 7 skills are in the library (`preview`, source-cited, installed by default). NEXT: wire it directly — the pipeline commits into `library/skills/` (or opens PRs against this repo) and runs `validate:library` + routing evals as its gate, instead of a separate repo + manual port.

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
