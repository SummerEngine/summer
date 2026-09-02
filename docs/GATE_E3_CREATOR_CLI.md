# Gate E3: Creator CLI and MCP Contract

Status: publish and release history implemented against `summer.creator.v1`;
runtime logs remain explicitly unsupported.

Last audited: 2026-07-30 against Summercraft main
`76b893838be0743912efa2d35484966a5ee0156d`.

## What exists now

- Summercraft exposes `POST /api/creator/v1/publish` and
  `GET /api/creator/v1/releases`.
- Publish delegates to the existing immutable R2 prepare/finalize, streamed
  checksum, ownership, rate-limit, review, and release-record plane.
- Releases returns creator-owned, cursor-paginated history.
- Both routes accept browser/Supabase identity or a Summercraft `sc_` API token.
  API tokens need the exact existing `publish` scope. The server independently
  verifies that scope and project ownership on every call.
- No creator runtime-log route exists because Summercraft has no durable
  runtime-log owner, retention policy, redaction policy, or query store.

The Summer Engine browser-login JWT is still `type=cli`, `aud=summer-cli`.
That credential is used by the engine and existing Summer gateway surfaces; it
is not a Summercraft creator token. The CLI never overwrites or repurposes it.

## One shared local store

All local surfaces use `~/.summer/`. The store contract is:

| File | Secret | Owner / purpose |
|---|---:|---|
| `auth-token` | yes | Canonical Summer CLI JWT. Filename preserved because Summer Engine already reads it. |
| `cloud-token` | yes | Legacy: written by v2 logins for the since-removed Summer Cloud sync. v3 never writes or reads it; `summer logout` still deletes it. |
| `creator-token` | yes | Separately scoped Summercraft `sc_` API token. Never copied into `auth-token`. |
| `api-token`, `api-port` | yes / no | Ephemeral local-engine discovery written by the running engine. Creator commands do not rewrite them. |
| `user.json` | personal | Identity matched against the Summer CLI JWT subject before persistence. |
| `credential-metadata.json` | no | Advisory audience, token type, scopes, and expiry only. Never contains token bytes. |
| `config.json` | no | Versioned non-secret CLI/MCP configuration. |
| `creator-audit.jsonl` | no | Local publish target, confirmation, status, and release ID. Never contains tokens or presigned URLs. |

On POSIX, the directory is repaired to `0700` and files to `0600`. Writes use
same-directory temporary files and atomic rename. Symlinked store files are
refused. Logout removes all identity credentials, including `creator-token`,
but preserves config, audit history, and a running engine's local token.

Do not rename, consolidate, derive, rotate, or reuse `auth-token`,
`cloud-token`, `creator-token`, `api-token`, or any signing secret without
coordinating every owning consumer first.

## Configuration and environment

Normal users need no environment variables. Defaults are built in:

- Summer gateway: `https://www.summerengine.com`
- Summercraft creator API: `https://summercraft.ai`

Supported non-secret keys:

- `gateway.url`
- `creator.apiUrl`
- `creator.projectId`
- `creator.channel`

`creator.channel` must currently be `production`; the v1 backend does not
pretend to have preview-channel semantics. Remote origins require HTTPS; HTTP
is accepted only for loopback development. Tokens cannot be set or returned
through `summer config` or the MCP config tool.

`SUMMER_GATEWAY_URL` remains an optional gateway-development override. No new
creator environment variable is required.

## One-time setup

1. Keep using `summer login` for the core Summer identity.
2. Run `summer login --creator`. The CLI opens
   `https://summercraft.ai/creator/settings/tokens`.
3. In the browser, mint a token with the exact `publish` scope and copy the
   one-time `sc_` value.
4. Return to the hidden terminal prompt and paste it. The CLI stores it in
   `~/.summer/creator-token`; `auth-token` is unchanged.
5. Configure the Summer game UUID:
   `summer config set creator.projectId <uuid>`.

Live token minting and verification use the additive Summercraft `cApiTokens`
table. Its existing catalog objects were verified and the migration is
explicitly recorded in shared Supabase history as version `20260730073920`.
The client still treats a token failure as authoritative and never falls back
to an unrelated credential.

## Publishing

The CLI never guesses an export layout or silently builds an artifact:

```text
summer publish . \
  --artifact /absolute/path/to/game.pck \
  --version 1.0.0 \
  --notes "First release"
```

The first call omits `--confirm`. It computes the real file size and SHA-256,
records the target locally, prints an error containing the exact project,
version, digest, size, and path, and makes no network request.

After the user approves that exact target, repeat with `--confirm`. The client:

1. recomputes the artifact digest and size;
2. sends `operation=prepare` plus a confirmation object repeating the exact
   game UUID, version, and digest;
3. validates the versioned response, HTTPS/loopback upload URL, signed
   `content-type`, and write-once `if-none-match: *`;
4. streams the `.pck` directly to the presigned URL without sending the creator
   token to R2;
5. sends `operation=finalize` with the same target and confirmation;
6. accepts success only when the server echoes the exact game, version, digest,
   size, release ID, and status;
7. records success or a secret-free failure in `creator-audit.jsonl`.

The server remains authoritative for token scope, ownership, actual stored
bytes, immutable version, and review state. A successful finalize returns
`pending_review`; it does not bypass the existing human review gate.

The MCP tool `summer_creator_publish` calls this same implementation. Agents
must call it with `confirm=false`, show the exact computed target, obtain user
approval, and only then call it with `confirm=true`.

## Release history and logs

`summer releases` and `summer_creator_releases` query real server history. Use
the returned opaque `nextCursor` unchanged for the next page.

`summer logs` and `summer_creator_logs` were **removed in 3.0.0** (see
CHANGELOG). At audit time they were fail-closed stubs that could only ever
throw `creator_backend_unavailable`; a command that fails by design on every
call was not worth shipping. They return when a durable runtime-log source
exists (residual below).

## Residuals and owners

| Residual | Owner | Required next action |
|---|---|---|
| No real creator-token artifact witness has run from this client | Summercraft operator | After the client reaches the public CLI source, mint a disposable scoped token, publish a non-production artifact through review, verify history, then revoke the token. |
| No durable runtime-log source | Runtime/hosting platform | Choose ingestion, retention, redaction, project/release authorization, and query ownership before enabling logs. |
| No automatic export handoff | Export pipeline | Produce an immutable `.pck` and pass it explicitly; do not make the CLI guess output layout or trigger builds without approval. |
| Finalize network ambiguity | Creator client/operator | If finalize loses its response, query `summer releases` before retrying; immutable version and digest prevent silent replacement. |

## Verification boundary

Focused tests use temporary stores, artifact files, and mock HTTP/R2 responses.
They prove prepare → streaming write-once PUT → finalize, exact response
binding, server-authoritative refusal, real release history, hidden creator
credential separation, confirmation/audit, unsafe-header refusal, and the same
path through MCP. No tests use production requests, secrets, environment
changes, migrations, deployments, or key rotation.
