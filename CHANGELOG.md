# Changelog

All notable changes to summer-engine will be documented here. Following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [Unreleased] — 3.0.0 — "The Library"

v3 rebuilds the package around one idea: every resource is described once (`library/<kind>/<slug>/resource.yaml`) and everything else — the searchable index, every agent manifest, the skill and template registries, counts, aliases — is generated from it, with CI failing on drift. Design: `docs/design/CONTRACT.md`; what is verified vs. planned: `docs/design/STATUS.md`; migration: `docs/MIGRATION-V2-V3.md`.

### Added
- **The Library** (`library/`): the v2 `skills/` and `references/` trees became flat `library/skills/<slug>/` and `library/references/<slug>/`, each with a `resource.yaml` descriptor (id, summary, `use_when`, facets, `related`, aliases for every old path); every MCP tool got a `library/tools/<slug>/` descriptor (implementation path, MCP/CLI surfaces, `input_schema`, `authority` booleans, `remote`); templates became `library/templates/<slug>/` pin manifests. JSON Schemas per kind in `registry/schemas/`. New skills: `scene-scripting`, `verifying-scenes`, `character-animation-wiring`, `world-building-3d`, `running-in-the-cloud`. The session entry skill `using-summer` is now installed by `setup` (v2 installed only the recommended subset, which never included it).
- **Registry compiler** (`scripts/generate-registry`): compiles `library/` into `registry/generated/` (`index.json`, `counts.json`, `aliases.json`, `skills-registry.json`, `templates-registry.json`) and applies every agent manifest at the repo root (`.claude-plugin/*`, `.codex-plugin/`, `.cursor-plugin/`, `.factory-plugin/`, `gemini-extension.json`, `.mcp.json`). `--check` is the CI parity gate. `scripts/validate-library`: schema validation, capability lint (allowlisted URLs only, no install commands, no credential references, no encoded blobs or invisible unicode), and cross-checks that every tool descriptor names a real module, export, and MCP registration.
- **`summer tool <name> --args '<json>'`**: every MCP tool from the shell, same implementation, arguments validated with the tool's own zod schema; `summer tool --list`. A descriptor ↔ zod parity test fails the build when a tool's `input_schema` disagrees with its registration (it found three drifted descriptors on its first run).
- **Pinned templates**: `summer create <slug>` resolves only through the compiled pin manifests — `git fetch --depth 1` of the exact commit, tree-digest verification (mismatch removes the directory), detached checkout; built-in templates (`builtin: true`) generate offline. The pin is recorded into **`.summer/project.json`** (`template {id, version, repo, commit, tree_digest}` or `builtin: true`, `toolkit_version`, `created_at`). `summer list templates` reads the same registry; there is no GitHub-org listing anywhere in the CLI.
- **`summer_library_feedback`**: the library outcome mailbox (worked / worked_with_fixes / wrong / outdated / incomplete / did_not_apply / misrouted, 280-char note and deviation). Sends entry ids, outcomes, `engine_version`, `agent_model`, `toolkit_version`, host `client`, a per-process `session_id`, and — logged out — a random `install_id` uuid; nothing else. The first call on a machine sends nothing and returns a notice; `SUMMER_NO_TELEMETRY=1` / `DO_NOT_TRACK=1` disable it.
- **Scene scripting, perception, and spatial tools** (preview — they return `engine_lacks_op` until the engine ops ship): `summer_run_script`, `summer_run_editor_script`, `summer_api_docs` (offline class reference, works without the engine), `summer_world_snapshot`, `summer_snapshot_diff`, `summer_get_runtime_tree`, `summer_inspect_runtime_node`, `summer_import_hdri` (Poly Haven CC0 HDRIs), `summer_test_placement`, `summer_snap_to_surface`, `summer_align_distribute_3d`, `summer_navigation_probe`.
- **Mesh fabrication** (preview — returns `engine_lacks_op` until the engine op `FabricateMesh` ships): `summer_fabricate_3d` / `summer tool fabricate-3d` runs a Blender Python (bpy) script in the user's own installed Blender, headless and engine-supervised, imports the exported `.glb` into `res://` and optionally instantiates it with `target_size`. Summer never bundles or downloads Blender; a missing install comes back as a prescriptive `blender_not_found`. The `fabricating-assets` skill carries the route decision (fabricate vs generate vs library), the bpy rules that survive glTF export, and the failure taxonomy.
- **Stable viewpoints and deterministic playtests** (wave I perception; engine PR #156 follow-up): `summer_camera_bookmark` saves/lists/deletes named camera poses in the project (`res://.summer/camera_bookmarks.json`; `engine_lacks_op` on older engines); `summer_screenshot` target `scene` gains `framing: "bookmark"` (+ `bookmark_name`) and `"free"` (+ `camera_position`/`camera_look_at`/`fov`) for before/after frames from one fixed pose, plus `marks`/`max_marks` — a Set-of-Mark overlay whose numbered labels the caption maps to node paths; older engines echo the preset they fell back to and the caption says the frame is not pose-stable. `summer_play` gains `seed` / `fixed_fps` / `time_scale` (sent as an explicit `PlayGame` op; the result narrates `determinism.applied`, `reason`, `seed_scope`, and says "not applied" when the engine predates the params). Skills `verifying-scenes` (stable viewpoints) and `playtesting-a-feature` (deterministic runs) updated.
- **Editor UI control** (preview — returns `engine_lacks_op` until the seven `Ui*` engine ops ship): `summer_ui_actions` (list the editor's named actions / invoke one exactly as its shortcut would), `summer_ui_tree` (structured Control tree, or every visible dialog with its blocking flag via `root:"dialogs"`), `summer_ui_activate` (press / toggle / focus / select_tab incl. the `main_screen` switch / set_text / set_value by tree path, plus `action:"dismiss_dialog"`), `summer_ui_screenshot` (PNG of the editor window or one control, honest `no_renderer` headless) — the same four as `summer tool ui-*`. Semantic-first by design: scene work stays with the scene tools, there is no coordinate click, and quit / project-reload / delete-without-confirm actions are denied by the engine. The `driving-the-editor-ui` skill carries the blocking-dialog and main-screen patterns.
- **Runtime control & playtest tools** (preview — `engine_lacks_op` until the engine's runtime-control ops ship): `summer_game_probe` (state + screenshot of ONE frame, frame-stamped, returned as an image), `summer_game_control` (pause / resume / step exact frames / speed / instances), `summer_game_input` (timed input scripts; record real input and replay it deterministically), `summer_runtime_set`, `summer_runtime_call`, `summer_runtime_spawn`, `summer_runtime_animate` — all instance-aware. `summer_play` gains `instance` / `mode:"offscreen"` / `deterministic` / `seed` / `fixed_fps` / `speed` (plain play is unchanged); `summer_stop` gains `instance`. The `agent-playtesting` skill carries the doctrine: deterministic launch, probe before/after, frame stepping for exact assertions, scripts vs recordings, what a seed does not pin.
- **Capability pre-flight**: `summer_get_project_context` reads the engine's capability list; tools whose op the running build lacks return a structured `engine_lacks_op` result instead of failing mid-flight. `SUMMER_CAPABILITY_PREFLIGHT=off` sends everything anyway.
- **Events channel** (preview — needs an engine build with `GET /api/events`, engine PR #156 follow-up commits): `summer_wait_for_event` blocks until a matching engine event arrives (`play.started` after `summer_play`, `op.applied` / `op.failed` filtered by `requestId`, `script.error` during a playtest, `scene.saved`, `import.completed`, …) or a bounded timeout elapses, reporting `timed_out` honestly and returning `next_seq` as the cursor for the next wait; `summer_recent_events` reads the newest events in one zero-wait poll (take its `next_seq` before triggering the action you will wait on); `summer events [--follow] [--kinds …] [--since N] [--json]` streams them from the shell over the same long-poll route (an SSE client is a follow-up). Engines without `capabilities.events` get a structured `engine_lacks_events` result on both faces before anything is sent.
- **Headless per-project routing** behind `SUMMER_HEADLESS_ROUTING=1` (`src/core/headless/`): with no editor open, file/import/scene-read/game-run ops route to a spawned engine worker; editor-only tools fail with an explicit "not supported by the headless worker". Unset, the module is never loaded. Needs an engine build with worker mode (not yet shipped).
- **Linux** `summer install` (x86_64): installs the engine binary under `~/.summer/engine/` or symlinks a local build via `--path`; `SUMMER_ENGINE_BINARY` overrides engine discovery everywhere.
- **`SUMMER_TOKEN`** env override for the auth token (CI / cloud sessions); `summer status` and `summer logout` say when it is in effect.
- **Opt-in trajectory capture** (`SUMMER_TRAJECTORY_DIR`): per-tool-call JSONL for eval corpora; off by default.
- **Evals**: routing eval (`npm run eval:routing`, gated on a committed baseline; refuses a stale baseline or fallback corpus) plus a blind held-out set (`eval:routing:heldout`, report-only); per-kind eval contracts under `evals/`.
- **`integrations/`**: one folder per supported client (13) documenting exactly what `summer setup <client>` writes where; a test keeps it in step with the compiler's manifest targets.
- Playbook served natively as the `summer_agent_playbook` MCP prompt; `summer_get_agent_playbook` and `summer tool get-agent-playbook` share one implementation.

### Changed
- `summer setup <agent>` installs **every** skill in the library (v2 installed the recommended subset and silently skipped the entry skill); `--recommended` restores the subset. Skills and MCP config are installed in the same scope. Setup reports counts and destination.
- `summer install` no longer deletes an installed `/Applications/Summer.app` before copying the new one. An equal version exits 0 as "up to date"; replacing a different version needs `--yes` or a TTY confirmation; the new bundle is staged as `Summer.app.new` and swapped in only after the copy succeeds, so a failed copy leaves the old engine in place; Ctrl-C mid-download removes the partial DMG.
- `summer tool <name> --args <json>` replaces `--json <args>` (every other command's `--json` is a boolean output switch). `--json <args>` still works for one release as a hidden alias and prints a deprecation note.
- `summer mcp setup <agent>` is a deprecated alias of `summer setup <agent>` (the one setup path: MCP config + skills + doctor). Its contributor-only `--local-dev` flag is hidden from `--help` (also honoured via `SUMMER_DEV=1`).
- `summer run` with no path requires `--no-project` to launch a bare editor; `summer <unknown-command>` exits 1 instead of printing the intro.
- `summer login` fails fast on terminal gateway answers (4xx, invalid token type) instead of polling for 15 minutes with the error hidden behind the heartbeat.
- One `resolveGatewayUrl()` for every gateway caller: `gateway.url` in `~/.summer/config.json` (and `SUMMER_GATEWAY_URL`) now steers login, token validation, feedback, creator publish/releases, and version checks alike — previously only login honoured it, so tokens for a dev gateway were posted to production.
- `summer skills list/install/info` and `summer setup` read the generated `skills-registry.json`; the hand-maintained TS `SKILL_REGISTRY` is gone. Skill cross-references use the bare slug (`use the design-mechanic skill`); the v2 `summer:<category>/<name>` form is retired.
- `withEngine` classifies validation and capability failures as `input` / `unsupported` instead of labelling every throw a transport failure ("may have partially applied").
- `authority` on `summer_generate_image`, `summer_creator_publish`, `summer_library_feedback`, and `summer_screenshot` now says `filesystem: true` (they write files); `surfaces.mcp.remote` is set explicitly on every tool.
- Package: `engines.node >= 20` (was 18; the scripts need Node 22+ to run TypeScript natively), `@modelcontextprotocol/sdk` ^1.30 (MCP v2 posture, stdio unchanged). `library/`, `registry/generated/`, `registry/schemas/`, and `integrations/` ship in the npm package.
- Docs: `AGENTS.md` is a four-part router (trust, understand, navigate, work); `CLAUDE.md` and `GEMINI.md` are thin shims over it; the README carries the agent install playbook. `docs/TEMPLATES.md` retired in favour of `library/templates/README.md`.

### Removed
- **`summer_frame_camera` / `summer_camera_visibility`** (frame-camera, camera-visibility — dropped by their author after benchmarks): the two spatial tools did not significantly improve anything in Marcus's follow-up benchmarks, so the MCP + `summer tool` faces, descriptors, skill guidance, and canary entries are gone; their engine ops (`FrameCamera3D`, `CameraVisibility3D`) may leave engine PR #158 too.
- **Summer Cloud** (research preview): the `summer cloud` command group, the seven `summer_cloud_*` MCP tools, the `summer-cloud` skill, the `library/tools/cloud-*` descriptors, the sync engine under `src/core/capabilities/cloud/`, and cloud-token minting during `summer login`. It was not operational or maintained; Summer Platform publish/releases is the supported path. `summer-cloud.json` and `.summer/local/cloud/` in old projects are inert and can be deleted; `summer logout` still removes a legacy `~/.summer/cloud-token`. The `doctor` "Git (cloud checkpoints)" check went with it. Web-side cleanup (`/cloud` page, `app/api/cloud/*`, cli-login `cloudToken` minting) is a separate web-repo PR.
- **The v2 `skills/` and `references/` trees** and every hand-written plugin manifest — `library/` is canonical and the root manifests are build artifacts.
- **`summer agent`** (`src/cli/commands/orchestrator.ts`): a development-only launcher for the web app from a sibling checkout (hardcoded sibling paths, non-portable `URL.pathname`, `spawn("pnpm")` without a shell). It never belonged in the published CLI. Its `~/.summer/web-app-path` and `~/.summer/agent-port` files are inert.
- **`summer logs` / `summer_creator_logs`**: the command, MCP tool, `summer tool creator-logs` dispatch entry, and `library/tools/creator-logs` descriptor. The implementation could only ever throw `creator_backend_unavailable` (there is no platform runtime-log API), so every call failed by design. It returns when a durable log source exists.
- Dead `postinstall` entry (`src/bin/postinstall.ts`, never referenced by `package.json`) and the stale welcome box in `banner.ts` (`getWelcome`/`printWelcome`/`printBanner` with "cloud: animation, texturing" and `/help` copy). Only `getBanner` remains.
- Dead dependencies `ai` and `@ai-sdk/anthropic` (12.9 MB, imported by nothing) and the unused `diff` dependency; the unused `assertCredentialScopes` export.

### Fixed
- Three tool descriptors had drifted from their zod (`summer_library_feedback` missing the required `agent_model`, `summer_instantiate_scene` `target_size`, `summer_screenshot` `camera` framing) — caught by the new parity test.
- Template pinning was documentation-only in the first v3 cut (`summer create` still cloned mutable default branches, nothing wrote `project.json`); the resolver now does what the docs said. Built-in templates no longer carry placeholder "self-pins"; the schema requires exactly one of `builtin: true` or a real pin. The one template whose repo is private is `status: preview`.
- 359 cross-skill references in the v2 `summer:<category>/<name>` form (none resolved), 46 broken relative links, and 20 references to skills that do not exist, purged from skill and reference bodies.
- The pre-commit doctor hook never fired in Claude Code or Cursor (wrong matcher shape); it now fires, is opt-in (`SUMMER_PRE_COMMIT_DOCTOR`), and is portable. The OpenCode plugin pointed at the deleted `skills/` directory and loaded zero skills; it now loads `library/skills/`.
- `summer open <path>` failed whenever the engine was not running (commander argument binding); `summer run` spawn errors are handled; `summer plan` routes on whole words (no more "spaceship" → ship, "build" → ui).
- `summer install` on Linux; the Gemini installer writes the generated manifest plus `GEMINI.md`/`AGENTS.md` into the extension dir; five integration READMEs corrected (factory is a marketplace-only target, kilo-code paths, gemini manifest, opencode config shape, scope mismatch).
- Corrupt `credential-metadata.json` no longer strands the auth token; `summer status` survives a corrupt `user.json`; store errors name the OS error code; `rebind()` fails typed instead of returning stale identity; `gameSnapshot` issues one request instead of a probe plus a capture; stale snapshot files are reaped.
- `summer_batch` no longer promises an undo step it cannot keep; the playbook's step 0 no longer leads with an op most shipped engines lack; login/run hints use `npx -y summer-engine@latest`.
- Capability lint: closed the false negatives found by a 58-probe smuggling audit; count-claims guard scans the docs that actually carry counts (`README.md`, `AGENTS.md`, `GEMINI.md`, `CLAUDE.md`, `library/references/**`, `integrations/**`, `.opencode/**`) and derives expectations from `counts.json`, never literals.
- Routing eval refuses to pass on a stale baseline or a fallback corpus; the op-drift tripwire runs when an engine checkout is available (`SUMMER_ENGINE_REPO`) instead of silently passing.

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
