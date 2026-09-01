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
6. Capability lint over all resource.yaml strings and all `.md` bodies:
   - `url-allowlist` — URLs outside `registry/schemas/allowed-hosts.json`.
     Loopback URLs (`localhost` / `127.0.0.1`, any port) are always allowed:
     skills legitimately document bundled local servers, and a loopback URL
     only reaches software already running on the user's own machine — it
     cannot fetch remote content or exfiltrate data.
   - `install-command` — npm/pnpm/yarn/pip/brew install, `curl | sh`, wget,
     `npx` executing a non-summer-engine package. The npx check only fires
     on a plausible package token (scoped `@scope/name`, or containing a
     hyphen, dot, slash, or digit) or when forced with `-y`/`--yes`; bare
     dictionary words after "npx" in prose ("npx to resolve…", "old npx
     package material") are not commands and do not fire it. The tradeoff is
     deliberate: a plain-word package invocation ("npx vite") can slip
     through un-forced, but prose false-positives would train authors to
     scatter lint exceptions, which is worse.
   - `credential-pattern` — `~/.ssh`, `.env`, `AWS_`, `API_KEY`, `token=`
   - `base64-blob` — > 200 consecutive base64 characters
   - `invisible-unicode` — zero-width and bidi-control characters
   - `prompt-injection-phrase` — "ignore previous", "ignore the user"

   A resource may allowlist a rule with `lint_exceptions: [rule-id]` plus a
   mandatory `lint_exception_reason`; granted exceptions are printed loudly
   on every run.

Exit codes: 0 clean (including when `library/` does not exist yet), 1 on any
violation. Requires Node >= 22.18 (native TypeScript type stripping); use
`/opt/homebrew/bin/node` locally.

Tests: `src/lib/registry/*.test.ts` (vitest), fixtures under `fixtures/`.
