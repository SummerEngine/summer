# MCP/CLI Security & Rate Limit Review Plan

**Purpose:** A structured plan for an AI (or human) to perform a full security and rate-limit review of the MCP platform and CLI implementation.

**Scope:** Engine (C++), CLI (Node.js), Web API (Next.js), Asset Search MCP tools, auth flow.

**Repos:**
- Engine/CLI: `/Users/MathiasWork/development/summerengine`
- Web: `/Users/MathiasWork/development/publicsummerengine`
- Docs: `/Users/MathiasWork/development/docs`

---

## 1. Inventory: What to Review

### 1.1 CLI (`tools/summer-cli/`)

| Area | Files | Notes |
|------|-------|-------|
| Auth | `src/lib/auth.ts`, `src/commands/login.ts`, `src/commands/logout.ts` | Token storage in `~/.summer/`, no encryption at rest |
| MCP server | `src/mcp/server.ts` | Stdio transport, tool registration |
| Scene tools | `src/mcp/tools/scene-tools.ts` | 10 tools, engine ops |
| Debug tools | `src/mcp/tools/debug-tools.ts` | 7 tools |
| Project tools | `src/mcp/tools/project-tools.ts` | ImportFromUrl, ImportFromUrlBatch, etc. |
| Asset tools | `src/mcp/tools/asset-tools.ts` | summer_search_assets, summer_import_asset — calls web API |
| API client | `src/lib/api-client.ts` | Engine localhost:6550, token from engine |
| Bin entry | `src/bin/summer.ts` | Command routing |

### 1.2 Web API

| Endpoint | File | Auth | Rate Limited? |
|----------|------|------|---------------|
| `GET /api/auth/cli-login?session=` | `app/api/auth/cli-login/route.ts` | POST: session cookie | No |
| `GET /api/mcp/assets?query=` | `app/api/mcp/assets/route.ts` | Bearer JWT, Pro check | **No** |
| (Engine) `POST /api/ops` | C++ `local_api_server.cpp` | Bearer from engine | No (local only) |

### 1.3 Engine (C++)

| Component | File | Notes |
|-----------|------|-------|
| Local API server | `modules/1summer_engine/api/local_api_server.cpp` | localhost:6550, auth via token |
| Ops executor | `modules/1summer_engine/editor/ops_executor.cpp` | Executes ops, no rate limit |
| Auth manager | `modules/1summer_engine/auth/auth_manager.cpp` | OAuth, writes user.json |

---

## 2. Rate Limiting Review

### 2.1 Current State

- **MCP assets API** (`/api/mcp/assets`): No rate limiting. Each request: 1 embedding call + DB queries.
- **CLI login** (`/api/auth/cli-login`): No rate limiting. Polling every 2s for up to 2 min.
- **Engine local API**: Localhost only; rate limiting less critical but consider DoS from runaway agent.

### 2.2 Tasks

1. **Add rate limiting to `/api/mcp/assets`**
   - Use `@upstash/ratelimit` + `@upstash/redis` (already in use for CLI login).
   - Identifier: `userId` (from JWT payload).
   - Suggested limits: 60 requests/minute (search), or 30/min if including cost of embeddings.
   - Return `429` with `Retry-After` and clear error message.
   - Document in API response or docs.

2. **Consider rate limiting for CLI login**
   - Poll endpoint: 1 request per 2s per sessionId — low risk.
   - POST (token storage): Could be abused to create many CLI sessions. Limit per IP or per user.

3. **Engine local API**
   - Optional: Add simple in-memory throttle (e.g., max 100 ops/min) to prevent runaway agent from overwhelming the editor. Lower priority than web API.

### 2.3 Implementation Notes

- Upstash Redis: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (check if same as CLI login or separate).
- Ratelimit algorithm: `Ratelimit.slidingWindow(60, "1 m")` for search.
- If Upstash unavailable: Graceful degradation (allow request with log warning) or fail closed (reject). Document behavior.

---

## 3. Security Review

### 3.1 Authentication & Authorization

| Check | Location | Action |
|-------|----------|--------|
| JWT verification | `app/api/mcp/assets/route.ts` | Verify `jwtVerify` uses `DESKTOP_JWT_SECRET`, algorithm `HS256` |
| Token expiry | CLI login JWT | 30-day expiry — acceptable for CLI; document rotation |
| Token storage | `~/.summer/auth-token` | Plain text. Consider: file permissions (0600), no world-readable |
| Pro gate | MCP assets | `Users.plan` check — verify `pro` and `pro_plus` only |
| Engine API token | `local_api_server.cpp` | How is token generated? Stored? Validated? |

### 3.2 Input Validation

| Endpoint/Input | Risk | Action |
|----------------|------|--------|
| `query` (MCP assets) | Injection, XSS (if echoed) | Trim, length limit (e.g., 500 chars), sanitize if rendered |
| `assetType`, `limit` | Enum/range abuse | Already validated; confirm server-side |
| `parent`, `path` (scene ops) | Path traversal | Engine must reject `..`, paths outside project |
| `url` (ImportFromUrl) | SSRF, malicious URLs | Engine: allow only `http`/`https`, block `file://`, `localhost` (or allow list) |

### 3.3 Secrets & Configuration

| Item | Check |
|------|-------|
| `DESKTOP_JWT_SECRET` | Must be set in production; strong, random |
| `UPSTASH_REDIS_*` | Used for CLI login; ensure not logged |
| Engine API token | Where stored? How rotated? |

### 3.4 Asset Search Specifics

| Check | Action |
|-------|--------|
| Cloudinary URLs | Returned to client — ensure no signed URLs with write capability |
| Texture HEAD request | CLI calls Cloudinary directly — no auth needed for public assets; confirm URLs are public-read only |
| Pack slug from URL | Regex extraction — ensure no injection into paths |

### 3.5 CLI-Specific

| Check | Action |
|-------|--------|
| `GATEWAY_URL` / `SUMMER_GATEWAY_URL` | Could point to malicious server — document that users should not override unless for dev |
| Token in fetch headers | Not logged; confirm no debug logs leak token |
| `~/.summer/` permissions | Recommend `chmod 700` on dir, `600` on files |

---

## 4. Execution Order

1. **Inventory** — Confirm all files listed above exist and match descriptions.
2. **Rate limiting** — Implement for `/api/mcp/assets`; document limits.
3. **Security audit** — Go through each check in §3; document findings and fixes.
4. **Documentation** — Update HANDOFF.md, DEVELOPMENT.md, or a new SECURITY.md with:
   - Rate limits (values, behavior when exceeded)
   - Token handling (storage, rotation, expiry)
   - Input validation assumptions
   - Known limitations

---

## 5. Deliverables

- [ ] Rate limiting on `/api/mcp/assets` (or documented decision not to)
- [ ] Security findings log (issues found, severity, fix status)
- [ ] Updated docs (rate limits, security notes)
- [ ] Optional: `SECURITY.md` or section in HANDOFF.md

---

## 6. Reference Files

- Auth flow: `publicsummerengine/app/api/auth/cli-login/route.ts`
- MCP assets API: `publicsummerengine/app/api/mcp/assets/route.ts`
- Asset tools: `summerengine/tools/summer-cli/src/mcp/tools/asset-tools.ts`
- Engine API: `summerengine/modules/1summer_engine/api/local_api_server.cpp`
- Upstash ratelimit: https://upstash.com/docs/redis/sdks/ratelimit-ts/gettingstarted
- Asset import flow: `publicsummerengine/Docs/ASSET_IMPORT_END_TO_END.md`
