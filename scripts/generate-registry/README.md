# generate-registry — the registry compiler

One definition, every surface; drift is a build failure (CONTRACT.md §6).

Reads every `library/<kind-plural>/<slug>/resource.yaml` (validated first via
`scripts/validate-library`) and emits `registry/generated/`, then applies the
agent manifests to their repo-root destinations.

## Commands

```bash
# Generate registry/generated/ AND apply manifests to the repo root
node scripts/generate-registry/cli.ts

# CI parity gate: regenerate, byte-compare committed output + applied root
# manifests, verify doc count claims. Writes nothing. Exit 1 on drift.
node scripts/generate-registry/cli.ts --check

# Generate without touching the root manifests
node scripts/generate-registry/cli.ts --no-apply
```

The CLI refuses to generate from an empty or missing `library/` unless
`--allow-empty` is passed, so a half-migrated tree can never clobber the real
root manifests with empty skill lists.

Requires Node >= 22.18 (native TypeScript type stripping), same as
`scripts/validate-library`.

## Outputs (all into `registry/generated/`)

| File | Contents |
|---|---|
| `index.json` | Searchable catalog: id, kind, version, content_hash, summary, use_when, facets, compatibility, related, status (sorted by id) |
| `counts.json` | Per-kind totals + grand total (README badges, website `toolsNumber`) |
| `aliases.json` | legacy alias -> id map (generation fails on a duplicate alias) |
| `skills-registry.json` | Data replacing the hand-written TS `SKILL_REGISTRY`: id, name, description, clients, path |
| `templates-registry.json` | What `summer create` / `summer list templates` read (`src/core/templates.ts`): id, slug, version, summary, status, aliases, systems, do_not_use_when, path, and `builtin` or `pin {repo, commit, tree_digest, default_branch}` |
| `plugin.claude.json` | -> `.claude-plugin/plugin.json` |
| `marketplace.claude.json` | -> `.claude-plugin/marketplace.json` |
| `plugin.codex.json` | -> `.codex-plugin/plugin.json` |
| `plugin.cursor.json` | -> `.cursor-plugin/plugin.json` |
| `plugin.factory.json` | -> `.factory-plugin/plugin.json` |
| `gemini-extension.json` | -> `gemini-extension.json` |

Apply targets live in `targets.ts` (source of truth, one key per supported
client) and are mirrored by the committed
`integrations/<agent>/manifest-target.json` files; a test fails if they drift
apart. Clients without a generated manifest (windsurf, cline, roo-code,
kilo-code, github-copilot, vscode-copilot, opencode, lm-studio) have empty
target lists — their `integrations/<agent>/README.md` documents exactly what
`summer setup <client>` writes instead. See `integrations/README.md` for the
complete agent-support map.

Every output is deterministic: stable key order, sorted resource and skill
lists, 2-space JSON, trailing newline, and a `_generated` banner field.
Catalog files carry "GENERATED — do not edit; run npm run generate:registry";
agent manifests carry "GENERATED from integrations/<agent> — do not edit;
npm run generate:registry" because the applied root dot-files are build
artifacts of `integrations/<agent>` + `library/`. Agent hosts ignore unknown
manifest fields.

Manifest conventions preserved per agent (fields and field order match the
pre-v3 manifests, see `migration/manifests-inventory.json`), with three
deliberate changes:

1. every manifest carries the FULL skill list (the historical 4-skill
   codex/cursor gap and 0-skill factory/gemini gaps were bugs);
2. skill paths point at `./library/skills/<slug>/`;
3. `version` fields and the numeric tool-count claims inside descriptions are
   stamped from `package.json` and the real tool count (they had drifted to
   58/62/52/50+ across manifests).

## content_hash formula

`content_hash` identifies the exact bytes of a resource directory so feedback
and evidence attribute to `id@content_hash` (CONTRACT.md §4):

1. List every regular file under the resource dir, recursively (symlinks and
   empty dirs are ignored). No exclusions — `resource.yaml` itself is included.
2. Sort by POSIX-style relative path (byte order, `/` separators).
3. Build the manifest string: for each file, append
   `<relative-path>` + `\n` + `<sha256 hex of file bytes>` + `\n`.
4. `content_hash` = sha256 hex of the UTF-8 manifest string.

Reference implementation: `computeContentHash()` in `index.ts`.

## Count-claims guard (part of `--check`)

Scans `README.md`, `AGENTS.md`, `GEMINI.md` for numeric claims matching
`\b(\d+)[ -](tools?|skills?)\b` (e.g. "58 tools", "58-tool", "3 skills") and
fails when the number differs from `counts.json`.

Limitations (simple, honest regex — by design):

- `50+ tools`, spelled-out numbers, and prose separating number from noun are
  not checked.
- Every match is compared against the library counts; docs counting something
  else under the same noun must rephrase.

## Tests

`scripts/generate-registry/*.test.ts` (vitest, self-contained fixtures under
`fixtures/` — they never depend on the real `library/`):
determinism, alias-collision failure, empty-library refusal, check-mode drift
detection (all three drift classes), count-claims guard, manifest golden
shapes, targets/manifest-target.json parity.
