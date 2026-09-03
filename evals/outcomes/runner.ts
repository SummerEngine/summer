#!/usr/bin/env node
/**
 * Outcome eval runner — MVP-0: replay mode, assertions only.
 *
 * WHAT THIS TESTS (be honest about it): whether a recorded agent trajectory,
 * re-issued through the toolkit's own tool table against a FRESH editor on a
 * pristine fixture, produces a scene/game that satisfies the task's outcome
 * assertions — counts, saved-ness, spatial facts, wiring, input map, a clean
 * play, probe reads from the running game, an honest camera render. It does
 * NOT test an LLM: the trajectories are goldens (known-good agents) and
 * mutants (deliberately broken goldens). A golden that stops passing means the
 * engine or the toolkit changed behaviour on a fixed script; a mutant that
 * stops failing its intended predicate means an assertion stopped
 * discriminating. Live mode (real hosts, budgets, judge) is MVP-1.
 *
 * Honesty rules enforced here:
 *   - pre-flight: a task whose replay or evidence needs an op the engine's
 *     /api/health capabilities.opKinds does not advertise is REFUSED with
 *     `evidence_missing:engine_lacks_op` — never scored as zeros;
 *   - a predicate that cannot be evaluated is FAIL(evidence_missing), never a
 *     skip (lib/assert.ts);
 *   - the .tscn/project.godot evidence is what the AGENT left on disk, read
 *     before the runner's own freeze save, so "did not save" is a failure;
 *   - one fresh editor per task; the fixture is copied, never mutated in place.
 *
 * Usage:
 *   npm run eval:outcomes                         all goldens + mutants, compare to baseline.json
 *   npm run eval:outcomes -- --check              same; also fails when baseline is missing/stale
 *   npm run eval:outcomes -- --update-baseline    write baseline.json (commit the diff, reviewed)
 *   npm run eval:outcomes -- --task T1.1-courtyard [--task …] [--no-mutants]
 *   npm run eval:outcomes -- --dry-run            validate tasks/goldens/fixtures; no engine
 *   npm run eval:outcomes -- --render xvfb|headless|native   (default: xvfb when available)
 *   npm run eval:outcomes -- --runs-dir <dir>     artifacts root (default evals/outcomes/runs/<stamp>)
 *   npm run eval:outcomes -- --simulate-missing-ops GetWorldSnapshot   refusal test hook
 *
 * Environment: SUMMER_EDITOR_BIN (or SUMMER_ENGINE_BINARY) names the editor.
 * Requires Node >= 22.18 (native type stripping) and `npm run build` (the
 * toolkit under test is imported from dist/, exactly like evals/canary).
 */

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateAll,
  diffFromResult,
  snapshotFromResult,
  taskVerdict,
  type AssertionResult,
  type Evidence,
  type PreviewEvidence,
  type ProbeEvidence,
  type RuntimeEvidence,
  type Severity,
} from "./lib/assert.ts";
import {
  bootEditor,
  createProjectDispatchContext,
  defaultRenderMode,
  findEditorBinary,
  runOp,
  type EditorHandle,
  type RenderMode,
} from "./lib/engine.ts";
import { buildProbe } from "./lib/probe.ts";
import { evidencePhases, preflight, taskOpNeeds } from "./lib/preflight.ts";
import { crossCheckTasks, loadTasks, type TaskSpec } from "./lib/tasks.ts";
import { parseProjectGodot, parseTscn } from "./lib/tscn.ts";
import { loadGolden, recordOpNeeds, replayTrajectory, type GoldenTrajectory, type ReplayOutcome } from "./lib/trajectory.ts";
import { checkGoldens } from "./golden/compile.ts";

// dist/ = the toolkit under test (built). Missing dist is a refusal, not a crash.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
if (!existsSync(join(repoRoot, "dist", "core", "capabilities", "tool-dispatch.js"))) {
  console.error("outcome-eval: dist/ is missing — run `npm run build` first (the toolkit under test is the built one).");
  process.exit(2);
}
const { TOOLKIT_VERSION } = await import("../../dist/core/version.js");

const tasksDir = join(here, "tasks");
const fixturesDir = join(here, "fixtures");
const goldenDir = join(here, "golden");
const baselinePath = join(here, "baseline.json");
const engineLockPath = join(here, "engine.lock");
const registryIndexPath = join(repoRoot, "registry", "generated", "index.json");

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

interface Options {
  mode: string;
  tasks: string[] | null;
  mutants: boolean;
  dryRun: boolean;
  check: boolean;
  updateBaseline: boolean;
  render?: string;
  runsDir: string;
  simulateMissingOps: string[];
  verbose: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    mode: "replay",
    tasks: null,
    mutants: true,
    dryRun: false,
    check: false,
    updateBaseline: false,
    runsDir: join(here, "runs", new Date().toISOString().replace(/[:.]/g, "-")),
    simulateMissingOps: (process.env.SUMMER_EVAL_SIMULATE_MISSING_OPS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case "--mode":
        opts.mode = next();
        break;
      case "--task":
        (opts.tasks ??= []).push(next());
        break;
      case "--no-mutants":
        opts.mutants = false;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--check":
        opts.check = true;
        break;
      case "--update-baseline":
        opts.updateBaseline = true;
        break;
      case "--render":
        opts.render = next();
        break;
      case "--runs-dir":
        opts.runsDir = next();
        break;
      case "--simulate-missing-ops":
        opts.simulateMissingOps = next().split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--verbose":
        opts.verbose = true;
        break;
      default:
        throw new Error(`unknown argument ${arg} (see the header of evals/outcomes/runner.ts)`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Static validation (the per-PR --dry-run; always runs before any engine boot)
// ---------------------------------------------------------------------------

interface Suite {
  tasks: TaskSpec[];
  goldens: Map<string, GoldenTrajectory>;
  mutants: Map<string, GoldenTrajectory[]>;
}

function validateSuite(): { suite: Suite; errors: string[] } {
  const errors: string[] = [];
  let tasks: TaskSpec[] = [];
  try {
    tasks = loadTasks(tasksDir);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  errors.push(...crossCheckTasks(tasks, fixturesDir, registryIndexPath));
  errors.push(...checkGoldens(goldenDir));
  const goldens = new Map<string, GoldenTrajectory>();
  const mutants = new Map<string, GoldenTrajectory[]>();
  for (const task of tasks) {
    const file = join(goldenDir, `${task.id}.golden.jsonl`);
    if (!existsSync(file)) {
      errors.push(`${task.id}: no golden trajectory at golden/${basename(file)}`);
      continue;
    }
    try {
      const golden = loadGolden(file);
      if (golden.header && golden.header.task !== task.id) errors.push(`${basename(file)}: header names task ${golden.header.task}`);
      if (golden.records.length === 0) errors.push(`${basename(file)}: no tool_call records`);
      goldens.set(task.id, golden);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const mutantDir = join(goldenDir, "mutants");
  if (existsSync(mutantDir)) {
    for (const name of readdirSync(mutantDir).sort()) {
      if (!name.endsWith(".golden.jsonl")) continue;
      try {
        const golden = loadGolden(join(mutantDir, name));
        const header = golden.header;
        if (!header?.mutation || !header.expect_fail?.length) {
          errors.push(`mutants/${name}: header must carry mutation + expect_fail`);
          continue;
        }
        const task = tasks.find((t) => t.id === header.task);
        if (!task) {
          errors.push(`mutants/${name}: unknown task ${header.task}`);
          continue;
        }
        for (const id of header.expect_fail) {
          const spec = task.assertions.find((a) => a.id === id);
          if (!spec) errors.push(`mutants/${name}: expect_fail names unknown assertion ${id}`);
          else if (!spec.required) errors.push(`mutants/${name}: expect_fail ${id} is not a required assertion — a mutant must break the gate`);
        }
        (mutants.get(task.id) ?? mutants.set(task.id, []).get(task.id)!).push(golden);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  return { suite: { tasks, goldens, mutants }, errors };
}

// ---------------------------------------------------------------------------
// Per-run helpers
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

function hashDirectory(dir: string): string {
  const hash = createHash("sha256");
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) {
        if (name === ".godot") continue;
        walk(p);
      } else {
        hash.update(relative(dir, p)).update("\0").update(readFileSync(p)).update("\0");
      }
    }
  };
  walk(dir);
  return hash.digest("hex");
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

/** Copy the agent-visible project files (scenes, scripts, resources,
 *  project.godot) — never the .godot/ cache. */
function copyProjectFiles(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const rel = relative(from, p);
      if (statSync(p).isDirectory()) {
        if (name === ".godot" || name === ".summer") continue;
        walk(p);
      } else if (/\.(tscn|tres|gd|godot|cfg|import)$/.test(name) || name === "project.godot") {
        mkdirSync(dirname(join(to, rel)), { recursive: true });
        cpSync(p, join(to, rel));
      }
    }
  };
  walk(from);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PREVIEW_ANALYSIS = (path: string) => `func run(_ctx):
\tvar bytes = FileAccess.get_file_as_bytes(${JSON.stringify(path)})
\tvar img = Image.new()
\tvar err = img.load_jpg_from_buffer(bytes)
\tif err != OK:
\t\treturn {"ok": false, "err": err}
\tvar colors = {}
\tvar step = max(1, min(img.get_width(), img.get_height()) / 48)
\tfor y in range(0, img.get_height(), step):
\t\tfor x in range(0, img.get_width(), step):
\t\t\tcolors[img.get_pixel(x, y).to_html(false)] = true
\treturn {"ok": true, "distinct_colors": colors.size(), "width": img.get_width(), "height": img.get_height()}
`;

// ---------------------------------------------------------------------------
// One run = one task (golden or mutant) on one fresh editor
// ---------------------------------------------------------------------------

interface RunResult {
  id: string;
  task: string;
  mutation: string | null;
  expect_fail: string[] | null;
  status: "scored" | "refused" | "error";
  pass: boolean;
  severity: Severity | null;
  failed_required: string[];
  /** Mutants: failed_required equals expect_fail exactly. */
  exact: boolean | null;
  divergence: number;
  skipped_records: number;
  wall_clock_s: number;
  dir: string;
  /** True when this result is the second attempt after an evidence_missing first run. */
  retried?: boolean;
  refusal?: { reason: string; missing_ops: string[] };
  error?: string;
}

async function runOne(
  task: TaskSpec,
  golden: GoldenTrajectory,
  options: { binary: string; render: RenderMode; runsDir: string; simulateMissingOps: string[]; verbose: boolean }
): Promise<RunResult> {
  const mutation = golden.header?.mutation ?? null;
  const id = mutation ? `${task.id}.${mutation}` : task.id;
  const dir = join(options.runsDir, id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const project = join(dir, "project");
  const startedAt = Date.now();
  const timings: Record<string, number> = {};
  const phase = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t = Date.now();
    try {
      return await fn();
    } finally {
      timings[name] = Date.now() - t;
    }
  };
  const log = (message: string) => console.log(`  [${id}] ${message}`);

  // prepare
  const fixtureDir = join(fixturesDir, task.fixture);
  cpSync(fixtureDir, project, { recursive: true });
  rmSync(join(project, ".godot"), { recursive: true, force: true });
  const run: JsonRecord = {
    task: task.id,
    mutation,
    mode: "replay",
    toolkit_version: TOOLKIT_VERSION,
    render: options.render,
    fixture: task.fixture,
    fixture_sha256: hashDirectory(fixtureDir),
    golden: relative(here, golden.file).split("\\").join("/"),
    golden_sha256: golden.sha256,
    prompt: task.prompt,
    budget: task.budget,
    skills_expected: task.skills_expected,
  };

  let editor: EditorHandle | null = null;
  let results: AssertionResult[] = [];
  let replay: ReplayOutcome | null = null;
  let status: RunResult["status"] = "scored";
  let refusal: RunResult["refusal"];
  let errorMessage: string | undefined;
  try {
    editor = await phase("boot", () =>
      bootEditor({ binary: options.binary, projectDir: project, render: options.render, logPath: join(dir, "editor.log") })
    );
    const health = editor.health;
    const needs = taskOpNeeds(task, golden);
    const pre = preflight(health, needs, options.simulateMissingOps);
    run.engine = { version: health.version ?? null, pid: editor.enginePid, opkinds_sha256: pre.opkinds_sha256, advertises_opkinds: pre.advertised };
    run.preflight = { ...pre, needed_by: Object.fromEntries([...needs.entries()].sort()) };
    if (pre.missing.length > 0) {
      status = "refused";
      refusal = { reason: "evidence_missing:engine_lacks_op", missing_ops: pre.missing };
      results = task.assertions.map((a) => ({
        id: a.id,
        predicate: a.predicate,
        required: a.required,
        pass: false,
        severity: "evidence_missing",
        reason: "evidence_missing",
        detail: { engine_lacks_op: pre.missing, needed_by: Object.fromEntries(pre.missing.map((op) => [op, needs.get(op)])) },
      }));
      log(`REFUSED — engine ${String(health.version)} does not advertise ${pre.missing.join(", ")} (nothing was replayed)`);
    } else {
      const client = editor.client;
      // The task's scene must be the edited scene; the fixture editor boots on
      // nothing (the E2E driver's first op is the same OpenScene).
      const opened = await phase("open", () => runOp(client, { op: "OpenScene", path: task.scene }));
      if (!opened.ok) throw new Error(`OpenScene ${task.scene} failed: ${opened.error ?? JSON.stringify(opened.result)}`);

      // baseline snapshot
      const before = await phase("baseline", () => runOp(client, { op: "GetWorldSnapshot", include_2d: true }));
      writeJson(join(dir, "snapshot.before.json"), before.result);
      const beforeId = typeof before.result.snapshot_id === "string" ? before.result.snapshot_id : null;

      // agent phase: replay through the toolkit's tool table, recording the
      // run's own trajectory.jsonl + trajectory.full.jsonl (eval mode).
      const savedEnv = { dir: process.env.SUMMER_TRAJECTORY_DIR, eval: process.env.SUMMER_TRAJECTORY_EVAL };
      process.env.SUMMER_TRAJECTORY_DIR = dir;
      process.env.SUMMER_TRAJECTORY_EVAL = "1";
      try {
        replay = await phase("agent", () => replayTrajectory(golden, createProjectDispatchContext(project), { record: true }));
      } finally {
        if (savedEnv.dir === undefined) delete process.env.SUMMER_TRAJECTORY_DIR;
        else process.env.SUMMER_TRAJECTORY_DIR = savedEnv.dir;
        if (savedEnv.eval === undefined) delete process.env.SUMMER_TRAJECTORY_EVAL;
        else process.env.SUMMER_TRAJECTORY_EVAL = savedEnv.eval;
      }
      writeJson(join(dir, "replay.json"), { steps: replay.steps, divergence: replay.divergence, skipped: replay.skipped });
      for (const step of replay.steps) {
        if (!step.ok && !step.skipped) log(`replay step ${step.index} ${step.tool}: ok=false ${step.failure_reason ?? ""} ${(step.error ?? "").slice(0, 200)}`);
      }

      // collect (edited-scene evidence + what the agent left on disk)
      const evidence: Evidence = { snap: null, diff: null, tscn: null, project: null, runtime: null, probe: null, preview: null, gold: task.gold };
      await phase("collect", async () => {
        const after = await runOp(client, { op: "GetWorldSnapshot", include_2d: true });
        writeJson(join(dir, "snapshot.after.json"), after.result);
        if (after.ok) evidence.snap = snapshotFromResult(after.result);
        else evidence.snap_error = after.error ?? after.failure_reason ?? "GetWorldSnapshot failed";
        if (beforeId) {
          const diff = await runOp(client, { op: "DiffWorldSnapshot", from_id: beforeId });
          writeJson(join(dir, "diff.json"), diff.result);
          if (diff.ok) evidence.diff = diffFromResult(diff.result);
          else evidence.diff_error = diff.error ?? diff.failure_reason ?? "DiffWorldSnapshot failed";
        } else {
          evidence.diff_error = "baseline snapshot had no snapshot_id";
        }
        const agentCopy = join(dir, "project.agent");
        copyProjectFiles(project, agentCopy);
        const sceneFile = join(agentCopy, task.scene.replace("res://", ""));
        if (existsSync(sceneFile)) {
          try {
            evidence.tscn = parseTscn(readFileSync(sceneFile, "utf8"));
          } catch (error) {
            evidence.tscn_error = `parse error: ${error instanceof Error ? error.message : String(error)}`;
          }
        } else {
          evidence.tscn_error = `${task.scene} is not on disk`;
        }
        const projectFile = join(agentCopy, "project.godot");
        if (existsSync(projectFile)) evidence.project = parseProjectGodot(readFileSync(projectFile, "utf8"));
        else evidence.project_error = "project.godot is not on disk";
      });

      // freeze: stop anything running, persist the agent's final edited state
      // so the runtime/probe phases run exactly what the agent built.
      const phases = evidencePhases(task);
      await phase("freeze", async () => {
        const running = await runOp(client, { op: "IsGameRunning" });
        if (running.result.playing === true) await runOp(client, { op: "StopGame" });
        const save = await runOp(client, { op: "SaveScene" });
        const dirty = await runOp(client, { op: "SaveDirtyScenes" });
        const scripts = await runOp(client, { op: "SaveDirtyScripts" });
        run.freeze = { save_scene: save.ok, save_dirty_scenes: dirty.ok, save_dirty_scripts: scripts.ok };
      });

      // preview (edit-time render through the scene camera)
      if (phases.has("preview")) {
        await phase("preview", async () => {
          const pv = await runOp(client, { op: "ScenePreview", framing: "camera", size: [1024, 768] });
          const { image_base64, ...meta } = pv.result as JsonRecord & { image_base64?: unknown };
          const jpgPath = join(dir, "preview.camera.jpg");
          let bytes = 0;
          if (typeof image_base64 === "string") {
            const buffer = Buffer.from(image_base64, "base64");
            bytes = buffer.byteLength;
            writeFileSync(jpgPath, buffer);
          }
          let distinct: number | null = null;
          if (bytes > 0) {
            const analysis = await runOp(client, { op: "RunSceneScript", script_source: PREVIEW_ANALYSIS(jpgPath), max_seconds: 20, checkpoint: false, undo: "none" }, 60_000);
            const returned = analysis.result.result as JsonRecord | undefined;
            if (analysis.ok && returned && typeof returned.distinct_colors === "number") distinct = returned.distinct_colors;
            else evidence.preview_error = `image analysis failed: ${analysis.error ?? JSON.stringify(analysis.result).slice(0, 300)}`;
          }
          const preview: PreviewEvidence = {
            ok: pv.ok,
            failure_reason: pv.failure_reason ?? (typeof meta.failure_reason === "string" ? meta.failure_reason : undefined),
            used_scene_camera: meta.used_scene_camera === true ? true : meta.used_scene_camera === false ? false : undefined,
            used_synthetic_camera: meta.used_synthetic_camera === true ? true : meta.used_synthetic_camera === false ? false : undefined,
            environment_used: typeof meta.environment_used === "string" ? meta.environment_used : undefined,
            camera_path: typeof meta.camera_path === "string" ? meta.camera_path : undefined,
            distinct_colors: distinct,
            bytes,
          };
          writeJson(join(dir, "preview.camera.json"), { ...meta, bytes, distinct_colors: distinct, ok: pv.ok, error: pv.error });
          evidence.preview = preview;
        });
      }

      // runtime: PlayGame -> wait -> IsGameRunning -> GetDebuggerErrors -> StopGame
      if (phases.has("runtime")) {
        const seconds = Math.max(
          1,
          ...task.assertions.filter((a) => a.predicate === "runs_clean").map((a) => (typeof a.args.seconds === "number" ? a.args.seconds : 3))
        );
        await phase("runtime", async () => {
          const play = await runOp(client, { op: "PlayGame", agent: true, max_run_seconds: seconds + 20, scene: task.scene });
          const rt: RuntimeEvidence = {
            played: play.ok && play.result.playing === true,
            play_failure: play.ok ? undefined : play.error ?? play.failure_reason,
            running_during_window: null,
            errors: [],
            error_count: null,
            stopped: false,
            seconds,
          };
          if (rt.played) {
            await sleep(seconds * 1000);
            const running = await runOp(client, { op: "IsGameRunning" });
            rt.running_during_window = running.result.playing === true;
            const errors = await runOp(client, { op: "GetDebuggerErrors", max_errors: 50 });
            if (errors.ok) {
              const list = Array.isArray(errors.result.errors) ? (errors.result.errors as unknown[]) : [];
              const summary = (errors.result.summary ?? {}) as JsonRecord;
              rt.errors = list;
              rt.error_count = typeof summary.errors === "number" ? summary.errors : list.length;
            }
            const stop = await runOp(client, { op: "StopGame" });
            rt.stopped = stop.ok;
            await sleep(500);
          }
          writeJson(join(dir, "runtime.json"), { play: play.result, ...rt });
          evidence.runtime = rt;
        });
      }

      // probe: one RunVerification child per task
      if (phases.has("probe")) {
        await phase("probe", async () => {
          const built = buildProbe(task.assertions, task.probe_snippet);
          const verifyDir = join(dir, "verify");
          mkdirSync(verifyDir, { recursive: true });
          writeFileSync(join(verifyDir, "probe.gd"), built.source);
          // The child is pinned to --fixed-fps 60, so every scene second the
          // probe waits is 60 RENDERED frames; under llvmpipe a frame of the
          // grid fixture costs 50-70 ms wall, i.e. one scene second is 3-4 wall
          // seconds. RunVerification's grace (max_seconds + 5) is wall time,
          // so size it for slow frames: the child quits the moment finish()
          // runs, so a generous budget costs nothing on the success path.
          const maxSeconds = Math.min(240, 20 + built.budget_seconds * 6);
          const ver = await runOp(client, { op: "RunVerification", probe_source: built.source, max_seconds: maxSeconds }, (maxSeconds + 40) * 1000);
          const res = (ver.result.results ?? {}) as JsonRecord;
          const probe: ProbeEvidence = {
            ok: ver.ok && res.finished !== false,
            failure_reason: ver.failure_reason ?? (res.finished === false ? "probe_unfinished" : undefined),
            error: ver.error,
            reports: (res.reports as Record<string, unknown>) ?? {},
            frames: Array.isArray(res.frames) ? (res.frames as string[]) : [],
            frame_warnings: Array.isArray(res.frame_warnings) ? (res.frame_warnings as string[]) : [],
            errors_seen: Array.isArray(res.errors_seen) ? (res.errors_seen as string[]) : [],
            finished: res.finished === true,
          };
          writeJson(join(verifyDir, "results.json"), ver.result);
          if (typeof ver.result.out_dir === "string" && existsSync(ver.result.out_dir)) {
            for (const name of readdirSync(ver.result.out_dir)) {
              if (name.endsWith(".jpg") || name === "errors.log") cpSync(join(ver.result.out_dir, name), join(verifyDir, name));
            }
          }
          evidence.probe = probe;
        });
      }

      results = evaluateAll(task.assertions, evidence);
      writeJson(join(dir, "evidence.summary.json"), {
        snap: evidence.snap ? { total_nodes: evidence.snap.total_nodes, counts: evidence.snap.counts, lights: evidence.snap.lights.length, cameras: evidence.snap.cameras } : evidence.snap_error,
        diff: evidence.diff ? { added: evidence.diff.added, removed: evidence.diff.removed, changed: evidence.diff.changed.length } : evidence.diff_error,
        tscn: evidence.tscn ? { nodes: evidence.tscn.nodes.length, sub_resources: evidence.tscn.subResources.length, connections: evidence.tscn.connections.length } : evidence.tscn_error,
        project: evidence.project ? Object.keys(evidence.project.sections) : evidence.project_error,
        runtime: evidence.runtime,
        probe: evidence.probe ? { ok: evidence.probe.ok, reports: evidence.probe.reports, frames: evidence.probe.frames, frame_warnings: evidence.probe.frame_warnings } : evidence.probe_error,
        preview: evidence.preview,
      });
    }
  } catch (error) {
    status = "error";
    errorMessage = error instanceof Error ? error.message : String(error);
    log(`ERROR ${errorMessage}`);
    if (results.length === 0) {
      results = task.assertions.map((a) => ({
        id: a.id,
        predicate: a.predicate,
        required: a.required,
        pass: false,
        severity: "evidence_missing",
        reason: "evidence_missing",
        detail: { harness_error: errorMessage },
      }));
    }
  } finally {
    if (editor) await phase("teardown", () => editor!.stop());
  }

  const verdict = taskVerdict(results);
  const expectFail = golden.header?.expect_fail ?? null;
  const exact =
    expectFail === null ? null : status === "scored" && JSON.stringify([...verdict.failed_required].sort()) === JSON.stringify([...expectFail].sort());
  // assertions.json carries no timings, pids or absolute paths: two runs on the
  // same build must produce byte-identical files (acceptance criterion 3).
  writeJson(join(dir, "assertions.json"), {
    task: task.id,
    mutation,
    status,
    ...(refusal ? { refusal } : {}),
    assertions: results.map((r) => ({ ...r, detail: r.detail === undefined ? undefined : stripVolatile(r.detail) })),
    verdict: { pass: verdict.pass, severity: verdict.severity, failed_required: verdict.failed_required },
    ...(expectFail ? { expect_fail: expectFail, exact } : {}),
  });
  const wall = (Date.now() - startedAt) / 1000;
  run.status = status;
  run.timings_ms = timings;
  run.wall_clock_s = Math.round(wall * 10) / 10;
  run.divergence = replay?.divergence ?? [];
  run.skipped_records = replay?.skipped ?? 0;
  if (errorMessage) run.error = errorMessage;
  writeJson(join(dir, "run.json"), run);

  const failed = verdict.failed_required;
  log(
    `${status === "refused" ? "REFUSED" : verdict.pass ? "PASS" : "FAIL"}${failed.length ? ` [${failed.join(", ")}]` : ""}${
      verdict.severity ? ` severity=${verdict.severity}` : ""
    }${replay && replay.divergence.length ? ` divergence=${replay.divergence.length}` : ""} ${wall.toFixed(1)}s`
  );
  return {
    id,
    task: task.id,
    mutation,
    expect_fail: expectFail,
    status,
    pass: verdict.pass,
    severity: verdict.severity,
    failed_required: failed,
    exact,
    divergence: replay?.divergence.length ?? 0,
    skipped_records: replay?.skipped ?? 0,
    wall_clock_s: Math.round(wall * 10) / 10,
    dir,
    ...(refusal ? { refusal } : {}),
    ...(errorMessage ? { error: errorMessage } : {}),
  };
}

/** Drop fields that legitimately vary run to run (image byte counts) from an
 *  assertion detail so assertions.json stays byte-stable. */
function stripVolatile(detail: unknown): unknown {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return detail;
  const { bytes: _bytes, ...rest } = detail as JsonRecord;
  return rest;
}

// ---------------------------------------------------------------------------
// Baseline + board
// ---------------------------------------------------------------------------

interface Baseline {
  generated_at: string;
  engine_version: string | null;
  opkinds_sha256: string | null;
  toolkit_version: string;
  render: string;
  task_count: number;
  mutant_count: number;
  tasks: Record<string, { pass: boolean; severity: Severity | null; failed_required: string[] }>;
  mutants: Record<string, { expect_fail: string[]; failed_required: string[]; exact: boolean }>;
}

function buildBaseline(runs: RunResult[], engineVersion: string | null, opkinds: string | null, render: string): Baseline {
  const tasks: Baseline["tasks"] = {};
  const mutants: Baseline["mutants"] = {};
  for (const r of runs) {
    if (r.mutation) mutants[r.id] = { expect_fail: r.expect_fail ?? [], failed_required: r.failed_required, exact: r.exact === true };
    else tasks[r.id] = { pass: r.pass, severity: r.severity, failed_required: r.failed_required };
  }
  return {
    generated_at: new Date().toISOString().slice(0, 10),
    engine_version: engineVersion,
    opkinds_sha256: opkinds,
    toolkit_version: TOOLKIT_VERSION,
    render,
    task_count: Object.keys(tasks).length,
    mutant_count: Object.keys(mutants).length,
    tasks,
    mutants,
  };
}

function compareBaseline(baseline: Baseline, current: Baseline): { failures: string[]; warnings: string[] } {
  const failures: string[] = [];
  const warnings: string[] = [];
  if (baseline.task_count !== current.task_count) failures.push(`stale baseline: task_count ${baseline.task_count} -> ${current.task_count} (tasks/ changed; re-run --update-baseline and commit)`);
  if (baseline.mutant_count !== current.mutant_count) failures.push(`stale baseline: mutant_count ${baseline.mutant_count} -> ${current.mutant_count} (golden/mutants changed; re-run --update-baseline and commit)`);
  if (baseline.engine_version !== current.engine_version) warnings.push(`engine version ${baseline.engine_version} (baseline) -> ${current.engine_version} (this run); engine.lock names the baseline build`);
  if (baseline.render !== current.render) warnings.push(`render mode ${baseline.render} (baseline) -> ${current.render}`);
  for (const [id, prev] of Object.entries(baseline.tasks)) {
    const now = current.tasks[id];
    if (!now) {
      failures.push(`task ${id} is in the baseline but was not run`);
      continue;
    }
    if (prev.pass && !now.pass) failures.push(`golden regressed: ${id} now fails [${now.failed_required.join(", ")}] (severity ${now.severity})`);
  }
  for (const [id, prev] of Object.entries(baseline.mutants)) {
    const now = current.mutants[id];
    if (!now) {
      failures.push(`mutant ${id} is in the baseline but was not run`);
      continue;
    }
    if (prev.exact && !now.exact) failures.push(`mutant ${id} no longer fails exactly [${prev.expect_fail.join(", ")}]: now fails [${now.failed_required.join(", ")}]`);
  }
  return { failures, warnings };
}

function renderBoard(runs: RunResult[], meta: { engine_version: string | null; render: string; wall_clock_s: number; runsDir: string }): string {
  const lines: string[] = [];
  lines.push(`# Outcome eval board — replay, assertions only`);
  lines.push("");
  lines.push(`engine ${meta.engine_version ?? "unknown"} · toolkit ${TOOLKIT_VERSION} · render ${meta.render} · wall clock ${meta.wall_clock_s.toFixed(1)} s · artifacts \`${meta.runsDir}\``);
  lines.push("");
  lines.push("| run | kind | verdict | failed required | severity | expected to fail | exact | divergence | retried | s |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const r of runs) {
    const verdict = r.status === "refused" ? "REFUSED" : r.status === "error" ? "ERROR" : r.pass ? "PASS" : "FAIL";
    lines.push(
      `| ${r.id} | ${r.mutation ? "mutant" : "golden"} | ${verdict} | ${r.failed_required.join(", ") || "—"} | ${r.severity ?? "—"} | ${r.expect_fail?.join(", ") ?? "—"} | ${
        r.exact === null ? "—" : r.exact ? "yes" : "NO"
      } | ${r.divergence} | ${r.retried ? "yes" : "—"} | ${r.wall_clock_s} |`
    );
  }
  const goldens = runs.filter((r) => !r.mutation);
  const mutants = runs.filter((r) => r.mutation);
  lines.push("");
  lines.push(`goldens: ${goldens.filter((r) => r.pass && r.status === "scored").length}/${goldens.length} pass · mutants: ${mutants.filter((r) => r.exact).length}/${mutants.length} fail exactly their intended predicate · refused: ${runs.filter((r) => r.status === "refused").length}`);
  for (const r of runs.filter((x) => x.status === "refused")) lines.push(`- ${r.id}: ${r.refusal?.reason} — missing ${r.refusal?.missing_ops.join(", ")}`);
  for (const r of runs.filter((x) => x.error)) lines.push(`- ${r.id}: harness error — ${r.error}`);
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode !== "replay") {
    console.error(`outcome-eval: --mode ${options.mode} is not implemented in MVP-0 (replay only; live drivers land in MVP-1).`);
    return 1;
  }

  const { suite, errors } = validateSuite();
  if (errors.length > 0) {
    console.error("outcome-eval: suite validation failed:\n  " + errors.join("\n  "));
    return 1;
  }
  console.log(`outcome-eval  tasks: ${suite.tasks.length}  goldens: ${suite.goldens.size}  mutants: ${[...suite.mutants.values()].reduce((s, m) => s + m.length, 0)}`);
  if (options.dryRun) {
    for (const t of suite.tasks) {
      const phases = [...evidencePhases(t)].sort().join(",");
      console.log(`  ${t.id}: ${t.assertions.filter((a) => a.required).length} required + ${t.assertions.filter((a) => !a.required).length} bonus assertions; evidence: ${phases}; mutants: ${suite.mutants.get(t.id)?.length ?? 0}`);
    }
    console.log("dry run OK (tasks, goldens, fixtures and skills_expected validated; no engine booted)");
    return 0;
  }

  const binary = findEditorBinary();
  if (!binary) {
    console.error("outcome-eval: no editor binary — set SUMMER_EDITOR_BIN (or SUMMER_ENGINE_BINARY) to the Summer Engine editor.");
    return 2;
  }
  const render = defaultRenderMode(options.render);
  const selected = options.tasks ? suite.tasks.filter((t) => options.tasks!.includes(t.id)) : suite.tasks;
  if (options.tasks) {
    const unknown = options.tasks.filter((id) => !suite.tasks.some((t) => t.id === id));
    if (unknown.length > 0) {
      console.error(`outcome-eval: unknown task id(s): ${unknown.join(", ")}`);
      return 1;
    }
  }
  mkdirSync(options.runsDir, { recursive: true });
  console.log(`editor: ${binary}\nrender: ${render}\nruns:   ${options.runsDir}`);

  const startedAt = Date.now();
  const runs: RunResult[] = [];
  let engineVersion: string | null = null;
  let opkinds: string | null = null;
  for (const task of selected) {
    const golden = suite.goldens.get(task.id)!;
    const queue: GoldenTrajectory[] = [golden, ...(options.mutants ? suite.mutants.get(task.id) ?? [] : [])];
    for (const trajectory of queue) {
      let result = await runOne(task, trajectory, { binary, render, runsDir: options.runsDir, simulateMissingOps: options.simulateMissingOps, verbose: options.verbose });
      // Design §3.5: one retry per task on an INFRASTRUCTURE failure (a
      // scored run whose gate fell to evidence_missing — probe timeout, op
      // error, harness exception), never on an assertion failure and never on
      // a refusal (which is deterministic). The first attempt's directory is
      // kept beside the retry as <id>.attempt1 so the flake stays visible.
      if (result.status !== "refused" && result.severity === "evidence_missing") {
        const firstDir = `${result.dir}.attempt1`;
        rmSync(firstDir, { recursive: true, force: true });
        cpSync(result.dir, firstDir, { recursive: true });
        console.log(`  [${result.id}] evidence_missing on first attempt — retrying once (first attempt kept at ${basename(firstDir)})`);
        result = await runOne(task, trajectory, { binary, render, runsDir: options.runsDir, simulateMissingOps: options.simulateMissingOps, verbose: options.verbose });
        result.retried = true;
      }
      runs.push(result);
      try {
        const runJson = JSON.parse(readFileSync(join(result.dir, "run.json"), "utf8")) as { engine?: { version?: string | null; opkinds_sha256?: string | null } };
        engineVersion ??= runJson.engine?.version ?? null;
        opkinds ??= runJson.engine?.opkinds_sha256 ?? null;
      } catch {
        // run.json is best-effort metadata
      }
    }
  }
  const wall = (Date.now() - startedAt) / 1000;

  const board = renderBoard(runs, { engine_version: engineVersion, render, wall_clock_s: wall, runsDir: options.runsDir });
  writeFileSync(join(options.runsDir, "board.md"), board);
  const current = buildBaseline(runs, engineVersion, opkinds, render);
  writeJson(join(options.runsDir, "summary.json"), { ...current, runs });
  console.log("\n" + board);

  const goldensFailed = runs.filter((r) => !r.mutation && !(r.pass && r.status === "scored"));
  const mutantsInexact = runs.filter((r) => r.mutation && r.exact !== true);
  let exit = goldensFailed.length + mutantsInexact.length > 0 ? 1 : 0;

  if (options.updateBaseline) {
    if (options.tasks || !options.mutants) {
      console.error("outcome-eval: --update-baseline needs the full suite (no --task / --no-mutants) so the baseline describes every task.");
      return 1;
    }
    writeJson(baselinePath, current);
    writeFileSync(engineLockPath, `${engineVersion ?? "unknown"}\n`);
    console.log(`baseline written: ${relative(repoRoot, baselinePath)} (engine ${engineVersion ?? "unknown"} pinned in ${relative(repoRoot, engineLockPath)})`);
    return exit;
  }

  if (!existsSync(baselinePath)) {
    if (options.check) {
      console.error("\nFAIL: no committed baseline (run with --update-baseline and commit it)");
      return 1;
    }
    console.log("\nno baseline yet — run with --update-baseline to create one");
    return exit;
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline;
  const subset = options.tasks !== null || !options.mutants;
  const { failures, warnings } = subset
    ? { failures: [], warnings: ["partial run (--task / --no-mutants): baseline comparison skipped"] }
    : compareBaseline(baseline, current);
  for (const w of warnings) console.warn(`warning: ${w}`);
  if (failures.length > 0) {
    console.error("\nFAIL — regression vs committed baseline:");
    for (const f of failures) console.error(`  - ${f}`);
    console.error("\nIf the change is intentional (engine fix, new task, new mutant), re-run with --update-baseline and commit the diff with the explanation.");
    exit = 1;
  } else if (!subset) {
    console.log(exit === 0 ? "\nPASS — no regression vs committed baseline" : "\nFAIL — see the board above");
  }
  return exit;
}

process.exit(await main());
