# MCP Platform — Handoff Document

You are continuing work on Summer Engine's MCP platform. This is a handoff from a previous chat that built the foundation. Read this first, then look at the specific files referenced.

---

## What Summer Engine Is

Summer Engine is a Godot 4.5 C++ fork with integrated AI features. It has a WebView-embedded Next.js chat UI for AI-assisted game development. The MCP platform allows external AI tools (Cursor, Claude Code, Windsurf) to control the engine.

**Two repos:**
- **Engine (C++):** `/Users/MathiasWork/development/summerengine` — Godot fork
- **Web (Next.js):** `/Users/MathiasWork/development/publicsummerengine` — embedded chat UI, auth, API

---

## What Was Built (Complete and Working)

### Engine Side (C++)
- `modules/1summer_engine/api/local_api_server.h/.cpp` — HTTP server on localhost:6550, polls via Timer, routes to OpsExecutor
- `modules/1summer_engine/auth/auth_manager.cpp` — writes `~/.summer/user.json` on login
- `modules/1summer_engine/SCsub` — includes `api/*.cpp`
- `modules/1summer_engine/register_types.cpp` — registers `LocalApiServer`
- `editor/editor_node.cpp` — initializes `LocalApiServer` singleton

**Status:** Compiles clean. API responds to curl. Tested and verified.

### CLI (Node.js — `tools/summer-cli/`)

**Naming:** Published as `summer-engine` on npm. Repo: `summer-engine-cli`. Do not confuse with the unrelated `summer-cli` package.
10 commands registered in `src/bin/summer.ts`:
- `install`, `login`, `logout`, `status`, `run`, `open`, `create`, `list`, `skills`, `mcp`
- Plus a `postinstall.ts` banner (added in forked chat)

**Status:** Builds clean (`npm run build`). Smoke tests pass (20/20). Published to npm as `summer-engine` (npm package name).

### MCP Server (`tools/summer-cli/src/mcp/`)
24 focused tools across 4 files:
- `scene-tools.ts` — 10 tools: AddNode, SetProp, SetResourceProperty, RemoveNode, SaveScene, OpenScene, InstantiateScene, ConnectSignal, SelectNode, ReplaceNode
- `debug-tools.ts` — 7 tools: GetDiagnostics, GetConsole, ClearConsole, GetDebuggerErrors, Play, Stop, IsRunning (snapshots disabled — see Key Decisions #7)
- `project-tools.ts` — 5 tools: ProjectSetting, InputMapBind, GetSceneTree, ImportFromUrl, ImportFromUrlBatch
- `asset-tools.ts` — 2 tools: SearchAssets, ImportAsset (requires auth + Pro plan)

All tools use lazy-connect via `with-engine.ts` — MCP server stays alive even when engine isn't running.

### Web Repo
- `app/api/auth/cli-login/route.ts` — CLI auth polling (GET) + token storage (POST) via Redis
- `app/(core)/login/page.tsx` — added `cli_session` param
- `app/(core)/loginDeepPage/page.tsx` — passes `cli_session`
- `app/(core)/loginDeepPage/LoginDeepPageClient.tsx` — CLI confirm button (CSRF-safe), skips pregenerate for CLI

### Documentation (in `tools/summer-cli/docs/`)
- `DEVELOPMENT.md` — full architecture, folder structure, dev workflow, deployment, TODOs
- `ADDING_TOOLS.md` — step-by-step for new MCP tools
- `MCP_PRODUCT_STRATEGY.md` — what to build, what not to, tool decisions
- `MCP_BUSINESS_STRATEGY.md` — revenue model, competitive analysis, open questions

### Strategy Docs (in `doc/SUMMER/`)
- `MCP_STRATEGY.md` — high-level platform strategy
- `MCP_TECHNICAL_SETUP.md` — architecture, endpoints, auth flow, CLI structure

---

## What Was Verified Working

1. Engine builds with `scons platform=macos target=editor dev_mode=yes use_ccache=yes generate_bundle=yes -j14`
2. LocalApiServer starts on port 6550, writes `~/.summer/api-token` and `api-port`
3. `curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:6550/api/health` returns JSON with project info
4. CLI builds with `cd tools/summer-cli && npm install && npm run build`
5. Smoke tests pass: `bash scripts/smoke-test.sh` (20/20)

---

## What Has NOT Been Tested Yet

1. **MCP from Cursor** — the full end-to-end: add MCP config to Cursor, ask agent to use Summer Engine tools, verify operations execute in the engine. This is the #1 priority.

2. **POST /api/ops** — the health endpoint works, but we haven't tested actually executing operations (AddNode, SetProp) through the HTTP API.

3. **CLI login flow** — `summer login` opens browser, but the web route `/api/auth/cli-login` hasn't been tested end-to-end.

4. **summer install** — downloads engine from Supabase. Untested.

5. **summer run** — launches engine binary. Untested (binary detection paths are guesses).

---

## Immediate Next Steps (P0)

### 1. Test POST /api/ops

With engine running:
```bash
TOKEN=$(cat ~/.summer/api-token)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://127.0.0.1:6550/api/ops \
  -d '{"ops":[{"op":"AddNode","parent":"./","type":"DirectionalLight3D","name":"TestLight"}]}'
```

Verify the node appears in the engine's scene tree.

### 2. Test MCP from Cursor

Add to `.cursor/mcp.json` in any project:
```json
{
  "mcpServers": {
    "summer-engine": {
      "command": "node",
      "args": ["/Users/MathiasWork/development/summerengine/tools/summer-cli/dist/bin/summer.js", "mcp"]
    }
  }
}
```

Open Cursor, verify "summer-engine" appears in MCP panel. Ask: "Use Summer Engine to add a Camera3D and a DirectionalLight3D to the scene."

### 3. Fix anything that breaks in testing

Common issues to expect:
- MCP SDK version mismatch (check `@modelcontextprotocol/sdk` version)
- Tool parameter types might not match what the engine expects
- Snapshot tools are disabled in MCP (see Key Decisions #7); if re-enabled, base64 images could be large

---

## Existing Plan For Phase 2

See `/Users/MathiasWork/.cursor/plans/mcp_platform_orchestration_fc5c9d1b.plan.md` for the full next-phase plan covering:
- Documentation overhaul (Mintlify docs site)
- Asset search MCP tool (25K assets with pgvector search)
- Skills system (downloadable best-practice guides)
- One-click Cursor import

---

## Key Files To Read

| What | Path |
|------|------|
| CLI development guide | `tools/summer-cli/docs/DEVELOPMENT.md` |
| Product strategy | `tools/summer-cli/docs/MCP_PRODUCT_STRATEGY.md` |
| Business strategy | `tools/summer-cli/docs/MCP_BUSINESS_STRATEGY.md` |
| Adding new tools | `tools/summer-cli/docs/ADDING_TOOLS.md` |
| MCP server entry | `tools/summer-cli/src/mcp/server.ts` |
| Scene tools (main value) | `tools/summer-cli/src/mcp/tools/scene-tools.ts` |
| Engine API server | `modules/1summer_engine/api/local_api_server.cpp` |
| Technical architecture | `doc/SUMMER/MCP_TECHNICAL_SETUP.md` |
| Phase 2 plan | `.cursor/plans/mcp_platform_orchestration_fc5c9d1b.plan.md` |

---

## Key Decisions Made

1. **MCP over REST API** — MCP is the primary interface for AI tools. REST API is the foundation layer underneath.
2. **24 tools, not 47** — Removed redundant tools (file, shell, git, search). Only tools that require the engine are exposed.
3. **Lazy-connect** — MCP server doesn't crash if engine not running. Returns per-tool errors.
4. **CLI in engine repo** — For ops-to-tools coupling. Could move later.
5. **No free AI credits** — Free tier is engine + CLI + MCP (zero cost). Paid is integrated AI.
6. **Auth via engine** — MCP uses local `api-token` from running engine. CLI login is separate for analytics.
7. **Snapshots are Summer Agent-only for now** — `summer_viewport_snapshot` and `summer_game_snapshot` are disabled in the MCP server. Current MCP clients (Cursor, Claude Code) can't pass base64 images as vision context, so the tools return data that AI agents can't actually use. Screenshots are fully available inside the Summer Engine app via the built-in Summer Agent. MCP support will be re-enabled when MCP image content types are broadly supported by clients.

---

## Build Commands

```bash
# Engine
cd /Users/MathiasWork/development/summerengine
scons platform=macos target=editor dev_mode=yes use_ccache=yes generate_bundle=yes -j14

# CLI
cd tools/summer-cli
npm install && npm run build

# Smoke test
bash scripts/smoke-test.sh

# Launch engine
SUMMER_GATEWAY_URL=https://www.summerengine.com:3000 ./bin/Summer.app/Contents/MacOS/Summer

# Test API
TOKEN=$(cat ~/.summer/api-token)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:6550/api/health
```

---

## npm Account

- Username: `summer-engine`
- Email: `founders@summerengine.com`
- Org: `@summerengine`
- 2FA: Enabled
- Current published version: `0.0.1` (placeholder)

---

**This handoff was written on 2026-02-26.**
