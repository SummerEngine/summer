# Scene-scripting integration — `scene-scripting/v3-integration`

One reviewable branch that merges every scene-scripting wave branch onto `v3-foundation`. Written 2026-09-03 as the merge record for the reviewer: what came in, what collided, how each collision was resolved, and what is still owed. Companion pages: `STATUS.md` (what works today), `ROADMAP.md` (sequencing), `CONTRACT.md` (the rules the resolutions had to respect).

## What this branch merges

Base: `origin/v3-foundation` at `9a8b96e` (librarian + navigation + tag discipline; 191 resources). Every wave branch forked from the same earlier commit (`a94fe4b`), so each merge also reconciled the 15 `v3-foundation` commits in between (controlled facet vocabulary, minimum routing metadata, `summer_open`, the librarian tools, the reciprocity hint).

Merged in this order with `git merge --no-ff` — one merge commit per branch, no rebase, no squash, so `git log --first-parent` reads as the integration and each branch's own history is intact underneath:

| # | Branch | Merge commit | One line |
|---|---|---|---|
| 1 | `scene-scripting/skills-sync` | `75d1ad9` | `scene-scripting` skill gains the Wave H section (2D, UI, gameplay-code ctx lane) with signatures matching the frozen ctx v4 contract; `verifying-scenes` gains 2D/UI capture guidance. |
| 2 | `scene-scripting/game-feel-fix` | `17c574a` | `summer_set_resource_property` on inline sub-resources: the tools reference and five skills (audio-direction, debug, design-npc, fps-controller, game-feel) describe the silent value-shape failures instead of the old "inline targets fail" myth. |
| 3 | `scene-scripting/events-tools` | `2d4724d` | `summer_wait_for_event`, `summer_recent_events`, `summer events` over the engine events channel (`capabilities.events`, `/api/events/poll`); `engine_lacks_events` pre-flight; `EngineEventsCapability` advert parsing. |
| 4 | `scene-scripting/fabricate-tools` | `7d66ddf` | `summer_fabricate_3d` (engine op `FabricateMesh`, wave K: a bpy script in the user's own Blender, engine-supervised, imported as `.glb`) plus the `fabricating-assets` skill. |
| 5 | `scene-scripting/perception-tools` | `53e594a` | Wave I perception: `summer_camera_bookmark`, fixed-pose (`free` / `bookmark`) and Set-of-Mark (`marks`) screenshots, `summer_play` determinism pins (`seed` / `fixed_fps` / `time_scale`) with honest "not applied" narration; `verifying-scenes` and `playtesting-a-feature` updated. |
| 6 | `scene-scripting/ui-tools` | `d0b640f` | Wave L editor UI control: `summer_ui_actions`, `summer_ui_tree`, `summer_ui_activate`, `summer_ui_screenshot` over the seven `Ui*` engine ops, plus the `driving-the-editor-ui` skill. |
| 7 | `scene-scripting/runtime-tools` | `cfed2d1` | Wave I runtime control & playtest: `summer_game_probe`, `summer_game_control`, `summer_game_input`, `summer_runtime_set` / `_call` / `_spawn` / `_animate`; instance-aware `summer_play` / `summer_stop` (`instance`, `mode:"offscreen"`, `deterministic`, `speed`); `runtimeControl` advert; the `agent-playtesting` skill. |
| 8 | `scene-scripting/evals-outcomes` | `e3b7b26` | Outcome eval harness MVP-0 (`evals/outcomes/`: replay + assertions, 8 tasks, 6 mutants, goldens compiled from YAML, `npm run eval:outcomes`, CI `--dry-run` step), eval-mode full trajectory capture (`SUMMER_TRAJECTORY_EVAL=1`), baseline for engine 0.5.65. |

The brief spoke of nine branches; `origin` carries exactly these eight `scene-scripting/*` branches and all eight are in. Between the merges sit the fix commits the incremental green rule required (`2f1fb36` after merge 3, and the post-merge commits listed under "Stale-doc fixes" below).

## Final counts

From `registry/generated/counts.json` after the last merge (the count guard derives every doc claim from it):

- **209 resources** — **86 tools / 95 skills / 19 templates / 9 references**.
- **25 preview tools** (`grep -l 'status: preview' library/tools/*/resource.yaml`), **14 preview skills** (7 source-cited intake skills, 7 that depend on unmerged engine ops).
- `summer tool --list` prints 86 entries (plus a header and a two-line footer); `summer --help` lists 20 commands plus `help` (`summer events` is new).
- 81 of the 86 tools are implemented in `src/mcp/tools/*.ts`; 42 of 86 carry `evidence_checks`.

## Preview tools gated on engine work

All of these return a structured `engine_lacks_op` (the two event tools: `engine_lacks_events`) on every shipped engine and are `status: preview`. The engine side is **SummerEngine/SummerEngine PR #156** and the follow-up commits on its scene-scripting branch (`claude/summerengine-python-scene-scripting-qar1us`, whose generated `op_registry.json` already lists every op below).

| Wave | Tools | Engine ops / feature |
|---|---|---|
| scene scripting (#156) | `run-script`, `world-snapshot`, `snapshot-diff`, `get-runtime-tree`, `inspect-runtime-node` | `RunSceneScript`, `GetWorldSnapshot`, `DiffWorldSnapshot`, `GetRuntimeSceneTree`, `GetRuntimeNode` |
| events channel (#156 follow-up) | `wait-for-event`, `recent-events` (+ `summer events`) | `capabilities.events` + `GET /api/events/poll` — a capability, not an op |
| wave K fabrication (#156 follow-up) | `fabricate-3d` | `FabricateMesh` |
| wave I perception (#156 follow-up) | `camera-bookmark` (and the `bookmark` / `free` / `marks` params of the stable `screenshot`) | `SaveCameraBookmark`, `ListCameraBookmarks`, `DeleteCameraBookmark` |
| wave L editor UI (#156 follow-up) | `ui-actions`, `ui-tree`, `ui-activate`, `ui-screenshot` | `UiListActions`, `UiInvoke`, `UiTree`, `UiActivate`, `UiScreenshot`, `UiDialogs`, `UiDismissDialog` |
| wave I runtime control (#156 follow-up) | `game-probe`, `game-control`, `game-input`, `runtime-set`, `runtime-call`, `runtime-spawn`, `runtime-animate` (and the `instance` / `mode` / `deterministic` params of the stable `play` / `stop`) | `SetRuntimeProp`, `CallRuntimeMethod`, `SpawnRuntimeScene`, `FreeRuntimeNode`, `RuntimeAnimation`, `RuntimeAnimationTree`, `GetRuntimeBones`, `GamePause`, `GameStep`, `GameSpeed`, `SimulateInputScript`, `InputRecordStart`, `InputRecordStop`, `InputReplay`, `GameProbe`, `ListGameInstances` |
| spatial (#158) + starcast (#147) | `test-placement`, `snap-to-surface`, `align-distribute-3d`, `navigation-probe`, `starcast` | `TestPlacement3D`, `SnapToSurface`, `AlignDistribute3D`, `NavigationProbe3D`, `Starcast3D` |

`src/core/op-registry-drift.test.ts` waives exactly these ops in `KNOWN_UNIMPLEMENTED` (all wave entries in the `engine PR #156 follow-up (…)` form). Its first half ("never sends an unknown op") passes against the engine feature branch; its second half ("the waiver list stays honest — entries must still be missing") is **expected to fail** against that branch, because the branch implements them — that failure is the signal to delete the waivers once the engine work is on `main`.

## Conflicts resolved (and how)

Rule followed throughout: keep both sides' intent; never drop a tool, skill, query, or parameter; regenerate build artifacts instead of hand-merging them.

| Where | What collided | Resolution |
|---|---|---|
| `registry/generated/*`, root plugin manifests (`.claude-plugin/*`, `.codex-plugin`, `.cursor-plugin`, `.factory-plugin`, `gemini-extension.json`) | every branch regenerated them against a different library | Never hand-merged: `npm run generate:registry` after each merge, committed as part of the merge commit; `--check` clean at every step. |
| `CHANGELOG.md` Unreleased | one bullet per branch at the same anchor | Union in merge order (fabrication, viewpoints/determinism, editor UI, runtime control, events); no duplicates. |
| `library/references/mcp-tools-reference/mcp-tools-reference.md` | "Tool surface (N tools)" header + section insertions at the same anchors | Header recomputed after every merge (final: 86, equals `counts.json`); sections unioned (Mesh fabrication, Editor UI control, Events, Runtime control & playtest); the `summer_play` / `summer_stop` rows merged into one description each covering pins and instances. |
| `docs/DEVELOPMENT.md` | "N of the M tools" layering claim (five branches), env-var paragraph (`SUMMER_EMBED_URL` vs `SUMMER_TRAJECTORY_EVAL` / `SUMMER_EDITOR_BIN`) | Recomputed from the merged library at each step (final 81 of 86); env vars unioned; `summer events` row and 20-command count from the events branch kept. |
| `docs/TESTING.md` §f | preview count + list (events, perception, UI, runtime each rewrote it) | Rewritten once from the live list: 25 preview, twenty-three op-gated (named) + the two event tools; `fabricate-3d` and `camera-bookmark` added — both were missing from every branch's own text. |
| `evals/routing/queries.yaml` | each branch appended queries at the same anchor | Union (103 queries). |
| `evals/routing/baseline.json` | regenerated per branch | Took HEAD during the merges, regenerated once at the end with `--update-baseline`, then `--check`. |
| `library/skills/playtesting-a-feature/{SKILL.md,resource.yaml}` | events, perception, and runtime all touched it | SKILL.md paragraphs auto-merged (deterministic runs + live-game doctrine); resource.yaml `use_when` unioned, `related` merged into one block (tools from perception, `skill/agent-playtesting` from runtime); version bumped once to 1.1.1. |
| `library/skills/verifying-scenes/resource.yaml` | version/summary (perception) vs `related.tools` (events) | Perception summary (superset), related tools unioned (events + camera-bookmark), 1.1.1. |
| `library/tools/play/resource.yaml` | perception's `seed`/`fixed_fps`/`time_scale` vs runtime's `instance`/`mode`/`deterministic`/`seed`/`fixed_fps`/`speed`; two `related:` blocks auto-merged into duplicate YAML keys | All eight parameters kept (the engine's `PlayGame` op accepts every one, `speed` and `time_scale` included); merged `seed`/`fixed_fps` descriptions; `fixed_fps` keeps `exclusiveMinimum: 0`; duplicate `related:` collapsed to the superset block; summary shortened under the 160-char schema limit; domains unioned (debug, runtime, verification); 1.1.2. |
| `library/tools/screenshot/resource.yaml`, `stop`, `ui-basics`, `audio-direction`, `fps-controller` | version bumps / `use_when` additions from two sides | `use_when` unioned; version one patch above the higher side. |
| `src/mcp/tools/debug-tools.ts` — `summer_play` | perception: `client.play(scene, pins)` + determinism narration; runtime: `PlayGame` op via `buildPlayGameOp` with instance pre-flight | One handler: plain launch stays on `/api/play` byte-for-byte; any pin or instance parameter travels as the explicit `PlayGame` op (runtime's builder, extended with `time_scale`), instance targets pre-flight on `ListGameInstances`, and perception's `describePlayDeterminism` narration is layered on the result. Description and zod shape are the union (8 params). `EngineApiClient.play(scene, determinism)` is kept as the perception branch wrote it. Perception's MCP and CLI tests moved their mocks from `play` to `executeOps` — same wire expectations (`[{op:"PlayGame", …}], undefined, 60_000`); runtime's shape-key test gained `time_scale`. |
| `src/core/capabilities/tool-dispatch.ts` | imports, helper blocks, `summer_play` / `summer_stop` entries, tool entry blocks from five branches | Imports and entry blocks unioned; helpers unioned (`requireEventsChannel`, `requireEventsSuccess`, `buildOrRefuse`, `optNumberOrUndefined`, `dispatchUiOp`, `runRuntimeOp`); `summer_play` merged as on the MCP face (perception's argument checks first, `buildOrRefuse(buildPlayGameOp)`, instance pre-flight, `determinism_note` when pins were ignored); `summer_stop` from runtime. |
| `src/core/capabilities/tool-dispatch.test.ts`, `src/mcp/tools/descriptor-parity.test.ts`, `src/mcp/server.ts` | registrar lists / appended `describe` blocks git interleaved | Rebuilt from both clean index sides (ours + the other side's appended block) — every `describe` from every branch is present; registrar lists are the union in merge order. |
| `src/core/capability-skew.ts` | `CLI_KNOWN_OP_NEEDS`, `FALLBACK_SINGLE_ONLY_OPS`, `EngineCapabilities` fields and parsers (events vs runtimeControl) | Unioned; the `PlayGame` entry perception and runtime both added is listed once with a merged comment; `advertisedOpKinds` (runtime) coexists with `parseEventsCapability` (events). |
| `src/core/op-registry-drift.test.ts` `KNOWN_UNIMPLEMENTED` | each branch appended its waivers | Union; `RunSceneScript` corrected from "#155" to "#156" (the pre-existing swap); all wave entries already in the `#156 follow-up (…)` form. |
| `registry/schemas/domains.json` (v3-foundation's closed vocabulary) vs the runtime branch's facets | eight runtime resources use the domain `playtest`; `game-input` also used `input` | `playtest` added to the vocabulary with a note (the validator's own instruction: grow by PR); `input` (single use) remapped to `verification`, matching `game-control` / `game-probe`; `game-input` bumped to 1.0.1. |

Routing regressions surfaced by the merges were fixed with metadata, not by accepting a lower baseline: `tool/screenshot` (after the events tools joined the index, "take a screenshot of the game" ranked `is-running` first) and, after all merges, `skill/audio-direction` ("what should my game sound like overall") and `tool/open` ("open the main scene in the editor") each gained a `use_when` line that states the ask in the user's words.

## Stale-doc fixes made

- `docs/DEVELOPMENT.md`: "81 of the 86 tools" layering claim; env-var list now names `SUMMER_TRAJECTORY_EVAL`, `SUMMER_EDITOR_BIN`, `SUMMER_EMBED_URL` together.
- `docs/TESTING.md` §f: preview count and list rebuilt from the library (25; `fabricate-3d` and `camera-bookmark` had been omitted by every branch).
- `library/references/mcp-tools-reference/mcp-tools-reference.md`: "Tool surface (86 tools)"; `summer_play` / `summer_stop` rows describe pins and instances.
- `src/core/op-registry-drift.test.ts`: `RunSceneScript` is engine PR #156, not #155.
- `docs/design/STATUS.md` and `docs/design/CONTRACT.md` (not scanned by the count guard — `count-claims.ts` covers the root docs, `library/references`, `_persona`, `.opencode`, `integrations`, and `docs/*.md` shallow only): resource/tool/skill counts (209 / 86 / 95), preview counts (25 tools, 14 skills), `summer tool --list` (86), `summer skills list` (95), test count, the 39 / 22 / 25 tool split, the gated-tool inventory, "42 of 86 tools carry `evidence_checks`".

## Known follow-ups

- **Count staleness outside the guard.** `count-claims.ts` and `public-surface-counts.test.ts` do not scan `docs/design/`, so STATUS.md and CONTRACT.md were updated by hand here and will drift again. Either extend `COUNT_CLAIM_SHALLOW_DIRS` to `docs/design` (ROADMAP.md's dated log lines would then need rephrasing) or keep treating those two files as a release-checklist item.
- **Drift waivers.** When the engine's scene-scripting work reaches `main`, `op-registry-drift.test.ts`'s honesty half turns red on purpose: delete the corresponding `KNOWN_UNIMPLEMENTED` entries, flip the tools from `preview` to `stable`, and rerun the TESTING.md §f list.
- **`summer_play` parameter overlap.** `time_scale` (perception, `--time-scale`) and `speed` (runtime, user time scale on session start) are both accepted because the engine op accepts both; one of them should eventually be documented as the preferred spelling.
- **`PlayGame` pre-flight.** Pins on the embedded game are sent without a capability pre-flight (an older engine ignores them and the result says "not applied"); instance targets pre-flight on `ListGameInstances`. Revisit once `capabilities.opKinds` on shipped engines lists `PlayGame` reliably.
- **Commit identity.** Every wave branch and every commit on this branch carries the environment's configured git identity (`/root/.gitconfig`); the messages carry no tool attribution. If the repository wants a human author on the merge commits, rewrite authorship before merging to `main`.
- **Held-out routing.** The tuning set is back at recall@5 1.0 after the two metadata fixes; the held-out set (`eval:routing:heldout`) was not re-run here and remains the honest index-quality number.
- **`evals/outcomes` replay** still needs `SUMMER_EDITOR_BIN` and an engine build with the runtime ops; only the `--dry-run` half is gated in CI.

## Rebase onto the E2E fix wave (2026-09-03, later)

`v3-foundation` moved 17 commits (`9a8b96e` → `27d82bb`, the `E2E-2026-09-03.md` fix wave) while this
integration was built, so the branch was replayed onto it as `scene-scripting/v3-integration-rebased`:
a linear series of the 16 wave commits (the eight per-wave merge commits are gone; their conflict
resolutions were replayed 1:1). Cross-side resolutions kept both intents: every new CLI dispatch entry
runs through `requireEngineSuccess`; `summer_screenshot` on both faces builds its input with
`camera-view.ts` and captures through the shared `capture.ts` (blank-frame recapture + scene-kind
confession now apply to fixed-pose/bookmark renders too); `trajectory_eval_mode` is emitted by the one
`buildProjectContext` builder instead of once per face; the runtime-tools merge (`cfed2d1`) had edited
files outside its conflict hunks (PlayGame `time_scale`, the `playtest` domain, `game-input` 1.0.1, the
`summer_play` tests) — those edits ride in the runtime-tools commit. `tool/screenshot` and
`skill/playtesting-a-feature` carry content from both sides and were bumped to 1.1.2.
