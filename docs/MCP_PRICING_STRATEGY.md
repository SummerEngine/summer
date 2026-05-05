# Summer Engine MCP — Pricing Strategy

> Superseded for the current rebuild by [Summer Agent Kit PRD](./AGENT_EXPERIENCE_PRD.md). Keep this file as legacy context only.

How MCP pricing and quota enforcement works technically.

---

## The Value-Gated Model

We charge for access to the AI-to-Engine bridge, not only cloud compute.

- Local MCP tools provide product value (scene graph control, diagnostics, play/stop), so they are quota-gated by plan.
- Cloud MCP tools (asset search/generation and other hosted compute) remain credit/on-demand metered.

### Free Tier (Hobby)

- **100 local MCP calls per week**
- Rolling 7-day window based on first call in current window.

### Pro Tier ($20/mo) and above

- **1M local MCP calls per week**
- Applies to `pro`, `pro_plus`, and `ultra`.
- Operates as "effectively unlimited" for normal users, while retaining a hard abuse ceiling.

### Cloud Tools (Asset Search, Generation, etc.)

- Consume AI credits / on-demand under existing billing rules.
- Plan-gated where applicable (for example, MCP asset search requires Pro or higher).

---

## Implementation Details

### Data model (web repo)

Users table fields:

- `mcpLocalCallsCount` (integer)
- `mcpLocalCallsResetAt` (timestamp with time zone)

Migration:

- `publicsummerengine/src/lib/db/migrations/0020_mcp_local_quota.sql`

### Quota check endpoint

- Route: `POST /api/mcp/log-local-call`
- File: `publicsummerengine/app/api/mcp/log-local-call/route.ts`
- Auth: CLI JWT (`Authorization: Bearer <~/.summer/auth-token>`)

Behavior:

1. Verify JWT and user.
2. Determine weekly limit by plan:
   - `free` -> `100`
   - `pro` / `pro_plus` / `ultra` -> `1_000_000`
3. Run check+increment atomically in DB transaction with row lock (`FOR UPDATE`).
4. If window expired, reset effective count to 0 and set `resetAt = now + 7 days`.
5. Return `{ allowed, used, limit, resetAt }`.
6. If over limit, return `402` with machine-readable payload and upgrade message.

### CLI enforcement path

- Wrapper: `tools/summer-cli/src/mcp/tools/with-engine.ts`
- Flow for local MCP tools:
  1. Read auth token (`~/.summer/auth-token`)
  2. Call `POST /api/mcp/log-local-call`
  3. If allowed, execute engine call against local API

Error policy in CLI:

- **Hard block** on enforcement responses: `401`, `402`, `403`, `429`
- **Soft-fail allow** on transient gateway/network failures (`5xx`, timeout, non-JSON response)

This avoids disabling all local MCP tools during temporary web outages.

---

## API Contract (log-local-call)

### Success (`200`)

```json
{
  "allowed": true,
  "used": 42,
  "limit": 100,
  "resetAt": "2026-03-06T12:34:56.000Z"
}
```

### Quota blocked (`402`)

```json
{
  "allowed": false,
  "error": "upgrade_required",
  "message": "[Summer Engine] Free tier limit reached (100/100 weekly MCP calls). Upgrade to Pro for 1M/week: https://summerengine.com/pricing",
  "used": 100,
  "limit": 100,
  "resetAt": "2026-03-06T12:34:56.000Z"
}
```

### Unauthorized (`401`)

```json
{
  "allowed": false,
  "error": "unauthorized",
  "message": "Invalid or expired token. Run: npx summer-engine login --force"
}
```

---

## Notes

- Weekly windows are rolling (7 days), not calendar-week resets.
- MCP local quota and AI credits are separate controls:
  - local tools -> MCP quota
  - cloud tools -> credits/on-demand
