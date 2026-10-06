# Publishing web games to summer.games

Status: preview. Implemented against summer-platform origin/main `71f3175ab`
and publicsummerengine origin/main `52435e03a` (audited 2026-10-06).

## Copy-paste for any coding agent

> Export this game as an HTML5/web build into an empty folder with
> `index.html` at its root and relative asset paths (Godot: Web preset, Thread
> Support off; Unity: WebGL; Vite: `base: './'`; Construct: Web (HTML5) zip).
> Then run `npx -y summer-engine@latest publish-web <build folder> --name "<Game
> Name>" --content-rating everyone --json` WITHOUT `--confirm`, show me the
> returned plan, and only after I approve run the same command with
> `--confirm`. If it says `games_login_required`, ask me to run
> `npx -y summer-engine@latest login --games` once in my terminal.

The full procedure is the `publish-web-game` skill
(`library/skills/publish-web-game/SKILL.md`).

## Surfaces

| Surface | Name |
|---|---|
| CLI sign-in | `summer login --games` (`--force` to sign in again) |
| CLI publish | `summer publish-web <folder or .zip> [--game id] [--name] [--description] [--content-rating] [--label] [--no-submit] [--wait s] [--confirm] [--json]` |
| MCP | `summer_publish_web_game` (confirm=false returns the plan) |
| `summer tool` | `summer tool publish-web-game --args '{...}'` |

Core: `src/core/web-publish/` (`oauth.ts`, `validate.ts`, `zip.ts`, `publish.ts`).

## Sign-in

OAuth 2.1 authorization code + PKCE (S256) against the Supabase OAuth server
of the Summer Engine project (issuer
`https://bjhcdenhsahdyirbbzlx.supabase.co/auth/v1`, discovered via RFC 8414
metadata). The CLI registers a public client (`token_endpoint_auth_method:
none`) through dynamic registration with a loopback redirect
`http://127.0.0.1:<port>/callback`, and reuses it while that port can be bound
again. Supabase sends the browser to the Summer consent page
(`/oauth/consent` on summerengine.com); the user clicks Connect.

Store files in `~/.summer/` (0600): `games-oauth-client.json` (client id, no
secret), `games-oauth-token.json` (access + refresh token),
`games-web-publish.json` (build folder -> game id),
`games-publish-audit.jsonl` (no tokens or URLs). The core `auth-token` read by
the desktop engine is never touched. `summer logout` removes the token.

## API sequence (management API, `https://api.summer.games/v1/management`)

1. `GET /games` (reuse by exact name) or `POST /games` with `Idempotency-Key`,
   `{name, description, tags: [], supportedPlatforms: ["web"], contentRating?, contentDescriptors?}`.
2. `POST /games/{g}/store/versions` `{platform: "web", fileName, sizeBytes, label}`
   -> `{version, upload: {partSizeBytes, partCount}}`.
3. `POST .../{v}:signParts` `{partNumbers}` (max 100 per call) -> presigned PUTs;
   upload each part with its exact planned length; 3 attempts per part.
4. `POST .../{v}:complete` `{}`; poll `GET .../{v}` until `ready` or `rejected`.
5. `GET /games/{g}` -> `creatorRevisionId`, `creatorState`. DRAFT: optional
   `PATCH .../revisions/{r}` (content rating) then `POST .../revisions/{r}:submit`
   with `If-Match` + `Idempotency-Key`. APPROVED: `:publish`. PUBLISHED: live.

`SUMMER_GAMES_API_URL` / `SUMMER_GAMES_WEB_URL` override the origins (for
example `https://api.staging.summer.games`).

## Known server-side gates (2026-10-06)

- Store routes exist only when the management API sets `SUMMER_PLAY_ORIGIN`.
  Production enablement is summer-platform PR #1083 (open). Until then the CLI
  reports `games_store_unavailable`.
- The management API accepts only `aud: "authenticated"`. publicsummerengine
  PR #707 adds an optional Supabase access-token hook that rewrites every OAuth
  app token (any token with `client_id`) to `aud:
  https://mcp.summerengine.com/mcp`. If that hook is enabled, CLI tokens are
  refused; the CLI detects this locally as `games_token_audience_mismatch`.
- The consent page shows Connect only when `HOSTED_MCP_ENABLED=1` and the user
  is in `HOSTED_MCP_ALLOWED_USER_IDS` (or `*`).
- Threaded web builds (served from `/gt/`) cannot play on the store page yet;
  the CLI refuses them before upload.
