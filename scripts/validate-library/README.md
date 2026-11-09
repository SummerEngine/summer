# validate-library

CI gate for `library/**` (CONTRACT.md §5–§6). Run with:

```
npm run validate:library
```

What it checks:

1. Every `library/<kind-plural>/<slug>/resource.yaml` parses and validates
   against its kind schema in `registry/schemas/` (`tool|skill|example|
   template|collection|reference.schema.json`, all extending
   `resource.schema.json`). Validation is JSON-Schema based via the strict
   subset validator in `json-schema.ts` — the schema files are the single
   normative source; there is no parallel zod definition.
2. Identity integrity: id matches kind and directory; duplicate IDs;
   duplicate aliases; aliases colliding with live IDs.
3. Link integrity: every `related.*` (and collection `recommended.*`) target
   exists in the library.
4. Kind file requirements: skills have `SKILL.md`; references have a body
   `.md`; examples have schema-required `evidence`; stable collections have
   per-item `sha256`.
5. Evidence media: in-repo `path` files exist, stay inside the resource dir,
   and are ≤ 200KB (larger media must be URL + sha256).
6. Capability lint over all resource.yaml strings and all `.md` bodies
   (HTML comments included — hidden text is where injected instructions go):
   - `url-allowlist` — `http(s)://` URLs (any letter case) outside
     `registry/schemas/allowed-hosts.json`; scheme-relative `//host/path`
     and bare-domain `host.tld/path` forms checked against the same
     allowlist; `ftp|sftp|file|smb|ssh|git|...://` and `data:` URIs always
     rejected. Loopback URLs (`localhost` / `127.0.0.1`, any port) are always
     allowed: skills legitimately document bundled local servers, and a
     loopback URL only reaches software already running on the user's own
     machine. Godot `res://` `user://` `uid://` paths are not URLs and do
     not fire.
   - `install-command` — npm/pnpm/yarn/pip/brew/cargo/gem/apt/choco/winget/
     scoop/bun/bunx/deno install|add, `go install <host/path>` (bare "go
     add"/"go install" prose is English), `curl … | sh` including multi-line
     invocations, `curl … && sh`, wget, `npx` executing a non-summer-engine
     package. The npx check only fires on a plausible package token (scoped
     `@scope/name`, or containing a hyphen, dot, slash, or digit) or when
     forced with `-y`/`--yes`; bare dictionary words after "npx" in prose
     ("npx to resolve…", "old npx package material") are not commands and do
     not fire it. The tradeoff is deliberate: a plain-word package invocation
     ("npx vite") can slip through un-forced, but prose false-positives would
     train authors to scatter lint exceptions, which is worse.
   - `credential-pattern` — `~/.ssh`, `~/.aws|.npmrc|.config/gh|.docker|.kube`,
     `.env`, `AWS_`, `API_KEY`, `SECRET|PASSWORD|PASSWD|TOKEN…[:=]`
     (uppercase, not prefixed by another identifier), `token=`, `Bearer <x>`
   - `destructive-command` — `rm -rf` on `~`, `/…`, or `$HOME`; `ssh user@host`
   - `base64-blob` — ≥ 160 consecutive base64 or base64url characters
     (must contain a letter and a digit, so 160 dashes is a rule, not a
     blob), or two adjacent pure-alphabet lines that together reach 160
   - `invisible-unicode` — zero-width and bidi-control characters, invisible
     math operators U+2061..2064, U+180E, Hangul fillers U+3164/U+FFA0, the
     U+E0000..E007F tag block, and a stray variation selector-16 (U+FE0F not
     directly after an emoji/symbol base)
   - `prompt-injection-phrase` — "ignore (all) previous/prior/above/earlier",
     "ignore the user", "ignore what the user", "ignore your system prompt",
     "disregard … instructions/prompt/rules", "new instructions:", and
     "do not tell the user" when followed within 40 chars by
     about/instructions/prompt/rules/hidden/secret/this message|file|…
     (plain "do not tell the user a shot is done" is game-dev guidance and
     does not fire)

   A resource may allowlist a rule with `lint_exceptions: [rule-id]` plus a
   mandatory `lint_exception_reason`; granted exceptions are printed loudly
   on every run.
7. Controlled facet vocabularies: every `facets.domains` and
   `facets.modalities` item must appear in `registry/schemas/domains.json`
   (`domains` / `modalities` lists; per-token meaning in `notes`).
   `resource.schema.json` reaches the lists via `$ref: "domains.json#/domains"`
   — the strict validator treats a `$ref` that resolves to a JSON *array* as
   "the value must be one of these members", so the vocabulary lives in one
   plain, PR-reviewable file and is never duplicated into the schema. An
   unknown token fails with
   `unknown domain "retro-vibes"; allowed: … (add it to registry/schemas/domains.json by PR)`.
   `facets.lifecycle` stays a fixed inline enum (build|launch|grow|support).
8. Minimum routing metadata (routing searches summary + use_when +
   facets.domains, so thin metadata is unfindable metadata): `summary` is
   40..160 chars and every `use_when` item is >= 12 chars (both in
   `resource.schema.json`); skills, tools, examples, and references carry
   >= 2 `use_when` items and >= 2 `facets.domains` (templates and
   collections may carry one `use_when`); no `use_when` item may repeat the
   summary verbatim. Messages say which kind, what it has, and what it needs.
9. Reciprocity hint (WARN, never an error): when skill A lists skill B in
   `related.skills` and B does not list A back, one `WARN` line is printed per
   one-way link. One-way links are legitimate (hub skills fan out), so the
   exit code is unaffected; the line exists so authors decide deliberately.
   Only skill<->skill pairs are checked.

10. Skill description budget: the SKILL.md descriptions of every skill a bulk
    install takes (not `bundled: false`, not deprecated) add up to at most
    `SKILL_DESCRIPTION_BUDGET` (12,000) characters. Hosts inject every
    installed description into every session and truncate past their own
    budget. The CLI prints the total on every run.
11. No path out of a skill folder: `summer setup` copies each skill folder
    alone, so a `../` path in any skill `.md` (markdown link, inline code or
    prose; fenced code is skipped) that resolves outside the folder fails
    (`skill-links.ts`).
12. Call examples: every `summer_x(…)` / `summer_x {…}` example in a skill
    `.md` passes each required `input_schema` argument of its tool's
    descriptor and no argument the tool does not take
    (`call-examples.ts`). Examples with `...` and forms that do not parse are
    skipped and counted; tools without a descriptor are skipped.

13. Shell commands: every skill that names an MCP tool or an operation ends
    with the "From a shell" section `shell-commands.ts` renders from the
    operation catalog (`registry/operations/legacy-names.json` and the 4.0
    rule `summer_<area>_<action>` = `area.action`): each name with its
    `summer <area> <action>` command. A stale or missing section fails, and
    so does a 4.0 tool name whose operation the catalog does not have (a
    typo); `npm run generate:registry` writes the section. Trees without the
    catalog (test fixtures) are not checked.

Exit codes: 0 clean (including when `library/` does not exist), 1 on any
violation; `WARN` lines never change the exit code. Requires Node >= 22.18
(native TypeScript type stripping).

Tests: `src/lib/registry/*.test.ts` (vitest), fixtures under `fixtures/`.
