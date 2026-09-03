# Outcome evals — does the agent's work hold up as a scene or a game?

**What is tested:** the OUTCOME of an agent trajectory, not the correctness of
individual engine ops. The engine repo's mechanical E2E proves that
`RunSceneScript` rolls back on error and a snapshot diff reports the right
`added[]`; it says nothing about whether "block out a courtyard" produced a
courtyard a camera can frame with its floor on the ground. This family replays
recorded tool-call trajectories through the toolkit's own tool table against a
**fresh editor on a pristine fixture**, then judges the result with programmatic
assertions over five evidence sources: the world snapshot, the snapshot diff,
the `.tscn`/`project.godot` the agent left on disk, a bounded play of the game
(debugger errors), and a verification probe that reads the RUNNING game
(frustum containment, animation-tree state, a jump, a frame). The design this
implements is the engine repo's
`doc/SUMMER/research/blender-mcp/09-outcome-evals-design.md`; this directory is
its MVP-0 cut: **replay mode, assertions only** — no live hosts, no budgets
enforced, no VLM judge.

One rule from `evals/README.md` applies twice here: an eval that cannot fail is
documentation. Every task has a golden (a known-good agent's calls) that must
pass, and most have a **mutant** — the same golden broken in one deliberate way
— that must fail exactly the predicate meant to catch it. A suite where every
golden passes but a mutant slips through has assertions that do not
discriminate, and it goes red.

## Running it

Needs Node >= 22.18 (the runner runs unbuilt, like the rest of `evals/`), a
built toolkit (`npm run build` — the tool table under test is imported from
`dist/`, exactly as `evals/canary` does), and a Summer Engine editor binary. On
Linux without a display you also need `xvfb-run` + Mesa llvmpipe
(`apt-get install -y xvfb libgl1-mesa-dri`): every MVP-0 task either plays the
game, runs a probe child, or renders through the scene camera, and all three
need a real (software) renderer — a `--headless` editor has a dummy
RenderingServer and cannot produce a frame or boot a game window.

```bash
npm run build
export SUMMER_EDITOR_BIN=/path/to/godot.linuxbsd.editor.x86_64   # or SUMMER_ENGINE_BINARY

npm run eval:outcomes                              # all goldens + mutants, compare to baseline.json
npm run eval:outcomes -- --check                   # same; also fails when the baseline is missing or stale
npm run eval:outcomes -- --update-baseline         # accept: writes baseline.json + engine.lock (commit both)
npm run eval:outcomes -- --task T1.1-courtyard     # one task (+ its mutants); add --no-mutants to skip them
npm run eval:outcomes -- --dry-run                 # static half: tasks, goldens, fixtures — no engine (CI, per PR)
npm run eval:outcomes -- --render headless         # headless editor: renderer-needing phases become evidence_missing
npm run eval:outcomes -- --runs-dir /tmp/out       # artifacts root (default evals/outcomes/runs/<stamp>, gitignored)
```

The render mode defaults to `xvfb` when `xvfb-run` is on the PATH, else
`headless`. `--render native` uses the current display (a Linux desktop or
macOS). `--mode live` is refused: live drivers, budgets and the judge are
MVP-1.

Exit status: 0 when every golden passes, every mutant fails exactly its
intended predicate, nothing was refused, and (unless a partial run) nothing
regressed against the committed baseline; 1 otherwise; 2 when the editor binary
or `dist/` is missing.

### What a run leaves behind (`<runs-dir>/<task>[.<mutation>]/`)

| File | Contents |
|---|---|
| `run.json` | task, mode, toolkit version, engine version + sha256 of its advertised `opKinds`, fixture/golden sha256, pre-flight (needed vs advertised ops), per-phase timings, replay divergence |
| `editor.log` | the editor's stdout/stderr (xvfb child) |
| `trajectory.jsonl`, `trajectory.full.jsonl` | the replayed calls, recorded through the toolkit's own capture (redacted + eval-mode full stream) — a passing run's full stream is a valid golden |
| `replay.json` | per-step fresh vs recorded `ok`/`failure_reason`, divergence list, skipped (unreplayable) records |
| `snapshot.before.json`, `snapshot.after.json`, `diff.json` | `GetWorldSnapshot` / `DiffWorldSnapshot` raw results |
| `project.agent/` | `.tscn`/`.gd`/`project.godot` **as the agent left them** — the `tscn`/`project` evidence |
| `project/` | the live project after the runner's freeze save (what the runtime and probe phases ran) |
| `preview.camera.jpg`, `preview.camera.json` | `ScenePreview framing:"camera"` + confession fields + distinct-colour count |
| `runtime.json` | `PlayGame` → `IsGameRunning` → `GetDebuggerErrors` → `StopGame` |
| `verify/probe.gd`, `verify/results.json`, `verify/*.jpg` | the generated probe, its `results.json`, saved frames |
| `assertions.json` | every predicate's pass/fail, reason, severity, detail; the task verdict. **No timings, pids or byte counts** — two runs on the same build are byte-identical |
| `evidence.summary.json` | a compact view of what each phase produced (or why it did not) |

At the root: `board.md` (the scoreboard) and `summary.json` (the baseline
shape plus every run's result).

## Honesty rules (what the harness refuses to fake)

1. **Pre-flight refusal.** Before anything is sent, the runner unions the ops
   the harness, the evidence phases and the golden's tools will need and checks
   them against `/api/health capabilities.opKinds`. A build that provably lacks
   one refuses the task with `evidence_missing:engine_lacks_op` (every
   assertion FAILs with that reason, nothing is replayed, exit 1) instead of
   scoring zeros. An engine that advertises no op list proves nothing and is let
   through — the same posture as the toolkit's per-tool pre-flight. The hook
   `--simulate-missing-ops GetWorldSnapshot` removes ops from a real advert so
   the refusal path can be exercised against a current build.
2. **Unevaluable is FAIL.** A predicate whose evidence is missing (op failed,
   phase not run, file not on disk, unknown or unimplemented predicate) is
   `FAIL` with reason `evidence_missing`, never a skip. `runtime_prop` is the
   one MVP-0 stub — it exists so a task naming it fails loudly.
3. **The agent's disk state is the evidence.** `.tscn`/`project.godot` are read
   from the project as the agent left it, BEFORE the runner's own freeze save.
   `exists` requires a node in both the edited scene and the saved file, so an
   agent that never saved (or created unowned nodes) fails `unsaved`. The freeze
   save exists only so the runtime and probe phases run the agent's final
   edited state. (Deviation from the design's §1.3 wording "after a forced
   SaveDirtyScenes": under that ordering the `skip-save` mutant would be
   undetectable.)
4. **One fresh editor per task**, booted `--summer-no-publish` on a copy of the
   fixture with no `.godot/` cache, discovered through the same registry code
   `summer mcp --project` uses (`~/.summer/instances/*.json`, `resourceRoot`
   match, live pid, health check). A developer's own open editor is never
   touched, and the eval editor never steals the machine-global api-port.
5. **Replay goes through the toolkit, in-process.** Each golden record is
   re-issued with `dispatchTool()` from `src/core/capabilities/tool-dispatch.ts`
   — the same table `summer tool <slug>` uses and the same functions the MCP
   tools mirror — bound to the eval editor by project path. Not via
   `node dist/bin/summer.js tool …` as a subprocess: that command has no
   `--project` selector and resolves the engine through the machine-global
   `~/.summer/api-port` pointer, which the eval editor deliberately does not
   publish. Every replayed call is also recorded through the toolkit's own
   trajectory capture (`SUMMER_TRAJECTORY_DIR` + `SUMMER_TRAJECTORY_EVAL=1`),
   so a passing run's `trajectory.full.jsonl` is itself a replayable golden.
6. **Determinism by construction.** The probe child is pinned by the engine to
   `--fixed-fps 60` and `--summer-seed 20260725`; the fixtures, goldens and the
   engine's op list are content-hashed into `run.json`; `assertions.json`
   carries nothing that varies between identical runs.
7. **One retry on infrastructure failure, none on assertion failure** (design
   §3.5). A scored run whose gate fell to `evidence_missing` (a probe that
   never wrote `results.json`, an op transport error, a harness exception) is
   re-run once on a fresh editor; the first attempt's directory is kept beside
   it as `<id>.attempt1` and the board's `retried` column says so. A refusal is
   deterministic and is never retried; neither is a genuine assertion failure.
   Note on probe budgets: the verify child runs at `--fixed-fps 60`, so a
   probe's scene-time waits are rendered frames — under llvmpipe one scene
   second costs 3–4 wall seconds, and `RunVerification`'s grace is wall time.
   The runner sizes `max_seconds` accordingly (`20 + 6 × scene seconds`); the
   child exits the moment `finish()` runs, so the headroom is free on the
   success path.

## Layout

```
evals/outcomes/
  runner.ts                 npm run eval:outcomes — phases, board, baseline gate
  lib/engine.ts             boot (headless | xvfb | native), registry discovery, raw ops, teardown
  lib/assert.ts             the predicate table (below), evidence types, task verdict + severity
  lib/tscn.ts               .tscn / project.godot readers
  lib/probe.ts              generates the per-task RunVerification probe (extends SummerProbeBase)
  lib/preflight.ts          op needs + opKinds refusal
  lib/tasks.ts              task YAML loading + validation
  lib/trajectory.ts         golden JSONL loading, replay through dispatchTool, divergence
  tasks/<tier>/<id>.yaml    the task suite (prompt, fixture, budget, assertions, probe snippet, gold)
  golden/src/<id>.yaml      readable golden sources (multi-line GDScript) — edit these
  golden/src/mutants/<id>.<mutation>.yaml   deliberately broken goldens + expect_fail
  golden/<id>.golden.jsonl, golden/mutants/…   compiled replay input (node golden/compile.ts; --check in CI)
  fixtures/{empty3d,empty2d,grid,rigged}/    project.godot + scene; grid/rigged are engine output (fixtures/build-fixtures.ts)
  baseline.json, engine.lock                 the gate and the engine build it was produced on
  outcomes.test.ts          vitest: readers, predicates, probe builder, task validation, golden drift, refusal
```

### Fixtures

| Fixture | Contents |
|---|---|
| `empty3d` | `main.tscn` = one `Node3D` root |
| `empty2d` | `main.tscn` = one `Node2D` root; viewport 1152×648 |
| `grid` | the engine E2E's `main.tscn` after its A/C waves, regenerated by replaying those two scripts: 5×5 `Grid/Box_*` + 9 blue `GridBox_*` meshes, `CollidableSphere` with `StaticBody3D/CollisionShape3D`, `LightRig` (Key/Fill/Rim), `WorldEnvironment` + ProceduralSky, current `Camera3D` at (8,6,8) — 45 nodes |
| `rigged` | `rig.tscn`: script-built `Skeleton3D` "Rig" (root/arm/hand), a box mesh, an `AnimationPlayer` with `idle` and `walk` clips, a camera |

All four pin `audio/driver/driver="Dummy"` and
`rendering/renderer/rendering_method="gl_compatibility"` so the game child the
runtime phase launches does not log ALSA/Vulkan probing errors under Xvfb —
environment pins, not part of any task. No `.godot/` cache is committed.
`grid` and `rigged` are regenerated with
`SUMMER_EDITOR_BIN=… node evals/outcomes/fixtures/build-fixtures.ts`.

## The assertion vocabulary

Selectors: `Wall*|Floor*` matches node **names** (glob, `|` alternation);
`class:StaticBody2D` matches the class (snapshot) / `type` (tscn);
`path:Grid/*` matches the root-relative path; `*` is every node. Comparisons
take `op` ∈ `== != > >= < <= contains matches exists` and `value`.

| Predicate | Evidence | Args | Passes when |
|---|---|---|---|
| `count` | snap | `class, op, value` | `counts[class] op value` |
| `exists` | snap + tscn | `selector` | ≥1 match in the edited scene AND every match is in the saved file |
| `added_only` | diff | `added: [globs], removed_allowed?: [globs]` | every `added[]` path matches; every `removed[]` path is allowed |
| `aabb_within` | snap | `selector, min?, max?, size?: {x?,y?,z?: [lo,hi]}` | every matched world AABB inside the region / size windows |
| `no_overlap` | snap | `a, b, tol` | no AABB of `a` intersects one of `b` after shrinking both by `tol` |
| `on_ground` | snap | `selector, ground_y, eps` | every matched AABB base within `eps` of `ground_y` |
| `lights` | snap | `min, energy_range?` | ≥ `min` lights; energy sum inside the window |
| `camera_current` | snap | — | exactly one camera with `current:true` |
| `camera_sees` | probe | `selector, fraction, at_seconds?` | ≥ `fraction` of the matched nodes' AABB corners inside the running game's camera frustum |
| `collision_under` | snap | `selector` | each match has a `CollisionShape*`/`CollisionPolygon*` descendant whose parent is a `*Body2D/3D` or `Area*` |
| `script_attached` | snap + tscn | `selector` | live `script_fp` AND `script = ExtResource/SubResource(...)` in the saved file |
| `signal_connected` | tscn | `from, signal, to, method, min?` | a matching `[connection …]` line |
| `input_action` | project | `name, min_events` | `[input] name` has ≥ `min_events` bound events |
| `main_scene` | project | `path` | `application/run/main_scene` equals `path` |
| `runs_clean` | runtime | `seconds` | the game was running after `seconds` and the debugger reported zero errors |
| `runtime_prop` | runtime | — | **MVP-0 stub**: always `FAIL(evidence_missing)` |
| `state_machine` | probe | `selector, expected_state, after?: {press, hold_ms}` | the AnimationTree is active and its playback's current node is `expected_state` (read while the action is held, if given) |
| `probe_report` | probe | `key, op, value` | the task's own `report(key, …)` satisfies the comparison |
| `frame_not_blank` | probe | `name` | `save_frame(name)` produced no frame warning and >1 distinct colour |
| `preview_camera_ok` | preview | — | `ScenePreview framing:"camera"` ok, `used_scene_camera`, `environment_used == scene_world_environment`, >1 distinct colour |
| `no_truncation` | snap | — | `truncated:false`, no `lights_truncated` |
| `gold_iou` | snap + task `gold` | `min` | mean per-name AABB IoU against the task's gold list ≥ `min` |
| `tscn_prop` | tscn | `selector, key, op, value, quantifier?: all\|any` | the saved node property satisfies the comparison (missing key = undefined) — the design's inline `tscn:` checks |
| `tscn_resource` | tscn | `type, key?, op?, value?` | a `[sub_resource type=…]` exists (and, with `key`, has a property — key may be a glob like `tracks/*/type` — satisfying the comparison) |

Severity of the first failing REQUIRED predicate, in fixed order:
`evidence_missing` → `unsaved` → `structural` → `spatial` → `runtime` →
`visual_gate`. `required: false` predicates are reported, never gated.

## The MVP-0 suite (8 tasks, 6 mutants)

Prompts are verbatim from the design. Tier coverage: T1 blockout (3), T3
platformer, T4 HUD, T5 character animation, T6 terrain, T7 cutscene — every
evidence source and every predicate family exercised at least once.

| Task | Fixture | Required predicates | Mutant → fails exactly |
|---|---|---|---|
| T1.1-courtyard | empty3d | mesh count, camera current, light, walls/floor on ground, fountain clear of walls, camera sees walls+fountain (probe), all nodes saved, camera preview ok | `drop-light` → `light-present` |
| T1.3-edit-in-place | grid | added only a wall / removed only GridBox_*, 3 fixture lights intact, camera current, wall saved, camera sees wall (probe) | `skip-save` → `wall-saved` |
| T1.4-layout-from-spec | empty3d | gold IoU ≥ 0.9, sun present, cubes on ground | `misplace-cube` → `gold-layout` |
| T3.1-three-platforms | empty2d | one CharacterBody2D with collision, ≥4 StaticBody2D each with collision, 3 input actions, player script, clean 4 s play, probe jump `y_delta > 20` | `platform-no-collision` → `platforms-collision` |
| T4.1-health-bar | empty2d | CanvasLayer, ProgressBar, Label, label `anchor_right == 1.0`, clean play, HUD frame not blank | `label-unanchored` → `score-anchored-right` |
| T5.1-idle-walk | rigged | one AnimationTree, `Idle` at rest, `Walk` while `move_forward` held (probe), input action, clean play | `wrong-clip` → `walk-while-held` |
| T6.1-hills | empty3d | terrain exists + collision + HeightMapShape3D, shadowed sun, camera current, camera sees terrain, camera preview ok | — |
| T7.1-flyover | grid | AnimationPlayer, clip length ≥ 5.5, autoplay set, position_3d track on Camera3D, camera sees GridBox_* at t=6.2 s, clean 7 s play | — |

### Scoreboard on the baseline build (engine 0.5.65, toolkit 2.8.2, xvfb + llvmpipe, 4 vCPU)

```
| run                                         | kind   | verdict | failed required      | expected to fail     | exact | divergence | retried |    s |
| T1.1-courtyard                              | golden | PASS    | —                    | —                    | —     | 0          | —       | 10.5 |
| T1.1-courtyard.drop-light                   | mutant | FAIL    | light-present        | light-present        | yes   | 0          | —       |  9.8 |
| T1.3-edit-in-place                          | golden | PASS    | —                    | —                    | —     | 0          | —       |  9.1 |
| T1.3-edit-in-place.skip-save                | mutant | FAIL    | wall-saved           | wall-saved           | yes   | 0          | —       |  9.6 |
| T1.4-layout-from-spec                       | golden | PASS    | —                    | —                    | —     | 0          | —       |  9.1 |
| T1.4-layout-from-spec.misplace-cube         | mutant | FAIL    | gold-layout          | gold-layout          | yes   | 0          | —       |  9.1 |
| T3.1-three-platforms                        | golden | PASS    | —                    | —                    | —     | 0          | —       | 13.5 |
| T3.1-three-platforms.platform-no-collision  | mutant | FAIL    | platforms-collision  | platforms-collision  | yes   | 0          | —       | 13.4 |
| T4.1-health-bar                             | golden | PASS    | —                    | —                    | —     | 0          | —       | 11.4 |
| T4.1-health-bar.label-unanchored            | mutant | FAIL    | score-anchored-right | score-anchored-right | yes   | 0          | —       | 11.0 |
| T5.1-idle-walk                              | golden | PASS    | —                    | —                    | —     | 0          | —       | 14.0 |
| T5.1-idle-walk.wrong-clip                   | mutant | FAIL    | walk-while-held      | walk-while-held      | yes   | 0          | —       | 15.1 |
| T6.1-hills                                  | golden | PASS    | —                    | —                    | —     | 0          | —       | 11.5 |
| T7.1-flyover                                | golden | PASS    | —                    | —                    | —     | 0          | —       | 31.6 |

goldens 8/8 pass · mutants 6/6 fail exactly their intended predicate · refused 0 · wall clock 178.7 s
```

The `--update-baseline` run above and the `--check` run that followed it
(172.8 s, `PASS — no regression vs committed baseline`) produced byte-identical
`assertions.json` for all 14 runs, with no retry needed in either. T7.1 is the
slow one on purpose: its probe waits 6.2 scene seconds at a fixed 60 fps, about
370 llvmpipe frames (~15 s wall). `--simulate-missing-ops GetWorldSnapshot`
against the same build refuses T1.1 in 2.7 s with
`evidence_missing:engine_lacks_op — missing GetWorldSnapshot`, replays nothing
and exits 1.

## Adding a task

1. **Task file** `tasks/<tier>/<id>.yaml` (`id` = `T<n>.<m>-<slug>`, file
   named `<id>.yaml`): verbatim `prompt`, `fixture`, `scene`, `budget`,
   `skills_expected` (ids must exist in `registry/generated/index.json`),
   `capture` (recorded, not executed in MVP-0), `assertions` with unique
   kebab-case ids, at least one `required: true`. A probe-backed check that the
   built-ins cannot express goes in `probe_snippet` (GDScript inserted into the
   generated probe's `_ready`; use `report(key, value)` and assert it with
   `probe_report`). A reconstruction task carries `gold: [{name, aabb}]`.
2. **Golden** `golden/src/<id>.yaml`: `task`, `recorded_at`, `description`,
   `steps: [{tool, args}]` — multi-line GDScript reads naturally in YAML block
   scalars. Any `summer_*` tool in the dispatch table replays; tools outside it
   are counted as skipped. Then `node evals/outcomes/golden/compile.ts` and
   commit both files (`--check` runs per PR).
3. **Mutant** (strongly encouraged) `golden/src/mutants/<id>.<mutation>.yaml`:
   the golden with ONE deliberate break, `mutation` (kebab-case) and
   `expect_fail: [assertion-id]` — required ids only. The suite goes red if the
   mutant fails anything else too: an assertion that fails for the wrong reason
   is not discriminating.
4. `npm run eval:outcomes -- --dry-run`, then `--task <id>` against the engine,
   then a full `--update-baseline` run; commit `baseline.json` + `engine.lock`
   with the task in the same PR.

Never weaken an assertion to make a golden pass; if an expectation changes,
change it in the same commit as the engine/toolkit change that justifies it,
and say so in the baseline diff.

## Cadence

Per PR: `--dry-run` only (seconds, no engine). The engine-backed replay is
nightly/pre-release work against the pinned build in `engine.lock` — never per
PR (`evals/README.md`, end-to-end row). A `--check` failure is either an engine
behaviour change on a fixed script (usually the intended fix, sometimes the
regression) or an assertion that stopped discriminating; both are read from
`board.md` and the failing run's `assertions.json`.

## Not in MVP-0 (design §5, MVP-1 and Full)

Live drivers through the canary gateway, tool-call/wall-clock budget
enforcement (`budget` is recorded only), `ScenePreview` iso captures and the
VLM rubric, honesty metrics over the final message, the asset kit and the
T2/T8 tiers, `runtime_prop` via `GetRuntimeNode`, PlayGame `seed`/`fixed_fps`
(engine §6.2), 2D `rect` in the snapshot (engine §6.1). The engine E2E
relocation (acceptance criterion 6) is engine-repo work and is not part of this
change.
