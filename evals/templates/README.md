# Template evals — pin integrity + project-opens smoke

**What is tested:** that every `library/templates/<slug>/` resolves to exactly
the bytes it pins, and that those bytes open as a working project. Templates
are the one kind whose body lives OUTSIDE this repo (satellite repos), so the
eval defends the pin, not the content.

## Contract (CONTRACT.md §5 template extension + §7)

Per template resource.yaml, in order:

1. **Clone at pin.** `git clone <repo>` then `git checkout <commit>` (full SHA).
   Never the default branch — `default_branch` is informational only. A clone
   that cannot reach the pinned commit is a FAIL (force-push or history rewrite
   upstream: the pin is broken and the resource must be re-pinned deliberately).
2. **Digest verify.** Recompute the tree digest (sha256 over the checked-out
   tree, `.git` excluded, stable file ordering) and compare to `tree_digest`.
   Mismatch = FAIL, even at the right commit — catches smudge filters, LFS
   surprises, and digest-computation drift.
3. **Zip parity** (when `zip` is declared): download, sha256-verify, and
   confirm the zip tree matches the git tree digest.
4. **Project-opens smoke.** Headless import of the checked-out project against
   the engine version in `compatibility.engine`: zero import errors, main scene
   declared and loadable, then the template's `smoke_test` eval ref (which
   points back into this evals/ tree) if present.
5. **Record** `{template_id, version, commit, tree_digest, engine}` per result —
   the same tuple `summer create` writes into `.summer/project.json`, so the
   eval exercises the exact resolution path users get.

## How to run

Runner lands with the template migration (templates are being pinned in wave 6;
resolving live repos to commit + digest is part of that work). Steps 1–3 are
pure git + hashing and need no engine; they become the first automated slice.

## CI

Steps 1–3 on every PR touching `library/templates/**` (cheap, network-only).
Step 4 scheduled + on engine-version bumps, alongside the example runner.
