# STATUS — where everything is, what actually works

Single page. If it isn't here, it isn't real. Updated 2026-09-03 — hardening complete, first live-engine e2e passed, branch is testable end to end via `docs/TESTING.md`. Findings ledger: REVIEW-2026-09-02.md. Companion: ROADMAP.md (sequencing), CONTRACT.md (rules).

## The one place
**`SummerEngine/summer-engine-agent` branch `v3-foundation`** (PR #18 open, NOT for merging yet). Everything toolkit-side lives here. Nothing has shipped: origin `main` and npm `summer-engine@2.8.2` are untouched.

## What is verified working (how)
All rows re-verified after the 2026-09-02 fix wave; agent self-reports were NOT trusted — an HEAD presence audit + full gate run confirmed each.
| Thing | Verified by |
|---|---|
| Registry compiler → all root manifests, index, counts, aliases | `generate:registry --check` no drift; 23 compiler tests; CI parity step |
| Library: 186 resources validate (69 tools / 90 skills / 19 templates / 8 references), capability lint clean (documented exceptions only), `remote` explicit on every tool, authority fields audited against implementations. 10 skills are `preview` (7 = unverified intake from the gamedev-knowledge pipeline, 3 depend on unmerged engine ops) and are skipped by `summer setup` unless `--include-preview` | `validate:library` + resource.yaml audit |
| `summer` CLI boots; `summer tool --list` (69); `summer skills list` (83); unknown commands exit 1; `summer open`/`run`/`install` safe paths | `npm run build` + smoke + 844 tests |
| 57 engine tools + 12 gated (preview) tools; one behavior per tool, CLI + MCP faces share the same functions; a preview tool on an old engine returns a structured `engine_lacks_op` result on BOTH faces | descriptor↔zod parity + mirror-parity tests; **live e2e on engine 0.5.65 with a real project (2026-09-02): project context, scene tree, viewport screenshot all worked through `summer tool`** |
| Testable on this branch without publishing: `summer setup <agent> --local-dev` points the agent at this checkout's build; recipe in `docs/TESTING.md` (every command executed) | fake-HOME setup run + gate run |
| `summer_library_feedback` → live endpoint → Supabase table → /admin view | 29 MCP tests + 25 route tests; loopback wire proof; table verified live |
| Headless routing layer | 58 unit tests + fake worker; real-binary test SKIPS (no engine build) |
| Routing eval — tuning set (83 q): recall@5 1.0 / recall@1 0.81 / MRR 0.89. **Held-out set (42 q, written blind): recall@5 0.79 / recall@1 0.50 / MRR 0.70** | `npm run eval:routing` (gated) + `eval:routing:heldout` (report-only). The held-out numbers are the real index quality. |
| Template pinning: `summer create` fetches the pinned SHA, verifies tree digest, refuses on mismatch, writes `.summer/project.json` | 84 tests + live fetch of a real template repo (digest matched) |
| Descriptor ↔ zod parity gate; validator cross-checks descriptors vs real registrations, implementation paths, schema shape | `npm test` — found and fixed 3 drifts on first run |
| Hooks fire in Claude Code/Cursor (matcher/if per docs); OpenCode plugin loads the library; `setup` installs all 83 skills incl. `using-summer` | hook smoke + opencode smoke test + cold install in fake HOME |

## What exists as code but CANNOT work yet (engine ops unmerged)
12 tools gated on unmerged engine ops degrade with `engine_lacks_op` (override: `SUMMER_CAPABILITY_PREFLIGHT=off`):
scripting (run_script, run_editor_script, world_snapshot, snapshot_diff, get_runtime_tree, inspect_runtime_node), spatial (6), plus headless routing (flag `SUMMER_HEADLESS_ROUTING=1`) which needs the worker.
Unblocked by: **SummerEngine/SummerEngine PR #155 (headless worker) + #156 (scene scripting)** — rebased, opened, **never built**. Owner must build + smoke + merge.

## NOT yet done (honest)
- Cold-machine install test: RUN (tarball → fake HOME → setup → MCP handshake → 70 tools → engine-less calls). Mechanics passed; the P0s it found (doctor short-circuit, stale skill refs) are fixed; live-engine step still unverified (running editor exposed no API during the test).
- Independent adversarial review: RUN (6 reviewers). Findings + owners in REVIEW-2026-09-02.md; P0/P1 fixed; P2 debt scheduled (consolidation pass).
- Skill bodies: v2 references purged (359 invocations, 46 links, 20 dead targets); bare-slug cross-reference convention documented in docs/DEVELOPMENT.md.
- Held-out routing eval: added (report-only). Closing the 21-point tuning/held-out gap is content work (use_when phrasing), tracked in ROADMAP.
- `feat/templates-mcp-tool` dirty checkout (someone's uncommitted `with-engine.ts` + `summer_list_templates` work) — unreconciled with v3's `with-engine.ts` changes.
- Count guards now derive from counts.json (no literals).
- CONTRACT/AGENTS/README/CHANGELOG now match the code (truth pass 2026-09-02); planned-not-implemented is labelled as such: `.summer/state.json`/`decisions.ndjson`/`receipts/`, runtime alias resolution for skills/tools (aliases.json is generated, only template aliases resolve), Tier-1 1500-char feedback notes, Summer-aware side-loading. Folding the CLI/MCP mirror into shared capabilities: helpers deduped (one copy each, parity-tested); registration still happens twice by design for now.
- Live-engine verification of the 12 preview tools: impossible until engine PRs #155/#156 merge (the engine-free and 57 engine tools ARE live-verified).
- `summer tool library-feedback` passes `reports` through without the MCP face's zod validation (invalid outcome → gateway `dropped:true` instead of a local error) — small, tracked.
- Capability lint does not flag `git clone` / `cmake --install` / `hf download` as install commands — decide whether it should.
- Two P2 leftovers: 3 "Summercraft" strings in src/core/auth.ts + login.ts; the tuning/held-out routing gap (1.0 vs 0.80) is content work.

## Other places (dependencies, not homes)
- Web repo branch `feat/library-feedback-mailbox` (endpoint + admin; pushed, no PR). Salt env set in Vercel. RLS fix applied.
- Web cloud cleanup: task chip pending (not started).
- Engine PRs #155 / #156 (above). Engine local `main` has 5 stale unpushed commits — abandon.

## Ship gates (all Mathias)
PR #18 → main **together with** web mailbox branch **and** npm publish 3.0.0; then rename repo → `summer`, org → `summerengine`; then web copy pass.
