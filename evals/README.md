# Evals

Evidence that the library works. Six families, one rule: **an eval that cannot
fail is documentation, not an eval.** Each family README defines its contract;
this file is the map.

| Family | Tests | Runner status | CI gate |
|---|---|---|---|
| [`routing/`](routing/) | Index + metadata quality: do real asks retrieve the right entries? | **LIVE** (`npm run eval:routing`) | no regression vs committed `baseline.json` |
| [`skills/`](skills/) | Behavioral specs: does following a skill produce correct behavior? | manual (`/skill-test`); 15 ported specs, gaps in `skills/GAPS.md` | none yet (needs LLM+engine harness) |
| [`examples/`](examples/) | Every example executes against its pinned engine + evidence re-verifies | typed interface + SKIP stub | stub runs green; real runner flips it to a gate |
| [`templates/`](templates/) | Pin integrity: clone-at-commit, tree-digest verify, project-opens smoke | contract defined; lands with template migration | steps 1–3 on `library/templates/**` PRs |
| [`tools/`](tools/) | Conformance: input_schema round-trips to zod + commander with zero drift | lands with the registry compiler (shares its derivation code) | vitest, once compiler lands |
| [`end-to-end/`](end-to-end/) | The make-a-game ladder E0–E5: whole-system builds of real games | definition binding; runner future | nightly/weekly, never per-PR |
| [`canary/`](canary/) | Blind A/B gateway: a stdio MCP proxy that hides or reveals one canary tool per arm, enforces a call budget, records evidence | **LIVE** (`npm run eval:canary`; needs `npm run build` + a fixture project) | none — manual trials; its policy core is unit-tested in `npm test` |
| [`outcomes/`](outcomes/) | Agent OUTCOMES, not op correctness: replayed trajectories against a fresh engine on pristine fixtures, judged by assertions over snapshots, the saved `.tscn`, a clean play and probe reads from the running game | **LIVE, MVP-0** (`npm run eval:outcomes`; needs `npm run build` + `SUMMER_EDITOR_BIN`; replay only, assertions only) | per PR `--dry-run` (schema + golden drift); the engine-backed replay is nightly, gated on committed `baseline.json` via `--check` |

## Routing eval (the one that runs today)

```
npm run eval:routing                       # run + gate against baseline
npm run eval:routing -- --update-baseline  # accept a new baseline (commit the diff)
npm run eval:routing -- --verbose          # includes the gap report
```

- Corpus: `registry/generated/index.json` when it exists; falls back to
  `library/skills/*/resource.yaml`, then to `skills/**` SKILL.md frontmatter
  (pre-migration). Same queries, same gate across all three — the eval survives
  the migration without edits.
- Ranker: BM25 over slug tokens (boosted) + summary/description + use_when.
  Deliberately dumb and deterministic: it measures METADATA quality, not LLM
  routing skill.
- Metrics: mean recall@5; hijack flags (a non-expected entry outranking every
  expected one); per-query recall.
- `expected_gap: true` queries are the authoring backlog — real asks the
  library cannot serve. They are reported, never scored. Filling one means
  editing `queries.yaml` + updating the baseline in the same PR as the new entry.

## CI

`.github/workflows/ci.yml`, on PR + push to `main`/`v3-foundation`:

1. `npm ci` (Node 22)
2. `tsc --noEmit`
3. `vitest run`
4. `npm run validate:library` (schemas + capability lint)
5. `npm run eval:routing -- --check` (regression gate)
6. `npm run eval:outcomes -- --dry-run` (task/assertion schema + golden drift; no engine)
7. registry parity (`generate:registry -- --check`) — soft-skips with a warning
   until the compiler lands, then becomes the CONTRACT §6 drift gate.

## Outcome eval (replay, assertions only — MVP-0)

```
npm run build
SUMMER_EDITOR_BIN=/path/to/summer-editor npm run eval:outcomes            # goldens + mutants, compared to baseline.json
SUMMER_EDITOR_BIN=… npm run eval:outcomes -- --check                       # also fails on a missing/stale baseline
SUMMER_EDITOR_BIN=… npm run eval:outcomes -- --update-baseline             # accept (commit the diff + engine.lock)
npm run eval:outcomes -- --dry-run                                         # per PR: no engine
```

The assertion vocabulary, how to add a task or a mutant, and the honesty
rules: [`outcomes/README.md`](outcomes/README.md).

## Changing the baseline

Baseline changes are code-reviewed like code. A PR may update
`routing/baseline.json` or `outcomes/baseline.json` only when the diff is
explained by the same PR (new entries, better metadata, new queries; a new
task, a new mutant, an engine change that is the intended fix). A PR that
lowers recall — or drops a passing golden — to get green is a rejected PR.
