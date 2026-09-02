# Changelog

All notable changes to summer-engine will be documented here. Following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [Unreleased] — 3.0.0

### Removed
- **Summer Cloud** (research preview): the `summer cloud` command group, the seven `summer_cloud_*` MCP tools, the `summer-cloud` skill, the `library/tools/cloud-*` descriptors, the sync engine under `src/core/capabilities/cloud/`, and cloud-token minting during `summer login`. It was not operational or maintained; Summer Platform publish/releases is the supported path. `summer-cloud.json` and `.summer/local/cloud/` in old projects are inert and can be deleted; `summer logout` still removes a legacy `~/.summer/cloud-token`. The `doctor` "Git (cloud checkpoints)" check went with it. Web-side cleanup (`/cloud` page, `app/api/cloud/*`, cli-login `cloudToken` minting) is a separate web-repo PR.
- **`summer agent`** (`src/cli/commands/orchestrator.ts`): a development-only launcher for the web app from a sibling checkout (hardcoded sibling paths, non-portable `URL.pathname`, `spawn("pnpm")` without a shell). It never belonged in the published CLI. Its `~/.summer/web-app-path` and `~/.summer/agent-port` files are inert.
- **`summer logs` / `summer_creator_logs`**: the command, MCP tool, `summer tool creator-logs` dispatch entry, and `library/tools/creator-logs` descriptor. The implementation could only ever throw `creator_backend_unavailable` (there is no platform runtime-log API), so every call failed by design. It returns when a durable log source exists.
- Dead `postinstall` entry (`src/bin/postinstall.ts`, never referenced by `package.json`) and the stale welcome box in `banner.ts` (`getWelcome`/`printWelcome`/`printBanner` with "cloud: animation, texturing" and `/help` copy). Only `getBanner` remains.

## [2.8.2] — 2026-09-01 — "Windows setup works out of the box"

### Fixed
- Windows: generated MCP configs now launch the server via `cmd.exe /c npx ...` instead of `command: "npx"`. `npx` is a `.cmd`/`.ps1` shim on Windows and Node's `spawn()` does no PATHEXT resolution, so agent hosts that spawn the command directly (Claude Code, Kimi Code, Cursor, ...) failed with `spawn npx ENOENT` even though npx worked in a terminal. Reported by Imitater967 — thank you. Re-run `npx -y summer-engine@latest setup <agent> --yes --force` on Windows to rewrite the config; docs for manual configs carry the same note.
- Six shipped skills (`host-authoritative-state`, `setup-multiplayer`, `scene-composition`, `make-game`, `ui-basics`, `mcpupdate`) had unquoted colons in their YAML frontmatter descriptions — strict YAML parsers rejected the frontmatter and skipped the skill entirely. Descriptions are now quoted; all shipped skill frontmatter is YAML-validated.

## [2.8.1] — 2026-08-18 — "Scene mutations work again on engine 0.5.60+"

### Added
- `summer_get_scene_tree` accepts optional `depth` and `limit` params (engine defaults: depth 2, limit 200 — a 102-node scene silently truncated to 61 nodes at the defaults). The engine only honors them on scene-targeted reads, so the tool resolves the current scene path first when needed and says so when it can't. `summer_get_project_context` accepts an optional `settingsPrefix` and, without one, trims `project.data.entries` to a curated prefix set (application/, display/, input/, physics/, rendering/) instead of returning the full ~188KB settings dump — the payload declares the trim via `settingsTruncated`/`totalSettings`/`settingsHint`.
- `summer_screenshot` scene captures accept `nodePath` (frame a specific node, honest `node_not_found` failure) and new framing directions `back`/`left`/`right`; captions report the resolved framing and any render retries. Requires engine 0.5.62+ to take effect — older engines silently ignore the new fields.
- `summer_get_diagnostics` returns a prioritized bounded view (errors first, then warnings, capped info tail) with honest suppression counters, plus `includeAll: true` for the untrimmed payload. Severity + recency + caps only — no noise-pattern matching.
- `scripts/compat-smoke.sh`: a latest-MCP × candidate-engine release gate that drives the real built MCP server against a live engine and fails loudly on batch-contract incompatibilities (the class of bug that broke 2.7.0–2.8.0 × engine 0.5.60+). Run it before every engine release and every npm publish.

### Fixed
- `summer_create_scene` no longer uses the destructive temporary-template strategy (open current scene → delete its children → save-as → restore). It now writes a minimal `.tscn` through the identity-bound engine `WriteFile` with a create-only guard, never touches the open scene, verifies by reading the file back, and gained a `rootType` param (Node3D/Node2D/Control). `allow_temporary_scene_mutation` remains accepted as a deprecated no-op.
- **Scene mutations were completely broken against engine 0.5.60/0.5.61.** The engine now requires `SaveScene`, `InstantiateScene`, `ReplaceNode`, `SimulateInput`, and the `Run*`/`Import*`/`Git*` ops to travel as their own single-op request, and rejects any multi-op batch containing one of them wholesale (`failure_reason: "unsupported_transport"`). Since 2.7.0 appended `SaveScene` to every mutation batch, every `summer_add_node`/`summer_set_prop`/`summer_batch`/`summer_create_scene` call was rejected before anything executed. Mutation batches are now automatically split into sequential requests around single-only ops; all receipts are preserved and merged, and a mutation that applied followed by a save that failed is reported honestly (including which ops already applied and which were not sent).
- Engine failures no longer hide the precise rejection. `extractOpError` previously returned a generic `"Engine operation failed (terminalState: failed)"` without inspecting `results[]`; it now surfaces the failed op's own error and `failure_reason` (envelope or per-op, either spelling), rendered as JSON when a classifier is present so agents can key on `failure_reason` reliably.
- `save_frame` is documented with its required `name` argument everywhere (`save_frame()` with no args is a probe script error), plus the deferred scene-mount pattern that avoids black frames.
- SimulateInput guidance corrected: it IS reachable over MCP/CLI as a single op against the running game (`failure_reason: "not_running"`/`"unsupported"` are the real failure modes); `"unsupported_transport"` only means it was batched with other ops. The previous claim that it needs the in-editor bridge on every build was stale.
- The scene-preview synthetic-camera note no longer claims the scene has no camera — the engine always synthesizes the preview camera; `sceneHasCamera` is the authoritative signal and keeps its own warning.
- `summer login` waits 15 minutes on one session id (was 2) with periodic reminders, covering first-time account creation + email confirmation. The gateway never expires a pending session, so the single id stays valid the whole window.
- Removed the stale "Engine mirror only" banner from the README (it shipped to npm and the public repo, and its claims were wrong).

## [2.8.0] — 2026-08-17 — "Multi-editor MCP routing"

### Added
- MCP discovers every live Summer editor through `~/.summer/instances/` and automatically binds local tools to the editor whose project contains the agent's current working directory.
- `summer mcp --project <path>` and `summer mcp --instance <id>` provide explicit selection for hosts that do not start the MCP server from a project directory.

### Changed
- Multiple live editors are now a fail-closed state when no project can be inferred. MCP lists the non-secret project/instance choices instead of following the machine-global last-opened editor pointer.
- Selected MCP sessions keep following the same project across editor restarts and validate registry identity against `/api/health` before connecting.

## [2.7.0] — 2026-07-24 — "Reliable project mutations"

### Added
- `summer_read_file`, `summer_write_file`, and `summer_replace_text` expose engine-routed project file access, including `.tscn` and `.tres`. New files require `create_only:true`; overwrites require an engine sha256 receipt.
- File mutations fail closed unless the MCP client has a complete engine/project identity and use the bound project hash even if caller options attempt to override it.

### Changed
- Agent playbooks now route project file mutations through Summer MCP instead of recommending host writes that bypass identity, content guards, and editor reload handling.
- Scene mutation tools require an explicit `scenePath`; the target scene does not need to be the visible editor tab.
- `summer_open_scene` is navigation only and no longer acts as implicit mutation targeting.
- Dedicated scene mutations and mutation batches append one final `SaveScene` at the transaction boundary.
- Agent guidance no longer claims that routine scene edits require stopping the running game.

### Fixed
- Bridge/project identity rejections now return one correlated `not_sent`
  terminal, allowing the web harness to retry safely instead of waiting for a
  mutation receipt that cannot exist.
- Same-file MCP mutations now serialize the complete read-to-write transaction,
  preventing concurrent replacements from racing on a stale file preimage.
- Accepted engine operations preserve their request identity and report whether
  they are still queued, still running, or uncertain instead of claiming that
  nothing was applied after a client wait deadline.
- `summer_batch` no longer permits raw file mutations that bypass the guarded
  `summer_write_file` and `summer_replace_text` tools.
- Scene operations return target/persistence evidence and concrete dependency errors instead of relying on ambient open-scene state.
- Asset placement reports success only after both the import and explicit target-scene mutation are confirmed.

### Limitations
- The package cannot intercept an external agent's native filesystem tools. A host can still mutate files outside MCP, and a non-atomic external write can race the engine between validation and write; those cases remain technically unenforceable.

## [2.6.6] — 2026-07-15 — "Project-bound engine requests"

### Fixed
- Every local engine request now carries the engine instance ID, stable project ID, project ID hash, and identity protocol version captured when the CLI connects. This lets compatible engine builds reject stale requests after a project or engine switch instead of acting on the wrong target.
- An explicit project rebind now refreshes the complete engine and project identity, while keeping the existing project-hash mutation guard and screenshot drift checks.
- Summer Cloud's engine bridge now binds its save, rescan, and scene reload requests to the project it verified on disk.

### Changed
- Summer Cloud is documented as an optional Research Preview instead of part of the core local CLI and MCP workflow.
- Release metadata and the manual npm runbook now pin the public registry and require a clean, reviewed public source checkout.

## [2.6.5] — 2026-07-04 — "Cloud tools don't need the engine"

### Fixed
- Tool descriptions now say explicitly which tools run in Summer's cloud and work WITHOUT the engine open (`summer_generate_*`, `summer_search_assets`, `summer_list_my_assets`, `summer_get_asset`, `summer_get_asset_download_url`, `summer_check_job`) and which need the engine (imports, scene ops). Agents were misreading a missing `npx summer-engine login` as "MCP requires the engine".
- The "Summer Engine is not running" error now tells the agent that cloud tools still work without the engine.

## [2.6.4] — 2026-07-03 — "See-Work + project binding" (unpublished, ships with 2.6.5)

### Added
- MCP session binds to its project; the engine rejects wrong-project writes (`identity_mismatch`) instead of applying them to whatever project is open.
- Structured per-tool-call stderr logging; agent playbook rewritten around the MCP verification ladder; honest game-capture failure states and identity-stamped reads.

## [2.6.3] — 2026-06-30 — "Agent vision"

### Added
- `summer_screenshot` MCP tool: capture the editor viewport or the running game as an image the agent sees directly (`target: "viewport" | "game"`, viewport by default). Lets the agent visually verify scene layout, asset placement, scale, framing, and runtime state — the client reads the actual frame, with no description step in between. Total MCP tool surface is now 52.

### Fixed
- MCP/CLI session now reconnects automatically after a transient engine restart (the engine rotates its api-token and can move its port on relaunch), instead of surfacing as a "disconnected" error.

## [2.6.0] — 2026-06-10 — "Summer Cloud"

### Added
- `summer cloud` command group: `init`, `status`, `push`, `pull`, `restore`, `checkpoints` — content-addressed project sync against Summer Cloud (R2-backed). Code stays in git; big assets sync by hash with three-way merge, conflict sets, and SummerGit checkpoints before any destructive apply.
- Matching MCP tools: `summer_cloud_init`, `summer_cloud_status`, `summer_cloud_push`, `summer_cloud_pull`, `summer_cloud_restore`, `summer_cloud_checkpoints`, `summer_cloud_conflicts`.
- `.summercloudignore` support plus built-in hard excludes (`.env*`, `.summer/local/`, `node_modules/`, OS junk) so secrets and machine-local state never upload.

### Safety
- Pulls stage to a temp dir and verify every blob hash before an atomic rename; mass-delete guardrails, edit-beats-delete conflict rule, and case-only rename handling for macOS/Windows volumes.

## [2.5.1] — 2026-05-27 — "README Polish"

### Changed
- Removed the pseudo-JSON status example from the npm README because npm syntax highlighting made normal setup statuses look like alarming errors.

### Fixed
- MCP generation requests now include client/tool attribution headers and surface provider 422 validation details instead of opaque `[Object]` failures.

## [2.5.0] — 2026-05-27 — "Project Memory"

Note: `2.1.0` through `2.4.0` were internal package/plugin snapshots in the engine repo. npm `latest` was still `2.3.0` before this release, so `2.5.0` is the public catch-up release for the memory, setup, and MCP reliability work.

### Added
- `summer memory` — read-only CLI view of `.summer` project memory, with `--json`, `show <file>`, and `path` subcommands.
- `projectMemory` in `summer_get_project_context` — lightweight summary of `.summer` canonical files and structured memory for agents.
- `.summer/memory/` convention for locked project facts such as voice IDs, world canon, provider bindings, and cross-session decisions.
- Project-memory checks in `summer status` and `summer doctor`.
- First-class `summer setup github-copilot` and `summer setup vscode-copilot` targets for Copilot CLI and GitHub Copilot in VS Code.
- Copy-paste setup prompt docs: users can paste "Install Summer Engine and let's make a game." into their AI environment instead of starting with npm commands.

### Changed
- `/summer:voice-line` now writes locked cast assignments to `.summer/memory/casting/voices.md`, while still reading legacy `.summer/voice-cast.md`.
- Agent playbook and `using-summer` now require agents to read relevant project memory before creative/audio/dialogue/level/character work.
- CLI and docs now link directly to the public source repo: `https://github.com/SummerEngine/summer-engine-agent`.

### Fixed
- MCP project context now falls back to engine health fields for project path, project name, and current scene.
- Mutating MCP tools now surface failure terminal states and no-results failure envelopes instead of masking them as success.

## [2.0.0] — 2026-05-09 — "Superpowers"

The plugin rebrand. Summer is now positioned as superpowers for AI game dev — installable in Claude Code, Codex (CLI + App), Cursor, Factory Droid, Gemini CLI, OpenCode, GitHub Copilot CLI, and Windsurf with one canonical command per harness.

### Added
- **`summer:using-summer`** meta-skill — establishes workflow priority, red-flag list, and skill-invocation discipline. Auto-loads on session start. Modeled on `superpowers:using-superpowers`.
- **`summer:debug`** skill — the missing flagship skill. Disciplined script-errors → console → debugger → hypothesize → propose → fix → verify loop. Honors all 4 cases in `tests/specs/debug.md`.
- **Manifest validator** (`src/lib/plugin-manifests.test.ts`) — vitest test that walks every plugin manifest and verifies each referenced skill resolves to a real `SKILL.md` on disk. Also enforces the "Use when…" auto-trigger pattern in every skill's description.
- **`AGENTS.md`** + **`GEMINI.md`** at repo root — context primer for harnesses that read AGENTS-style files (Codex, Factory) and the Gemini extension.
- **`.opencode/INSTALL.md`** — explicit OpenCode setup guide.
- **`docs/marketplace-repo/`** — drop-in contents for the separate `SummerEngine/summer-marketplace` repo (Claude marketplace listing).
- Multiplayer skills (`host-authoritative-state`, `peer-to-peer-multiplayer`) added to all plugin manifests.

### Changed
- **Brand:** "Summer" replaces "Summer Engine CLI" across all plugin descriptions, READMEs, and orientation banners. The npm package stays `summer-engine` (continuity).
- **README** rewritten in superpowers-homepage style — install matrix per harness, philosophy section, basic workflow walkthrough.
- **MCP_STRATEGY.md** updated: documents the deliberate decision to NOT ship file/git/shell/grep tools (host agents have those natively). The then-current tool surface shipped.
- All 22 user-facing skill descriptions audited and rewritten to lead with "Use when X" for tighter auto-trigger.
- `.codex-plugin/plugin.json` `longDescription` rewritten — accurate skill count, mentions the host-native tool exclusion.
- `.opencode/plugins/summer.js` orientation banner updated to 22 skills with explicit process / discipline / build priority.

### Fixed
- **Critical:** 4 broken skill paths in `.claude-plugin/plugin.json` and `.cursor-plugin/plugin.json`. Plugin install would silently fail for `gdscript-patterns`, `ui-basics`, `asset-strategy`, and `debug` (the latter didn't exist at all). All paths now resolve.
- 2 missing HAVE-status multiplayer skills now listed in all manifests.
- TypeScript build excludes `*.test.ts` so `npx tsc` produces clean dist without vitest type leakage.

### Notes for plugin install
- After v2, `claude /plugin install summer@summer-marketplace` resolves cleanly. The `SummerEngine/summer-marketplace` repo (one-file marketplace) needs to be created and pushed; contents are in `docs/marketplace-repo/`.
- Existing `1.x` users updating: `npm update -g summer-engine` then `summer setup <agent> --yes` to refresh skill installs.

## [1.3.2] — 2026-05-05

### Fixed
- `summer_input_map_bind` syntax aligned across `fps-controller` SKILL.md and its behavioral test spec.
- `workflow/skill-test` static linter relaxed to allow forward-reference `See also` links to other SKILL.md files (warn instead of fail).

### Added
- `references/summer-folder.md` — canonical `.summer/` folder convention (documents files written by `/summer:brainstorm-game`, `/summer:art-direction`, etc.).
- `CHANGELOG.md` — retroactive v1.0.0 → v1.3.1 history.

## [1.3.1] — 2026-05-05

### Added
- ASCII banner displays on bare `summer` command (`npx summer-engine`).
- ANSI colors throughout: green ✓ for OK, yellow ⚠ for warnings, red ✗ for failures.
- Brand line + colored slash command list in setup output.
- `/debug` workflow skill — triage and fix a bug end-to-end via Summer MCP diagnostics.
- `/play` workflow skill — run the game and report state.
- 7 specialist skills marked `user-invocable: false` (auto-trigger only).

### Fixed
- `summer doctor` defaults to human-readable output instead of JSON.
- Engine path display shortened (`/Applications/Summer.app/Contents/MacOS/Summer` → `/Applications/Summer.app`).
- Home-relative paths now display tildeified.
- MCP server status no longer leaks "stdio" implementation detail (now reads "ready").
- `tools/summer-cli/src/bin/` finally tracked in git (root `.gitignore`'s `[Bb]in/` was silently excluding the npm entrypoint).
- `LICENSE` now bundled in the npm tarball.

## [1.3.0] — 2026-05-05

### Added
- 20-category skill library scaffold with descriptive folder names (`character-controllers`, `gameplay-mechanics`, `scripting-patterns`, etc.).
- `references/` directory with 5 canonical references (godot-version, mcp-tools-reference, collaborative-protocol, template-registry, gd-style).
- `workflow/` directory with 3 meta-skills (skill-test linter, skill-create bootstrap, skill-improve eval harness).
- `tests/specs/` directory with per-skill behavioral test specs (fps-controller as canonical format).
- `catalog.yaml` — 85-skill roadmap with HAVE / NEXT / LATER status.

### Changed
- 7 existing skills migrated into category folders with Anthropic-spec frontmatter (`category`, `template-id`, `allowed-tools`, `paths`).
- CLI `skills install` walks `<skillsDir>/<category>/<name>/` paths.

## [1.2.1] — 2026-05-05

### Added
- `summer setup <agent>` — one-shot MCP config + recommended skills install + doctor.
- `summer doctor` — node, login, engine, local API, MCP boot diagnostics.
- `summer mcp setup <agent>` — idempotent JSON/TOML config writer.
- Multi-agent skills install (codex, claude-code, cursor, windsurf with user/project scopes; Cursor `.mdc` rule generation; Windsurf rule blocks).
- Skill registry (`src/lib/skills-registry.ts`) with category metadata.
- Per-agent docs (OVERVIEW, CLAUDE_CODE, CODEX, CURSOR, SKILLS, TEMPLATES).

### Changed
- `/api/mcp/assets`: removed Pro gate; public/community asset search now free for all signed-in users (deployed on summerengine.com).
- `/api/mcp/log-local-call`: removed visible 100/week quota; auth-gated telemetry only.

## [1.2.0] — 2026-04-23

### Added
- Initial public release on npm.
- MCP server with 36 `summer_*` tools.
- 7 specialist skills (`fps-controller`, `gdscript-patterns`, `scene-composition`, `3d-lighting`, `ui-basics`, `asset-strategy`, `make-game`).
- CLI commands (`install`, `login`, `logout`, `status`, `run`, `open`, `create`, `list`, `skills`, `mcp`).
- MIT license.
