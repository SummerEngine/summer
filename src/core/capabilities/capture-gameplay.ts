import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { findEngineBinary } from "../engine-install.js";
import { runEngine, type EngineRun } from "./engine-run.js";
import { resolveExportProject } from "./export-game.js";
import { BuildToolError } from "./summer-bundle.js";

/**
 * summer_capture_gameplay: real gameplay frames without a running editor.
 *
 * Reuses the engine's offscreen verify instance (the one RunVerification and
 * tests/autopilot spawn): a real renderer in a window parked offscreen with no
 * focus, so it never shows on screen, unlike --headless, which has no pixels.
 *
 *   <engine> --disable-crash-handler --summer-no-api --path <project> --resolution WxH
 *            [--scene res://...] --summer-verify <probe.gd>
 *            --summer-verify-out <dir> --summer-verify-max <s>
 *
 * The stock probe waits for the scene to draw and settle, saves PNG frames of
 * the game viewport, and writes results.json. The frames are what the game
 * really draws, HUD included: use them as store screenshots.
 */

export interface CaptureGameplayInput {
  /** Project root (has project.godot). Defaults to the MCP's --project, then the working directory. */
  project?: string;
  /** Scene to start (res:// or uid://). Default: the project's main scene. */
  scene?: string;
  /** Window size, WIDTHxHEIGHT. Default 1920x1080; 1080x1920 for portrait. */
  resolution?: string;
  /** Frames to save. Default 1. */
  frames?: number;
  /** Seconds to let the game run before the first frame. Default 3. */
  waitSeconds?: number;
  /** Seconds between frames. Default 1. */
  intervalSeconds?: number;
  /** Output folder. Default <project>/.summer/captures/<time>/. */
  out?: string;
}

export interface CapturedFrame {
  path: string;
  width: number;
  height: number;
}

export interface CaptureGameplayResult {
  ok: true;
  project: string;
  scene: string;
  resolution: string;
  frames: CapturedFrame[];
  out: string;
  engine: string;
  imported: boolean;
  durationMs: number;
  warnings?: string[];
  next: string;
}

export interface CaptureGameplayDependencies {
  findBinary: () => string | null;
  run: (binary: string, args: string[], timeoutMs: number) => Promise<EngineRun>;
  now: () => Date;
}

const defaultDependencies: CaptureGameplayDependencies = {
  findBinary: () => findEngineBinary(platform()),
  run: runEngine,
  now: () => new Date(),
};

const DEFAULT_RESOLUTION = "1920x1080";
const MAX_FRAMES = 10;
/** The engine clamps --summer-verify-max to 240 (main.cpp SUMMER_VERIFY_MAX_SECONDS). */
const ENGINE_MAX_SECONDS = 240;
const IMPORT_TIMEOUT_MS = 5 * 60_000;
const PROBE_FILE = "capture_probe.gd";

function invalid(message: string, recovery: string): BuildToolError {
  return new BuildToolError("capture_args_invalid", message, recovery);
}

function parseResolution(value: string | undefined): { width: number; height: number; text: string } {
  const text = value?.trim() || DEFAULT_RESOLUTION;
  const match = /^(\d{2,5})x(\d{2,5})$/i.exec(text);
  if (!match) throw invalid(`resolution "${text}" is not WIDTHxHEIGHT.`, 'Recovery: pass e.g. "1920x1080" (landscape) or "1080x1920" (portrait).');
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 64 || height < 64 || width > 7680 || height > 7680) {
    throw invalid(`resolution ${text} is out of range.`, "Recovery: use 64 to 7680 pixels per side.");
  }
  return { width, height, text: `${width}x${height}` };
}

function boundedNumber(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < min || value > max) {
    throw invalid(`${name} must be between ${min} and ${max}.`, `Recovery: pass ${name} in that range, or omit it.`);
  }
  return value;
}

function checkScene(project: string, scene: string | undefined): string | undefined {
  const value = scene?.trim();
  if (!value) return undefined;
  if (value.startsWith("uid://")) return value;
  if (!value.startsWith("res://") || !/\.(tscn|scn)$/i.test(value)) {
    throw invalid(`scene "${value}" is not a res:// scene path.`, 'Recovery: pass a scene like "res://main.tscn", or omit scene to start the main scene.');
  }
  if (!existsSync(join(project, value.slice("res://".length)))) {
    throw invalid(`${value} does not exist in ${project}.`, "Recovery: pass a scene file that exists, or omit scene to start the main scene.");
  }
  return value;
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
}

/** <project>/.summer/captures/, ignored by the editor and by git (like .summer/exports). */
async function capturesDir(project: string): Promise<string> {
  const dir = join(project, ".summer", "captures");
  await mkdir(dir, { recursive: true });
  for (const [name, body] of [
    [".gdignore", ""],
    [".gitignore", "*\n"],
  ] as const) {
    const file = join(dir, name);
    if (!existsSync(file)) await writeFile(file, body);
  }
  return dir;
}

/** Width and height from a PNG's IHDR chunk, or null when the file is not a PNG. */
export function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * The stock probe. Self-contained (extends Node, no base class to copy into the
 * project); follows the verify-instance contract of assets/autopilot/probe_base.gd:
 * the engine sets summer_out_dir and summer_max_seconds before _ready(), the
 * first frames are empty until the scene has drawn twice, results.json is
 * always written.
 */
export function captureProbeSource(frames: number, waitSeconds: number, intervalSeconds: number): string {
  return `# Written by summer_capture_gameplay. Safe to delete.
# Fully typed: projects that treat GDScript warnings as errors must still load it.
extends Node

var summer_out_dir: String = ""
var summer_max_seconds: int = 20

const FRAMES: int = ${frames}
const WAIT_SECONDS: float = ${waitSeconds.toFixed(3)}
const INTERVAL_SECONDS: float = ${intervalSeconds.toFixed(3)}

var _shots: Array = []
var _warnings: Array = []
var _start_ms: int = 0
var _done: bool = false

func _ready() -> void:
\tprocess_mode = Node.PROCESS_MODE_ALWAYS
\t_start_ms = Time.get_ticks_msec()
\tget_tree().create_timer(float(summer_max_seconds), true).timeout.connect(_on_deadline)
\t_run.call_deferred()

func _on_deadline() -> void:
\t_finish(false)

func _run() -> void:
\t# The viewport holds no scene until two frames have been drawn.
\tvar guard: int = 0
\twhile Engine.get_frames_drawn() < 2 and guard < 600:
\t\tguard += 1
\t\tawait get_tree().process_frame
\tif DisplayServer.get_name() == "headless":
\t\t_warnings.append("No renderer (headless): no frame can be captured.")
\t\t_finish(true)
\t\treturn
\tawait get_tree().create_timer(WAIT_SECONDS, true).timeout
\tfor i: int in range(FRAMES):
\t\tif i > 0:
\t\t\tawait get_tree().create_timer(INTERVAL_SECONDS, true).timeout
\t\tawait RenderingServer.frame_post_draw
\t\tvar img: Image = get_viewport().get_texture().get_image()
\t\tvar file_name: String = "shot-%02d.png" % (i + 1)
\t\tif img == null:
\t\t\t_warnings.append("%s: the viewport returned no image." % file_name)
\t\t\tcontinue
\t\tif img.save_png(summer_out_dir.path_join(file_name)) == OK:
\t\t\t_shots.append({"file": file_name, "width": img.get_width(), "height": img.get_height()})
\t\telse:
\t\t\t_warnings.append("%s: could not write the PNG." % file_name)
\t_finish(true)

func _errors() -> Array:
\tvar errors: Array = []
\tvar path: String = summer_out_dir.path_join("errors.log")
\tif FileAccess.file_exists(path):
\t\tvar f: FileAccess = FileAccess.open(path, FileAccess.READ)
\t\tif f != null:
\t\t\twhile not f.eof_reached():
\t\t\t\tvar line: String = f.get_line()
\t\t\t\tif line.strip_edges() != "":
\t\t\t\t\terrors.append(line)
\treturn errors

func _finish(finished: bool) -> void:
\tif _done:
\t\treturn
\t_done = true
\tvar out: Dictionary = {"shots": _shots, "frame_warnings": _warnings, "errors_seen": _errors(), "duration_ms": Time.get_ticks_msec() - _start_ms, "finished": finished}
\tvar f: FileAccess = FileAccess.open(summer_out_dir.path_join("results.json"), FileAccess.WRITE)
\tif f != null:
\t\tf.store_string(JSON.stringify(out, "  "))
\t\tf.close()
\tget_tree().quit()
`;
}

function outputTail(output: string): string {
  return output.trim().split("\n").slice(-30).join("\n");
}

interface ProbeResults {
  ok?: boolean;
  failure_reason?: string;
  error?: string;
  shots?: { file: string; width: number; height: number }[];
  frame_warnings?: string[];
  errors_seen?: string[];
  finished?: boolean;
}

export async function captureGameplay(
  input: CaptureGameplayInput,
  overrides: Partial<CaptureGameplayDependencies> = {}
): Promise<CaptureGameplayResult> {
  const deps = { ...defaultDependencies, ...overrides };
  const project = resolveExportProject(input.project);
  const resolution = parseResolution(input.resolution);
  const frames = Math.round(boundedNumber(input.frames, 1, 1, MAX_FRAMES, "frames"));
  const waitSeconds = boundedNumber(input.waitSeconds, 3, 0, 120, "waitSeconds");
  const intervalSeconds = boundedNumber(input.intervalSeconds, 1, 0.1, 60, "intervalSeconds");
  const scene = checkScene(project, input.scene);
  const started = deps.now();

  const binary = deps.findBinary();
  if (!binary) {
    throw new BuildToolError(
      "engine_not_installed",
      "Summer Engine is not installed on this machine.",
      'Recovery: run "summer install", or set SUMMER_BIN to the engine executable, then capture again.'
    );
  }

  let out: string;
  if (input.out?.trim()) {
    out = isAbsolute(input.out) ? input.out : resolve(project, input.out);
  } else {
    out = join(await capturesDir(project), stamp(started));
  }
  await mkdir(out, { recursive: true });
  await rm(join(out, "results.json"), { force: true });

  // A never-opened checkout has no .godot/ caches; the game would boot into
  // missing-import errors. Build them once, headless (same as tests/autopilot).
  let imported = false;
  if (!existsSync(join(project, ".godot"))) {
    const run = await deps.run(binary, ["--headless", "--import", "--disable-crash-handler", "--path", project], IMPORT_TIMEOUT_MS);
    if (run.timedOut || !existsSync(join(project, ".godot"))) {
      throw new BuildToolError(
        "import_failed",
        "Summer Engine could not import the project's assets before the capture.",
        "Recovery: open the project once in Summer Engine (or run the engine with --headless --import), then capture again.",
        undefined,
        { output: outputTail(run.output) }
      );
    }
    imported = true;
  }

  const probe = join(out, PROBE_FILE);
  await writeFile(probe, captureProbeSource(frames, waitSeconds, intervalSeconds));
  const maxSeconds = Math.min(ENGINE_MAX_SECONDS, Math.ceil(waitSeconds + (frames - 1) * intervalSeconds + 30));
  const args = [
    "--disable-crash-handler",
    // No local HTTP API or ~/.summer discovery files for this throwaway run.
    "--summer-no-api",
    "--path",
    project,
    "--resolution",
    resolution.text,
    ...(scene ? ["--scene", scene] : []),
    "--summer-verify",
    probe,
    "--summer-verify-out",
    out,
    "--summer-verify-max",
    String(maxSeconds),
  ];
  let run: EngineRun;
  try {
    run = await deps.run(binary, args, (maxSeconds + 60) * 1000);
  } catch (error) {
    throw new BuildToolError(
      "engine_launch_failed",
      `Summer Engine could not start: ${error instanceof Error ? error.message : String(error)}.`,
      'Recovery: run "summer doctor" and check the engine install.'
    );
  } finally {
    await rm(probe, { force: true });
  }

  const resultsPath = join(out, "results.json");
  const results: ProbeResults | null = existsSync(resultsPath)
    ? (() => {
        try {
          return JSON.parse(readFileSync(resultsPath, "utf8")) as ProbeResults;
        } catch {
          return null;
        }
      })()
    : null;
  const engineErrors = (results?.errors_seen ?? []).filter((line) => !line.startsWith("WARNING|"));
  if (!results || results.failure_reason || !results.shots?.length) {
    const reason = results?.failure_reason
      ? `${results.failure_reason}: ${results.error ?? ""}`.trim()
      : results
        ? "the game ran but no frame was saved"
        : "the verify instance wrote no results";
    throw new BuildToolError(
      "capture_failed",
      `No gameplay frame was captured (${reason}).`,
      results?.failure_reason === "no_main_scene"
        ? "Recovery: set a main scene in Project Settings, or pass scene."
        : "Recovery: read the engine errors below, fix what they name, and capture again. An engine older than the verify instance (before 0.5.55) cannot capture: update Summer Engine.",
      undefined,
      {
        ...(engineErrors.length ? { engineErrors: engineErrors.slice(0, 10) } : {}),
        ...(results?.frame_warnings?.length ? { frameWarnings: results.frame_warnings } : {}),
        output: outputTail(run.output),
      }
    );
  }

  const captured: CapturedFrame[] = [];
  for (const shot of results.shots) {
    const path = join(out, shot.file);
    if (!existsSync(path)) continue;
    const size = pngSize(await readFile(path)) ?? { width: shot.width, height: shot.height };
    captured.push({ path, ...size });
  }
  const warnings = [...(results.frame_warnings ?? [])];
  if (results.finished === false) warnings.push("The game hit its time limit before every frame was saved.");
  const off = captured.filter((frame) => frame.width !== resolution.width || frame.height !== resolution.height);
  if (off.length) {
    warnings.push(
      `Frames are ${off[0].width}x${off[0].height}, not ${resolution.text}: the project's stretch settings (Project Settings > Display > Window) set the render size. Store screenshots need 1920x1080 or 1080x1920; crop or change the stretch mode.`
    );
  }
  if (engineErrors.length) warnings.push(`The engine logged ${engineErrors.length} error(s) during the run; check the frames show the game as expected: ${engineErrors.slice(0, 3).join(" / ")}`);

  return {
    ok: true,
    project,
    scene: scene ?? "main scene",
    resolution: resolution.text,
    frames: captured,
    out,
    engine: binary,
    imported,
    durationMs: deps.now().getTime() - started.getTime(),
    ...(warnings.length ? { warnings } : {}),
    next: "Look at each frame before using it. For the store: upload with summer_upload_image_begin/complete and set them as desktop.screenshots or mobile.screenshots (summer_store_set_art). The game's own HUD may show; add no captions, logos or overlays.",
  };
}
