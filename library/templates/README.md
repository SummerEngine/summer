# library/templates/ — pin manifests

Each `library/templates/<slug>/resource.yaml` is a **pin manifest** (CONTRACT.md §7).
Template code lives in satellite repos under `github.com/SummerEngine`; this directory
holds only descriptors. `npm run generate:registry` compiles them into
`registry/generated/templates-registry.json`, which is the only thing the CLI reads at
runtime (`src/core/templates.ts`).

## Resolution (what `summer create <slug> [name]` does)

1. **Resolve** `<slug>` against the generated registry: exact id (`template/<slug>`),
   exact slug, exact alias (the legacy `template-<slug>` names), then an unambiguous
   prefix of a slug or alias. Ambiguity or no match is an error that lists what exists.
2. **Pinned template** (`repo` + `commit` + `tree_digest`):
   1. `git init` in the new directory, `git remote add origin <repo>`,
      `git fetch --depth 1 origin <commit>` — the exact 40-char SHA, never a branch.
      `default_branch` is informational only and is never consulted.
   2. Recompute `tree_digest` with the formula below and **refuse** on mismatch — the
      directory is removed and nothing is written.
   3. `git checkout <commit>` (detached). `.git` is removed unless `--keep-git`.
3. **Built-in template** (`builtin: true`, no pin): generated in-process by
   `BUILTIN_GENERATORS` in `src/cli/commands/create.ts` — no download.
4. **Record** the pin into the project's `.summer/project.json`
   (`src/project-memory/project-manifest.ts`, merged if the file exists):

   ```json
   { "template": { "id": "template/2d-platformer", "version": "1.0.0",
                   "repo": "https://github.com/SummerEngine/template-2d-platformer",
                   "commit": "<40 hex>", "tree_digest": "<64 hex>" },
     "toolkit_version": "<summer-engine package version>",
     "created_at": "<ISO 8601>" }
   ```

   Built-ins record `{ "id", "version", "builtin": true }` instead of a pin.

`summer list templates` prints the same registry (status, systems, preview notes). There
is no live GitHub-org listing anywhere in the CLI: a template that is not in this
directory is not installable.

## tree_digest formula

The digest is the SHA-256 of the exact output of:

```
git ls-tree -r <commit> --format='%(objectname) %(path)'
```

piped through `shasum -a 256` (equivalently `sha256sum`). That output is one line per
file — the git blob object ID, a space, and the path — in git's canonical path order
with newline-terminated lines. It is deterministic across git versions (unlike
`git archive`, whose bytes vary), and any change to any file's content or path changes
the digest. `--format` needs git ≥ 2.36. `computeTreeDigest` in `src/core/templates.ts`
runs exactly this command and hashes its stdout bytes; the unit test checks it against
the shell pipeline on a fixture repo.

To verify a pin locally:

```
git init t && cd t
git remote add origin <repo>.git
git fetch --depth 1 origin <commit>
git ls-tree -r <commit> --format='%(objectname) %(path)' | shasum -a 256
```

## Schema: builtin XOR pin

`registry/schemas/template.schema.json` accepts exactly one of two shapes:

- **pinned**: `repo`, `commit` (40 hex), `tree_digest` (64 hex), optional
  `default_branch`, `zip`;
- **builtin**: `builtin: true` and none of the pin fields.

Declaring both, or neither, fails `npm run validate:library`.

## Built-in templates (`empty`, `3d-basic`)

The two built-ins are not satellite repos: `summer create` generates them locally, so
their manifests declare `builtin: true` and carry no pin. Their `facets.domains` include
`builtin`. A test (`src/cli/commands/create.test.ts`) asserts that the set of
`builtin: true` manifests equals the set of generators in the CLI.

## Status and private repos

A manifest whose repo the public CLI cannot fetch must not be `stable`. Mark it
`status: preview` with a `do_not_use_when` note; `summer create` prints the note as a
warning and the fetch fails fast (git never prompts for credentials).

## Updating a template

1. Land the change in the satellite repo.
2. Open a PR here that bumps `commit` to the new SHA, recomputes `tree_digest` with the
   formula above, and bumps `version` in the manifest.
3. CI validates the manifest; the pin only moves when this PR merges. There is no other
   update path — pushing to the satellite repo alone changes nothing for users.
