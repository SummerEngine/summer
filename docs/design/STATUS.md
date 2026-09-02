# STATUS — where everything is, what actually works

Single page. If it isn't here, it isn't real. Updated 2026-09-02. Companion: ROADMAP.md (sequencing), CONTRACT.md (rules).

## The one place
**`SummerEngine/summer-engine-agent` branch `v3-foundation`** (PR #18 open, NOT for merging yet). Everything toolkit-side lives here. Nothing has shipped: origin `main` and npm `summer-engine@2.8.2` are untouched.

## What is verified working (how)
| Thing | Verified by |
|---|---|
| Registry compiler → all root manifests, index, counts, aliases | `generate:registry --check` no drift; 23 compiler tests; CI parity step |
| Library: 180 resources validate, capability lint clean (6 documented exceptions) | `validate:library` |
| `summer` CLI boots; `summer tool --list` (70) ; `summer skills list` (83) | `npm run build` + smoke |
| 56 pre-existing MCP tools (scene/debug/project/asset/generate/creator/file/screenshot) | unit tests; `summer tool summer_get_diagnostics` smoked against a live engine during the build |
| `summer_library_feedback` → live endpoint → Supabase table → /admin view | 29 MCP tests + 25 route tests; loopback wire proof; table verified live |
| Headless routing layer | 58 unit tests + fake worker; real-binary test SKIPS (no engine build) |
| Routing eval recall@5 = 1.0 on 83 queries | **caveat: tuned against the same queries — needs a held-out set before it means anything** |

## What exists as code but CANNOT work yet (engine ops unmerged)
14 tools marked `status: preview`, all degrade with `engine_lacks_op`:
scripting (run_script, run_editor_script, world_snapshot, snapshot_diff, get_runtime_tree, inspect_runtime_node), spatial (6), plus headless routing (flag `SUMMER_HEADLESS_ROUTING=1`) which needs the worker.
Unblocked by: **SummerEngine/SummerEngine PR #155 (headless worker) + #156 (scene scripting)** — rebased, opened, **never built**. Owner must build + smoke + merge.

## NOT yet done (honest)
- Cold-machine install test from the packed tarball (`npx` → setup → MCP handshake) — never run.
- Independent adversarial review of the v3 diff — never run; ~30 agent-authored commits merged on green gates only.
- Skill bodies still contain v2 `summer:<category>/<name>` invocation strings and `../../../references/template-registry.md` links (flagged during migration, unfixed).
- Held-out routing eval set.
- `feat/templates-mcp-tool` dirty checkout (someone's uncommitted `with-engine.ts` + `summer_list_templates` work) — unreconciled with v3's `with-engine.ts` changes.
- Count-guard tests pin literals (70/83) — brittle; superseded by counts.json, should be deleted.

## Other places (dependencies, not homes)
- Web repo branch `feat/library-feedback-mailbox` (endpoint + admin; pushed, no PR). Salt env set in Vercel. RLS fix applied.
- Web cloud cleanup: task chip pending (not started).
- Engine PRs #155 / #156 (above). Engine local `main` has 5 stale unpushed commits — abandon.

## Ship gates (all Mathias)
PR #18 → main **together with** web mailbox branch **and** npm publish 3.0.0; then rename repo → `summer`, org → `summerengine`; then web copy pass.
