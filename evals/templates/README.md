# Template evals — pin integrity + project-opens smoke

**What is tested:** that every `library/templates/<slug>/` resolves to exactly
the bytes it pins, and that those bytes open as a working project. Templates
are the one kind whose body lives OUTSIDE this repo (satellite repos), so the
eval defends the pin, not the content.

## Contract (CONTRACT.md §5 template extension + §7)

Per template resource.yaml, in order:

1. **Fetch at pin.** `git init`, `git remote add origin <repo>`,
   `git fetch --depth 1 origin <commit>` (full SHA), `git checkout <commit>` —
   exactly what `materializePinnedTemplate` in `src/core/templates.ts` does.
   Never the default branch — `default_branch` is informational only. A fetch
   that cannot reach the pinned commit is a FAIL (force-push or history rewrite
   upstream: the pin is broken and the resource must be re-pinned deliberately).
2. **Digest verify.** Recompute the tree digest with the ONE formula in
   [`library/templates/README.md`](../../library/templates/README.md) —
   sha256 of `git ls-tree -r <commit> --format='%(objectname) %(path)'` — and
   compare to `tree_digest`. Mismatch = FAIL, even at the right commit —
   catches history rewrites and digest-computation drift. (There is no
   working-tree digest; hashing checked-out bytes would vary with smudge filters
   and line endings, which is why the formula hashes git object IDs.)
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

Steps 1–2 exist today as the gated unit test in `src/core/templates.test.ts`
(`SUMMER_E2E=1 npx vitest run src/core/templates.test.ts` fetches
`template/2d-platformer` at its pin and asserts the digest). A runner over
every manifest is the next slice; steps 1–3 are pure git + hashing and need
no engine.

## CI

Steps 1–3 on every PR touching `library/templates/**` (cheap, network-only).
Step 4 scheduled + on engine-version bumps, alongside the example runner.
