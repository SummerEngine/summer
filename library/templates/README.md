# library/templates/ — pin manifests

Each `library/templates/<slug>/resource.yaml` is a **pin manifest** (CONTRACT.md §7).
Template code lives in satellite repos under `github.com/SummerEngine`; this directory
holds only descriptors.

## Pinning rule (normative)

`summer create <slug>` resolves through the template's resource.yaml **only**:

1. Clone `repo` at `commit` (the exact 40-char SHA in the manifest).
2. Verify `tree_digest` (formula below) against the checked-out tree.
3. Record `{template_id, version, commit, tree_digest}` into the project's `.summer/project.json`.

**Never resolve a default branch at runtime.** `default_branch` is informational only.
GitHub-org listing survives only as discovery UX for humans, never as resolution truth.

## tree_digest formula

The digest is the SHA-256 of the exact output of:

```
git ls-tree -r <commit> --format='%(objectname) %(path)'
```

piped through `shasum -a 256` (equivalently `sha256sum`). That output is one line per
file — the git blob object ID, a space, and the path — in git's canonical path order
with newline-terminated lines. It is deterministic across git versions (unlike
`git archive`, whose bytes vary), and any change to any file's content or path changes
the digest.

To verify a pin locally:

```
git init t && cd t
git remote add origin <repo>.git
git fetch --depth 1 origin <commit>
git ls-tree -r <commit> --format='%(objectname) %(path)' | shasum -a 256
```

## Built-in templates (`empty`, `3d-basic`)

The two built-ins are not satellite repos: `summer create` generates them locally from
`BUILTIN_TEMPLATES` in `src/commands/create.ts` (no download). Because the template
schema requires a pin, their manifests pin the generator's source — the
`SummerEngine/summer-engine-agent` repo at the migration-inventory commit — and their
`facets.domains` include `builtin` to mark them. Their tree_digest covers that repo's
tree at the pinned commit, not a template project tree.

## Updating a template

1. Land the change in the satellite repo.
2. Open a PR here that bumps `commit` to the new SHA, recomputes `tree_digest` with the
   formula above, and bumps `version` in the manifest.
3. CI validates the manifest; the pin only moves when this PR merges. There is no other
   update path — pushing to the satellite repo alone changes nothing for users.
