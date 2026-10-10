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
 *            [--scene res://...] --summer-offscreen --summer-verify <probe.gd>
 *            --summer-verify-out <dir> --summer-verify-max <s> [-- <args>]
 *
 * The stock probe waits for the scene to draw and settle, runs the steps (press
 * a button, a key or an input action, click, drag, wait, shot) from inside the
 * game, saves PNG frames of the game viewport, and writes results.json. The
 * frames are what the game really draws, HUD included: use them as store
 * screenshots. `args` reach the game as OS.get_cmdline_user_args(), so a game
 * that skips its title screen on a flag starts in play.
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
  /** The game's own command-line args, passed after "--" (OS.get_cmdline_user_args()). */
  args?: string[];
  /** What to do after waitSeconds, in order. With a shot step, only shot steps save frames. */
  steps?: CaptureStep[];
}

/**
 * One capture step, run from inside the game. Coordinates are frame pixels
 * (the saved PNG's space). press finds a visible, enabled button by its text,
 * then its node name, then a partial match, waiting up to timeoutSeconds for
 * it to appear; it clicks the button's centre, and emits pressed when the
 * click did not reach it. key takes Godot key names (Space, Enter, Escape, A).
 */
export type CaptureStep =
  | { press: string; timeoutSeconds?: number }
  | { key: string; holdMs?: number }
  | { action: string; holdMs?: number }
  | { click: [number, number] }
  | { drag: { from: [number, number]; to: [number, number]; ms?: number } }
  | { wait: number }
  | { shot: true };

/** A step as the probe reads it (one shape, all fields named). */
export interface ProbeStep {
  type: "press" | "key" | "action" | "click" | "drag" | "wait" | "shot";
  text?: string;
  timeout?: number;
  hold_ms?: number;
  at?: [number, number];
  to?: [number, number];
  ms?: number;
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
const MAX_STEPS = 50;
const MAX_ARGS = 32;
const STEP_KINDS = ["press", "key", "action", "click", "drag", "wait", "shot"] as const;

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

function checkArgs(args: unknown): string[] {
  if (args === undefined) return [];
  if (!Array.isArray(args) || args.length > MAX_ARGS || args.some((arg) => typeof arg !== "string" || arg.length > 200 || /[\u0000\n\r]/.test(arg))) {
    throw invalid(`args must be at most ${MAX_ARGS} single-line strings.`, 'Recovery: pass the game\'s own flags, e.g. ["--autostart", "--solo"].');
  }
  return args as string[];
}

function point(value: unknown, where: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2 || !value.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 7680)) {
    throw invalid(`${where} must be [x, y] in frame pixels.`, "Recovery: pass two numbers from 0 to 7680, e.g. [960, 540] for the middle of a 1920x1080 frame.");
  }
  return [value[0], value[1]];
}

/** Validate the steps and turn them into the probe's one shape. */
export function probeSteps(steps: unknown): ProbeStep[] {
  if (steps === undefined) return [];
  if (!Array.isArray(steps) || steps.length > MAX_STEPS) {
    throw invalid(`steps must be a list of at most ${MAX_STEPS} steps.`, 'Recovery: pass e.g. [{"press":"Play"},{"wait":2000},{"shot":true}].');
  }
  const out = steps.map((raw, index): ProbeStep => {
    const where = `steps[${index}]`;
    const step = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const kinds = STEP_KINDS.filter((kind) => kind in step);
    if (kinds.length !== 1) {
      throw invalid(`${where} must have exactly one of ${STEP_KINDS.join(", ")}.`, 'Recovery: one step per object, e.g. {"press":"Play"} or {"key":"Space"}.');
    }
    const hold = boundedNumber(step.holdMs as number | undefined, 100, 0, 10_000, `${where}.holdMs`);
    const name = (key: string): string => {
      const value = step[key];
      if (typeof value !== "string" || !value.trim() || value.length > 100) {
        throw invalid(`${where}.${key} must be a non-empty name.`, 'Recovery: e.g. {"press":"Play"}, {"key":"Space"}, {"action":"jump"}.');
      }
      return value.trim();
    };
    switch (kinds[0]) {
      case "press":
        return { type: "press", text: name("press"), timeout: boundedNumber(step.timeoutSeconds as number | undefined, 10, 0, 60, `${where}.timeoutSeconds`) };
      case "key":
        return { type: "key", text: name("key"), hold_ms: hold };
      case "action":
        return { type: "action", text: name("action"), hold_ms: hold };
      case "click":
        return { type: "click", at: point(step.click, `${where}.click`) };
      case "drag": {
        const drag = (step.drag && typeof step.drag === "object" ? step.drag : {}) as Record<string, unknown>;
        return {
          type: "drag",
          at: point(drag.from, `${where}.drag.from`),
          to: point(drag.to, `${where}.drag.to`),
          ms: boundedNumber(drag.ms as number | undefined, 300, 0, 10_000, `${where}.drag.ms`),
        };
      }
      case "wait":
        return { type: "wait", ms: boundedNumber(step.wait as number | undefined, 0, 0, 60_000, `${where}.wait`) };
      default:
        if (step.shot !== true) throw invalid(`${where}.shot must be true.`, 'Recovery: {"shot":true} saves a frame at that point.');
        return { type: "shot" };
    }
  });
  if (out.filter((step) => step.type === "shot").length > MAX_FRAMES) {
    throw invalid(`at most ${MAX_FRAMES} shot steps.`, "Recovery: capture again for more frames.");
  }
  return out;
}

/** Seconds the steps can take at most (press waits for its button). */
function stepSeconds(steps: ProbeStep[]): number {
  return steps.reduce((sum, step) => sum + (step.timeout ?? 0) + ((step.hold_ms ?? 0) + (step.ms ?? 0)) / 1000 + 0.5, 0);
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
export function captureProbeSource(frames: number, waitSeconds: number, intervalSeconds: number, steps: ProbeStep[] = []): string {
  return `# Written by summer_capture_gameplay. Safe to delete.
# Fully typed: projects that treat GDScript warnings as errors must still load it.
extends Node

var summer_out_dir: String = ""
var summer_max_seconds: int = 20

const FRAMES: int = ${frames}
const WAIT_SECONDS: float = ${waitSeconds.toFixed(3)}
const INTERVAL_SECONDS: float = ${intervalSeconds.toFixed(3)}
const STEPS_JSON: String = ${JSON.stringify(JSON.stringify(steps))}

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
\tvar steps: Array = JSON.parse_string(STEPS_JSON)
\tvar shot_steps: bool = false
\tfor i: int in range(steps.size()):
\t\tvar step: Dictionary = steps[i]
\t\tmatch String(step["type"]):
\t\t\t"press":
\t\t\t\tawait _press(i, String(step["text"]), float(step["timeout"]))
\t\t\t"key":
\t\t\t\tvar keycode: Key = OS.find_keycode_from_string(String(step["text"]))
\t\t\t\tif keycode == KEY_NONE:
\t\t\t\t\t_warnings.append('steps[%d]: no key is named "%s" (use names like Space, Enter, Escape, A, Up).' % [i, step["text"]])
\t\t\t\telse:
\t\t\t\t\tawait _key(keycode, int(step["hold_ms"]))
\t\t\t"action":
\t\t\t\tif not InputMap.has_action(StringName(String(step["text"]))):
\t\t\t\t\t_warnings.append('steps[%d]: the project has no input action "%s".' % [i, step["text"]])
\t\t\t\telse:
\t\t\t\t\tawait _action(String(step["text"]), int(step["hold_ms"]))
\t\t\t"click":
\t\t\t\tawait _click(Vector2(step["at"][0], step["at"][1]))
\t\t\t"drag":
\t\t\t\tawait _drag(Vector2(step["at"][0], step["at"][1]), Vector2(step["to"][0], step["to"][1]), int(step["ms"]))
\t\t\t"wait":
\t\t\t\tawait get_tree().create_timer(float(step["ms"]) / 1000.0, true).timeout
\t\t\t"shot":
\t\t\t\tshot_steps = true
\t\t\t\tawait _shot()
\tif not shot_steps:
\t\tfor i: int in range(FRAMES):
\t\t\tif i > 0:
\t\t\t\tawait get_tree().create_timer(INTERVAL_SECONDS, true).timeout
\t\t\tawait _shot()
\t_finish(true)

func _shot() -> void:
\tawait RenderingServer.frame_post_draw
\tvar img: Image = get_viewport().get_texture().get_image()
\tvar file_name: String = "shot-%02d.png" % (_shots.size() + 1)
\tif img == null:
\t\t_warnings.append("%s: the viewport returned no image." % file_name)
\t\treturn
\tif img.save_png(summer_out_dir.path_join(file_name)) == OK:
\t\t_shots.append({"file": file_name, "width": img.get_width(), "height": img.get_height()})
\telse:
\t\t_warnings.append("%s: could not write the PNG." % file_name)

# Frame pixels (the saved PNG) -> window coordinates, through the stretch transform.
func _to_window(frame_pos: Vector2) -> Vector2:
\treturn get_viewport().get_final_transform() * frame_pos

func _mouse_button(frame_pos: Vector2, pressed: bool) -> void:
\tvar ev: InputEventMouseButton = InputEventMouseButton.new()
\tev.button_index = MOUSE_BUTTON_LEFT
\tev.pressed = pressed
\tev.button_mask = MOUSE_BUTTON_MASK_LEFT if pressed else 0
\tev.position = _to_window(frame_pos)
\tev.global_position = ev.position
\tInput.parse_input_event(ev)

func _mouse_move(frame_pos: Vector2, relative: Vector2, held: bool) -> void:
\tvar ev: InputEventMouseMotion = InputEventMouseMotion.new()
\tev.position = _to_window(frame_pos)
\tev.global_position = ev.position
\tev.relative = relative
\tev.button_mask = MOUSE_BUTTON_MASK_LEFT if held else 0
\tInput.parse_input_event(ev)

func _click(frame_pos: Vector2) -> void:
\t_mouse_move(frame_pos, Vector2.ZERO, false)
\tawait get_tree().process_frame
\t_mouse_button(frame_pos, true)
\tawait get_tree().create_timer(0.05, true).timeout
\t_mouse_button(frame_pos, false)
\tawait get_tree().process_frame

func _drag(from: Vector2, to: Vector2, ms: int) -> void:
\t_mouse_move(from, Vector2.ZERO, false)
\t_mouse_button(from, true)
\tvar moves: int = maxi(2, int(ms / 16.0))
\tvar last: Vector2 = from
\tfor j: int in range(1, moves + 1):
\t\tawait get_tree().create_timer(float(ms) / 1000.0 / moves, true).timeout
\t\tvar here: Vector2 = from.lerp(to, float(j) / moves)
\t\t_mouse_move(here, here - last, true)
\t\tlast = here
\t_mouse_button(to, false)
\tawait get_tree().process_frame

func _key(keycode: Key, hold_ms: int) -> void:
\tvar ev: InputEventKey = InputEventKey.new()
\tev.keycode = keycode
\tev.physical_keycode = keycode
\tev.pressed = true
\tInput.parse_input_event(ev)
\tawait get_tree().create_timer(hold_ms / 1000.0, true).timeout
\tvar up: InputEventKey = InputEventKey.new()
\tup.keycode = keycode
\tup.physical_keycode = keycode
\tup.pressed = false
\tInput.parse_input_event(up)
\tawait get_tree().process_frame

func _action(action: String, hold_ms: int) -> void:
\tvar ev: InputEventAction = InputEventAction.new()
\tev.action = action
\tev.pressed = true
\tInput.parse_input_event(ev)
\tawait get_tree().create_timer(hold_ms / 1000.0, true).timeout
\tvar up: InputEventAction = InputEventAction.new()
\tup.action = action
\tup.pressed = false
\tInput.parse_input_event(up)
\tawait get_tree().process_frame

# A visible, enabled button: exact text, then node name, then partial text, then partial name.
func _find_button(label: String) -> BaseButton:
\tvar want: String = label.strip_edges().to_lower()
\tvar best: BaseButton = null
\tvar best_rank: int = 99
\tfor node: Node in get_tree().root.find_children("*", "BaseButton", true, false):
\t\tvar button: BaseButton = node as BaseButton
\t\tif button == null or button.disabled or not button.is_visible_in_tree():
\t\t\tcontinue
\t\tvar text: String = ""
\t\tif button is Button:
\t\t\ttext = tr((button as Button).text).strip_edges().to_lower()
\t\tvar node_name: String = String(button.name).to_lower()
\t\tvar rank: int = 99
\t\tif text == want:
\t\t\trank = 0
\t\telif node_name == want:
\t\t\trank = 1
\t\telif text.contains(want):
\t\t\trank = 2
\t\telif node_name.contains(want):
\t\t\trank = 3
\t\tif rank < best_rank:
\t\t\tbest = button
\t\t\tbest_rank = rank
\treturn best

var _pressed_seen: bool = false

func _on_pressed_seen() -> void:
\t_pressed_seen = true

# Click the button's centre like a player; emit pressed when the click did not reach it.
func _press(index: int, label: String, timeout: float) -> void:
\tvar button: BaseButton = _find_button(label)
\tvar deadline: int = Time.get_ticks_msec() + int(timeout * 1000.0)
\twhile button == null and Time.get_ticks_msec() < deadline:
\t\tawait get_tree().create_timer(0.1, true).timeout
\t\tbutton = _find_button(label)
\tif button == null:
\t\t_warnings.append('steps[%d]: no visible, enabled button "%s" within %.1f s.' % [index, label, timeout])
\t\treturn
\t_pressed_seen = false
\tbutton.pressed.connect(_on_pressed_seen, CONNECT_ONE_SHOT)
\tvar centre: Vector2 = button.get_global_transform_with_canvas() * (button.size / 2.0)
\tawait _click(centre)
\tif not _pressed_seen and is_instance_valid(button):
\t\tif button.pressed.is_connected(_on_pressed_seen):
\t\t\tbutton.pressed.disconnect(_on_pressed_seen)
\t\tbutton.pressed.emit()
\tawait get_tree().process_frame

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
  const userArgs = checkArgs(input.args);
  const steps = probeSteps(input.steps);
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
  await writeFile(probe, captureProbeSource(frames, waitSeconds, intervalSeconds, steps));
  const maxSeconds = Math.min(ENGINE_MAX_SECONDS, Math.ceil(waitSeconds + (frames - 1) * intervalSeconds + stepSeconds(steps) + 30));
  const args = [
    "--disable-crash-handler",
    // No local HTTP API or ~/.summer discovery files for this throwaway run.
    "--summer-no-api",
    "--path",
    project,
    "--resolution",
    resolution.text,
    ...(scene ? ["--scene", scene] : []),
    // The verify instance is offscreen already; the posture flag says so explicitly.
    "--summer-offscreen",
    "--summer-verify",
    probe,
    "--summer-verify-out",
    out,
    "--summer-verify-max",
    String(maxSeconds),
    ...(userArgs.length ? ["--", ...userArgs] : []),
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
