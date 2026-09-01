# Example evals — must execute against a pinned engine

**What is tested:** that every `library/examples/<slug>/` actually works — the
project opens, runs headless without script errors, and its claimed evidence
checks pass — against the exact engine version its resource.yaml declares.

An example that does not execute is not an example; it is a liability with
sample code attached. CONTRACT.md §3 makes evidence REQUIRED for the kind.

## Contract (binding now, runner lands later — ROADMAP §3.4)

Per example:

1. **Resolve** the engine version from `resource.yaml` `compatibility.engine`
   and `evidence.engine_version` (pinned binary, cached in CI).
2. **Open** `project/` headless (import pass). Zero import errors.
3. **Run** the project's declared smoke entry (main scene or `evidence.checks`)
   headless for a bounded window. Zero script errors, zero debugger errors.
4. **Verify evidence claims**: every `checks` entry (`runs`, `screenshot`, ...)
   re-produces; in-repo media exists and is ≤200KB; URL media hashes match.
5. **Report** per-example pass/fail + engine version into a machine-readable
   result; CI fails on any fail, and a scheduled run re-executes the whole
   library on each engine release to auto-flag broken entries.

The runner interface is typed today in `runner-interface.ts` so the library
migration can author examples against a fixed contract. The stub runner exits
SKIP (exit code 0 + `SKIP` marker) until `library/examples/` and the pinned
engine fetcher exist.

## How to run

```
node evals/examples/runner-stub.ts     # SKIP until library/examples/ exists
```

## CI

The workflow calls the stub; SKIP is green. When the real runner replaces the
stub (same interface, same entry point), failures become red with no workflow
change.
