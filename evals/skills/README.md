# Skill evals — behavioral specs

**What is tested:** that an agent following a skill produces the right behavior — correct tool sequences, correct artifacts, correct refusals/clarifications — not that the skill's prose reads well.

## Format

One spec per skill in `specs/<slug>.md`. YAML frontmatter + the case body:

```yaml
---
spec: eval/skill-spec/<slug>     # spec identity
skill: skill/<slug>              # the library ID under test (CONTRACT.md §4)
status: ported | tbd             # tbd = stub, listed in GAPS.md
source: tests/specs/<file>.md    # provenance (original prose spec)
runner: manual                   # manual today; automated harness is ROADMAP §3.4
---
```

Body structure (inherited from the original prose specs, kept because it works):

- **Fixture** — exact starting state: project contents, scene tree, MCP availability.
- **Cases** — each with `Input` (the literal user message), expected tool
  sequence / behavior, and checkbox **Assertions**. Every spec should cover at
  minimum: happy path, one failure/collision path, one ambiguity/edge case,
  and (where relevant) the no-MCP fallback path.
- Assertions must be observable facts (a node exists, a question was asked
  before a write, a tool was NOT called) — never vibes.

## How to run

Today: manually, via `/skill-test <slug> spec` (see `skills/workflow/skill-test/`),
or by handing the fixture + input to an agent and checking assertions by hand.
`skill-improve` uses these specs as its with/without harness.

Automated execution (LLM-driven, against a live engine fixture) is a
fast-follow, not part of the v1 cut — ROADMAP §3 item 4. The specs are written
so that the future runner needs no reformatting: fixture is machine-buildable,
inputs are literal strings, assertions are checkable predicates.

## CI

No CI gate yet (nothing to execute deterministically without an LLM + engine).
What CI does enforce today: every `specs/*.md` must have valid frontmatter whose
`skill:` ID exists in the library — checked by the routing runner's corpus and
eyeballed in review. When the automated runner lands, `status: ported` specs
become required gates for changes to their skill.

## Coverage

- 15 ported specs in `specs/` (from `tests/specs/`, the 21 prose specs minus stubs).
- 6 TBD stubs tracked in `GAPS.md`.
- 58 skills have no spec at all — also in `GAPS.md`.
