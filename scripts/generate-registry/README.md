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

# ALSO write the optional embeddings sidecar for semantic library search
# (needs a Summer login or SUMMER_EMBED_URL; never run in CI — see below)
node scripts/generate-registry/cli.ts --embed
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
| `skills-registry.json` | Data replacing the hand-written TS `SKILL_REGISTRY`: id, name, description, clients, recommended, status, path |
| `templates-registry.json` | What `summer create` / `summer list templates` read (`src/core/templates.ts`): id, slug, version, summary, status, aliases, systems, do_not_use_when, path, and `builtin` or `pin {repo, commit, tree_digest, default_branch}` |
| `plugin.claude.json` | -> `.claude-plugin/plugin.json` |
| `marketplace.claude.json` | -> `.claude-plugin/marketplace.json` |
| `plugin.codex.json` | -> `.codex-plugin/plugin.json` |
| `plugin.cursor.json` | -> `.cursor-plugin/plugin.json` |
| `plugin.factory.json` | -> `.factory-plugin/plugin.json` |
| `gemini-extension.json` | -> `gemini-extension.json` |
| `embeddings.json` | OPTIONAL sidecar written only by `--embed`: one vector per resource for semantic library search (`summer_search_library`). Not part of parity; see below |

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

## Embeddings sidecar (optional, `--embed`)

`summer_search_library` is lexical by default (BM25, `src/core/registry-search.ts`).
When `registry/generated/embeddings.json` ships with the package, the runtime also
embeds the query and fuses the two rankings (reciprocal rank fusion, k = 60;
`src/core/library-search.ts`). `--embed` is the step that writes that file
(`embed.ts`):

- **Text per resource:** `summary` + `use_when` lines + facet tokens
  (`buildEmbeddingText` in `src/core/embeddings.ts` — the same function at
  compile time and runtime). Bodies are never embedded.
- **Provider:** the same protocol runtime search uses — `POST { text }` ->
  `{ vector, model? }` at `SUMMER_EMBED_URL`, else `<gateway>/api/mcp/embed`
  (gateway = `SUMMER_GATEWAY_URL`, else `~/.summer/config.json` `gateway.url`,
  else production). The gateway endpoint needs the Summer account token from
  the existing auth store (`SUMMER_TOKEN`, else `~/.summer/auth-token`); a
  custom `SUMMER_EMBED_URL` may not. 15 s per request, 4 in flight.
- **Cache by `content_hash`:** only resources whose hash changed since the
  committed sidecar are re-embedded; unchanged vectors are kept byte-for-byte;
  ids that left the index are pruned. A provider reporting a different `model`
  than the sidecar recomputes everything; a different vector length aborts with
  the fix (delete the file, re-run).
- **File:** `{ _generated, model, dims, encoding: "base64-float32", entries: { "<id>": { content_hash, vector } } }`,
  entries sorted by id. Vectors are little-endian float32, base64-encoded:
  about 2.1 KB per 384-dim entry — 0.43 MB for 200 entries, ~21 MB for 10 000
  (measured; a rounded JSON number array is 3.3x larger, full precision 5.3x).
  Int8 quantization (~0.6 KB per entry) is the lever if the library reaches
  thousands of entries.
- **`--check` never fails on it.** Vectors are nondeterministic across
  providers and the file is optional, so parity ignores its contents. `--check`
  only WARNs (exit 0) when an entry's `content_hash` no longer matches the
  index, when an index entry has no vector, or when a vector's id left the
  index (`checkEmbeddings`). A missing file is fine. CI does not embed.
- **Runtime degradation:** no file, no network, provider error, or
  `SUMMER_EMBED_URL=off` -> lexical only, `matched_by: ["lexical"]`, never an
  error. Stale vectors are still used.

## Count-claims guard (part of `--check`)

Scans the docs that actually carry numeric claims — `README.md`, `AGENTS.md`,
`GEMINI.md`, `CLAUDE.md`, `library/references/**/*.md`, `_persona/**/*.md`,
`.opencode/**/*.md`, `docs/*.md` (top level only; `docs/design/` is a dated
historical record), `integrations/**/*.md` — for claims matching
`(?<![\w.])(\d+)[ -](tools?|skills?)(?![\w-])` (e.g. "58 tools", "58-tool",
"3 skills") and fails when the number differs from `counts.json`. The
look-arounds keep "4.6 tools" and "pre-v3 skill" (versions), "skills-based",
and "3-toolkit" from matching.

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
shapes, targets/manifest-target.json parity. `embeddings.test.ts` covers the
sidecar with a mocked provider: incremental recompute by `content_hash`,
pruning, model change, dims mismatch, the `--check` warnings, and endpoint /
token resolution.
