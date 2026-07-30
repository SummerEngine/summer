# Gate E3: Creator CLI and MCP

Status: publish and release history are implemented against
`summer.creator.v1`; runtime logs remain explicitly unsupported.

Last audited: 2026-07-30 against Summercraft main
`76b893838be0743912efa2d35484966a5ee0156d`.

## What works

- `POST /api/creator/v1/publish` supports `prepare` and `finalize`.
- Publish delegates to the existing immutable R2 upload, checksum, ownership,
  rate-limit, review, and release-record plane.
- `GET /api/creator/v1/releases` returns creator-owned cursor-paginated
  history.
- The server independently verifies the existing exact `publish` scope and
  project ownership on every request.
- Creator runtime logs are not fabricated. No route is enabled because the
  platform has no durable log owner, retention policy, redaction policy, or
  authorized query store.

The core Summer browser-login JWT remains `type=cli`, `aud=summer-cli`.
It is not a Summercraft creator token and is never overwritten or repurposed.

## Local credential and config contract

All surfaces share the secured `~/.summer/` directory:

| File | Purpose |
|---|---|
| `auth-token` | Core Summer CLI JWT. Existing filename preserved for Summer Engine consumers. |
| `cloud-token` | Existing separate Summer Cloud credential. |
| `creator-token` | Separate Summercraft `sc_` token with exact `publish` scope. |
| `user.json` | Core identity matched against the CLI JWT subject before persistence. |
| `credential-metadata.json` | Non-secret audience, scope, type, and expiry metadata. |
| `config.json` | Versioned non-secret CLI/MCP configuration. |
| `creator-audit.jsonl` | Secret-free local creator publish attempts and outcomes. |

On POSIX, the directory is `0700` and files are `0600`. Writes use
same-directory temporary files and atomic rename. Symlinked credential files
are refused. Logout clears identity credentials, including `creator-token`,
but does not rotate or rename any platform secret.

Normal users need no new environment variables. Defaults are:

- Summer gateway: `https://www.summerengine.com`
- Summercraft creator API: `https://summercraft.ai`

Supported non-secret config keys:

- `gateway.url`
- `creator.apiUrl`
- `creator.projectId`
- `creator.channel`

Remote origins require HTTPS; HTTP is accepted only for loopback development.
`creator.channel` currently supports only `production`, because the v1 backend
does not pretend to provide preview-channel semantics.

## One-time creator setup

1. Keep using `summer login` for core Summer identity.
2. Run `summer login --creator`.
3. The CLI opens Summercraft creator token settings.
4. Mint a token with the exact `publish` scope and paste the one-time `sc_`
   value into the hidden terminal prompt.
5. Configure the Summer game UUID:
   `summer config set creator.projectId <uuid>`.

The additive `cApiTokens` catalog objects already exist and are recorded in
shared Supabase migration history as version `20260730073920`. The client
treats server token refusal as authoritative and never falls back to an
unrelated credential.

## Publishing

The CLI never guesses an export layout or silently builds an artifact:

```text
summer publish . \
  --artifact /absolute/path/to/game.pck \
  --version 1.0.0 \
  --notes "First release"
```

The first call omits `--confirm`. It computes the real size and SHA-256,
records the target locally, and returns the exact project, version, digest,
size, and path without making a network request.

Only after the user approves that exact target should the command be repeated
with `--confirm`. The client then:

1. recomputes artifact digest and size;
2. sends `operation=prepare` with an exact repeated confirmation object;
3. validates the versioned response, HTTPS or loopback upload URL, expected
   content type, and `if-none-match: *`;
4. streams the `.pck` directly to the presigned URL without exposing the
   creator token to object storage;
5. sends `operation=finalize` with the same exact target;
6. accepts success only when the server echoes the project, version, digest,
   size, valid release ID, and `pending_review` state;
7. records a secret-free success or failure in `creator-audit.jsonl`.

The same implementation backs `summer_creator_publish`. Agents must call it
with `confirm=false`, present the exact target, obtain approval, and only then
call it with `confirm=true`.

`summer releases` and `summer_creator_releases` return real history. The
opaque `nextCursor` must be reused unchanged. `summer logs` and
`summer_creator_logs` fail closed until a durable log plane exists.

## Remaining activation work

| Residual | Owner / next action |
|---|---|
| No real disposable-token artifact witness from the canonical npm client | Operator: after merge and release, mint a disposable scoped token, publish a non-production witness artifact through review, verify history, then revoke it. |
| No npm release containing this client | CLI release owner: version and publish only after this PR is merged and reviewed. This change does not publish npm. |
| No durable runtime-log source | Runtime platform: define ingestion, retention, redaction, authorization, and query ownership first. |
| No automatic export handoff | Export pipeline: produce an immutable `.pck` explicitly; the CLI must not guess or build without approval. |
| Finalize response can be lost after server success | Operator: query `summer releases` before retrying; immutable version/digest prevents silent replacement. |
| Broader public-language corpus still contains technical upstream references | Docs owner: audit remaining references by context, preserving legal/history and technical node/file-format facts while keeping product language Summer-first. |

Focused tests use temporary stores, artifact files, and mock HTTP/object-store
responses. They perform no production requests, secret changes, migrations,
deployments, npm publishing, or key rotation.
