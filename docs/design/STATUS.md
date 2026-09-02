# STATUS — where everything is, what actually works

Single page. If it isn't here, it isn't real. Updated 2026-09-02 (post hardening fix wave — see REVIEW-2026-09-02.md for what was found and fixed). Companion: ROADMAP.md (sequencing), CONTRACT.md (rules).

## The one place
**`SummerEngine/summer-engine-agent` branch `v3-foundation`** (PR #18 open, NOT for merging yet). Everything toolkit-side lives here. Nothing has shipped: origin `main` and npm `summer-engine@2.8.2` are untouched.

## What is verified working (how)
All rows re-verified after the 2026-09-02 fix wave; agent self-reports were NOT trusted — an HEAD presence audit + full gate run confirmed each.
| Thing | Verified by |
|---|---|
| Registry compiler → all root manifests, index, counts, aliases | `generate:registry --check` no drift; 23 compiler tests; CI parity step |
| Library: 180 resources validate, capability lint clean (6 documented exceptions) | `validate:library` |
| `summer` CLI boots; `summer tool --list` (70) ; `summer skills list` (83) | `npm run build` + smoke |
| 56 pre-existing MCP tools (scene/debug/project/asset/generate/creator/file/screenshot) | unit tests; `summer tool summer_get_diagnostics` smoked against a live engine during the build |
| `summer_library_feedback` → live endpoint → Supabase table → /admin view | 29 MCP tests + 25 route tests; loopback wire proof; table verified live |
| Headless routing layer | 58 unit tests + fake worker; real-binary test SKIPS (no engine build) |
| Routing eval — tuning set (83 q): recall@5 1.0 / recall@1 0.81 / MRR 0.89. **Held-out set (42 q, written blind): recall@5 0.79 / recall@1 0.50 / MRR 0.70** | `npm run eval:routing` (gated) + `eval:routing:heldout` (report-only). The held-out numbers are the real index quality. |
| Template pinning: `summer create` fetches the pinned SHA, verifies tree digest, refuses on mismatch, writes `.summer/project.json` | 84 tests + live fetch of a real template repo (digest matched) |
| Descriptor ↔ zod parity gate; validator cross-checks descriptors vs real registrations, implementation paths, schema shape | `npm test` — found and fixed 3 drifts on first run |
| Hooks fire in Claude Code/Cursor (matcher/if per docs); OpenCode plugin loads the library; `setup` installs all 83 skills incl. `using-summer` | hook smoke + opencode smoke test + cold install in fake HOME |

## What exists as code but CANNOT work yet (engine ops unmerged)
Tools gated on unmerged engine ops degrade with `engine_lacks_op` (override: `SUMMER_CAPABILITY_PREFLIGHT=off`):
scripting (run_script, run_editor_script, world_snapshot, snapshot_diff, get_runtime_tree, inspect_runtime_node), spatial (6), plus headless routing (flag `SUMMER_HEADLESS_ROUTING=1`) which needs the worker.
Unblocked by: **SummerEngine/SummerEngine PR #155 (headless worker) + #156 (scene scripting)** — rebased, opened, **never built**. Owner must build + smoke + merge.

## NOT yet done (honest)
- Cold-machine install test: RUN (tarball → fake HOME → setup → MCP handshake → 70 tools → engine-less calls). Mechanics passed; the P0s it found (doctor short-circuit, stale skill refs) are fixed; live-engine step still unverified (running editor exposed no API during the test).
- Independent adversarial review: RUN (6 reviewers). Findings + owners in REVIEW-2026-09-02.md; P0/P1 fixed; P2 debt scheduled (consolidation pass).
- Skill bodies: v2 references purged (359 invocations, 46 links, 20 dead targets); bare-slug cross-reference convention documented in docs/DEVELOPMENT.md.
- Held-out routing eval: added (report-only). Closing the 21-point tuning/held-out gap is content work (use_when phrasing), tracked in ROADMAP.
- `feat/templates-mcp-tool` dirty checkout (someone's uncommitted `with-engine.ts` + `summer_list_templates` work) — unreconciled with v3's `with-engine.ts` changes.
- Count guards now derive from counts.json (no literals).
- STILL OPEN: `.summer/state.json` / `decisions.ndjson` / `receipts/` named in CONTRACT §8 are spec-only (nothing writes them) — contract being corrected; CONTRACT §2/§3/§5 architectural claims (implementation in core, mcp adapters only, zod derived from input_schema) are false today — being rewritten honestly + consolidation pass scheduled; aliases.json has no runtime consumer yet.

## Other places (dependencies, not homes)
- Web repo branch `feat/library-feedback-mailbox` (endpoint + admin; pushed, no PR). Salt env set in Vercel. RLS fix applied.
- Web cloud cleanup: task chip pending (not started).
- Engine PRs #155 / #156 (above). Engine local `main` has 5 stale unpushed commits — abandon.

## Ship gates (all Mathias)
PR #18 → main **together with** web mailbox branch **and** npm publish 3.0.0; then rename repo → `summer`, org → `summerengine`; then web copy pass.
