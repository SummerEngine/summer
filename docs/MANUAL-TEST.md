# Manual test of the combined version (2026-09-10)

Everything below is local. Nothing here ships. When it feels right, the "build for prod" steps are at the end.

## What you are testing

| Part | Where | Version |
|---|---|---|
| Engine (complete) | branch `core/all-engine-work` @ `c272d64c122` = local `main` in `~/development/summerengine`; PR #194 (draft, CI only) | 0.5.66 |
| Engine app, release config (what a user gets) | `~/development/summerengine-headless/bin/Summer.app` | 0.5.66 |
| Engine app, dev build (asserts on, same code) | `~/development/summerengine-scripting/bin/Summer.app` | 0.5.66 |
| Toolkit (MCP + CLI) | `~/development/summer-engine-agent-v3` (`v3-foundation` = local `main`), built `dist/` | 3.0.0 |
| Templates | 16 repos re-pinned to fixed branch commits; 15/16 boot clean from scratch | — |

Do NOT use `/Applications/Summer.app` (0.5.65) or `npx summer-engine@latest` (2.8.2) for this test; those are the old pair.

## 1. Point Claude Code at the new toolkit (reversible)

```bash
cd ~/development/summer-engine-agent-v3 && npm run build
node dist/bin/summer.js setup claude-code --local-dev --yes
```
This rewrites the `summer-engine` MCP entry in `~/.claude.json` to this checkout's build and installs every library skill into `~/.claude/skills`. Restart Claude Code afterwards. **Revert** at any time: `npx -y summer-engine@2.8.2 setup claude-code --yes --force`.

Sanity: `node dist/bin/summer.js doctor` → exit 0, "87 tools registered", and a skill count equal to `skill` in `registry/generated/counts.json`.

## 2. Launch the engine WITHOUT it taking over your machine

```bash
node dist/bin/summer.js create 2d-platformer ~/tmp/test-platformer
node dist/bin/summer.js run --bin ~/development/summerengine-headless/bin/Summer.app/Contents/MacOS/Summer --background ~/tmp/test-platformer
```
Expected: "Launching Summer Engine in the background (the window will not take focus until you click it)", "running (v0.5.66)". The window exists but you keep focus. Click it when you want it normal. (`--focus` gives the old behaviour.)

`node dist/bin/summer.js tool get-project-context --args '{}'` → `health.version 0.5.66`, `capabilities.launchPostures ["focus","background","offscreen"]`, `opKinds` 125, **no `capabilitySkewWarning`**.

## 3. Things to actually try (in Claude Code, on that project)

1. "Add a coin combo multiplier and show it in the HUD" — watch it use `summer_run_script` (scene script) or add_node/set_prop, then `summer_play`, `summer_game_probe`/`summer_get_runtime_tree`, `summer_screenshot`. Play is quiet by default: no tab switch, **no mouse capture, no focus** (the FPS/TPS templates are the canary; try `3d-fps-old-school`). `focus: true` on `summer_play` restores normal play.
2. On a 3D template (`3d-fps-old-school`, `3d-third-person-controller`): `summer_test_placement`, `summer_snap_to_surface`, `summer_starcast`, `summer_world_snapshot`, `summer_screenshot` with `target:"scene", marks:true`.
3. `summer open inspector` / `summer open billing --print` (navigation), `summer_search_library "make the jump feel better"`, `summer_read_library <id>`, then `summer_library_feedback` (goes to production; the endpoint is 404 until web PR #331 merges, so expect `dropped:true, reason: endpoint_missing`).
4. `bash ~/tmp/test-platformer/tests/autopilot/run.sh` — imports once, then verifies boot; exit 0.
5. Headless worker (no editor at all): `SUMMER_HEADLESS_ROUTING=1` with the MCP server on a project with no editor open — the toolkit spawns a `--summer-worker` engine. Least tested surface; expect rough edges.
6. Launcher: open the release app directly (double-click). First launch: intro video as before. Second launch: "Skip" + "Don't show video again" under the video. Agent layout: no "Asset Store" tab.

## Known gaps (honest)
- Windows: silent launch + mouse suppression are written but only CI-compiled (PR #194), never run on Windows.
- Exit-time leak of Summer singletons when the editor is killed with SIGTERM — pre-existing, dev builds print it.
- Model-in-the-loop eval: 1 of 8 tasks run, with no tool-call errors; the other 7 were stopped when the FPS task captured your mouse, before the fix.
- 25 scripting/runtime tools still carry `status: preview` in the registry until 0.5.66 ships (they work against this engine).
- `summer_library_feedback` is a 404 in prod until #331 merges.

## Then: build for prod (the order matters)
1. Engine: `git -C ~/development/summerengine push origin c272d64c122:main` → `scripts/release/ship_macos.sh 0.5.66 --source-commit c272d64c122 --public-base-commit <web sha>` on the signing Mac; Windows via `release.ps1` on the Certum runner.
2. Toolkit: merge PR #18 → fresh clone of main → `npm publish --tag next` → soak (`summer setup claude-code --channel next`) → `npm dist-tag add summer-engine@3.0.0 latest`. Rollback: `npm dist-tag add summer-engine@2.8.2 latest`. Details: `docs/RELEASE-3.0.0.md`.
3. Web: merge #328, #332 (auth), #331 (feedback) → `vercel promote`.
4. Template repos: fast-forward the 14 default branches (`docs/design/archive/TEMPLATES-FF-2026-09-04.md`) so the pins become reachable from main.
