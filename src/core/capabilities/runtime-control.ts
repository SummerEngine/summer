/**
 * Runtime control & playtest ops (engine Wave I) — the "see and touch the
 * RUNNING game" surface. One copy of the argument contracts, op builders,
 * client budgets and failure hints, shared by the MCP tools
 * (src/mcp/tools/runtime-tools.ts) and the CLI dispatcher (`summer tool …`) so
 * both faces validate the same inputs, send the same op and wait the same
 * budget.
 *
 * Engine contract (frozen): doc/SUMMER/SCENE_SCRIPTING_CONTRACTS.md "Wave I —
 * Runtime control & playtest ops" + editor/ops/runtime_ops.h. Every op except
 * ListGameInstances is SINGLE-ONLY and ASYNC (a debugger round-trip needs the
 * reply channel), requires a RUNNING game, accepts `instance?` (default
 * "main"), stamps the game frame it describes, rounds floats to 3dp and
 * serialises math values as Godot literal strings ("Vector3(1, 2, 3)").
 *
 * Sixteen engine kinds are grouped into seven tools:
 *   summer_runtime_set      SetRuntimeProp
 *   summer_runtime_call     CallRuntimeMethod
 *   summer_runtime_spawn    SpawnRuntimeScene | FreeRuntimeNode        (action)
 *   summer_runtime_animate  RuntimeAnimation | RuntimeAnimationTree |
 *                           GetRuntimeBones                            (target)
 *   summer_game_control     GamePause | GameStep | GameSpeed |
 *                           ListGameInstances                          (action)
 *   summer_game_input       SimulateInputScript | InputRecordStart |
 *                           InputRecordStop | InputReplay               (action)
 *   summer_game_probe       GameProbe
 * plus the instance-aware PlayGame / StopGame variants behind summer_play /
 * summer_stop.
 */

import { z } from "zod";
import { ToolInputError } from "../tool-errors.js";
import { missingEngineOpResult, type CapabilityAdvertisingClient } from "../capability-skew.js";
import { extractOpError, getFailureReason, withOldEngineHint } from "./engine-receipt.js";

// ---------------------------------------------------------------------------
// Op kinds
// ---------------------------------------------------------------------------

/** The fifteen async single-only kinds (RuntimeOps::async_op_kinds). */
export const RUNTIME_ASYNC_OP_KINDS: readonly string[] = [
  "SetRuntimeProp",
  "CallRuntimeMethod",
  "SpawnRuntimeScene",
  "FreeRuntimeNode",
  "RuntimeAnimation",
  "RuntimeAnimationTree",
  "GetRuntimeBones",
  "GamePause",
  "GameSpeed",
  "GameStep",
  "SimulateInputScript",
  "InputRecordStart",
  "InputRecordStop",
  "InputReplay",
  "GameProbe",
];

/** All sixteen Wave I kinds — the fifteen above plus the synchronous
 *  ListGameInstances read. */
export const RUNTIME_CONTROL_OP_KINDS: readonly string[] = [
  ...RUNTIME_ASYNC_OP_KINDS,
  "ListGameInstances",
];

// ---------------------------------------------------------------------------
// Budgets — mirror the engine's watchdogs (runtime_ops.cpp) plus relay headroom.
// ---------------------------------------------------------------------------

/** Default editor-side watchdog for a runtime op (_RT_DEFAULT_TIMEOUT_SEC). */
export const RUNTIME_WATCHDOG_DEFAULT_SEC = 10;
/** Hard cap on any runtime watchdog (_RT_MAX_TIMEOUT_SEC). */
export const RUNTIME_WATCHDOG_MAX_SEC = 20;
/** GameProbe watchdog: screenshot + PNG -> JPEG decode (_RT_PROBE_TIMEOUT_SEC). */
export const RUNTIME_PROBE_WATCHDOG_SEC = 15;
/** Offscreen child attach budget before the engine kills it (_RT_ATTACH_TIMEOUT_SEC). */
export const RUNTIME_ATTACH_TIMEOUT_SEC = 15;
/** The op is staged on the editor's async lane and polled over HTTP; the
 *  watchdog fires editor-side, so the client always waits longer than it. */
export const RUNTIME_CLIENT_HEADROOM_MS = 15_000;

/** GameStep frames cap (_RT_STEP_MAX_FRAMES). */
export const GAME_STEP_MAX_FRAMES = 600;
/** SimulateInputScript / InputReplay event cap (_RT_SCRIPT_MAX_EVENTS). */
export const INPUT_SCRIPT_MAX_EVENTS = 1000;
/** Last-event horizon: 36000 frames = 600 s at 60 fps (_RT_SCRIPT_HORIZON_FRAMES). */
export const INPUT_SCRIPT_HORIZON_FRAMES = 36_000;
/** GameProbe props cap and tree bounds. */
export const GAME_PROBE_MAX_PROPS = 64;
export const GAME_PROBE_MAX_DEPTH = 8;
export const GAME_PROBE_MAX_LIMIT = 4000;
export const GAME_PROBE_MIN_DIM = 16;
export const GAME_PROBE_MAX_DIM = 4096;
/** Offscreen instance cap (4 debugger sessions total, the run bar's game included). */
export const MAX_OFFSCREEN_INSTANCES = 3;
/** PlayGame default seed when deterministic and no seed is given (_RT_DEFAULT_SEED). */
export const PLAY_DEFAULT_SEED = 20260725;

/** Client poll budget for an engine watchdog of `watchdogSec` seconds. */
export function runtimeBudgetMs(watchdogSec: number): number {
  return Math.round(watchdogSec * 1000) + RUNTIME_CLIENT_HEADROOM_MS;
}

/** Instance-aware PlayGame: the child must attach within 15 s, and a cold
 *  load of a large project can take 25-40 s on top — same 60 s as /api/play. */
export const PLAY_INSTANCE_TIMEOUT_MS = 60_000;
/** StopGame {instance}: kills a PID — same 15 s budget as /api/stop. */
export const STOP_INSTANCE_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Fallbacks named by engine_lacks_op (pre-flight and post-hoc alike).
// ---------------------------------------------------------------------------

export const RUNTIME_FALLBACKS: Readonly<Record<string, string>> = {
  SetRuntimeProp:
    "drive the RUNNING game from a RunVerification probe (it can set properties and report them back), or edit the scene with summer_set_prop and restart the game",
  CallRuntimeMethod:
    "call the method from a RunVerification probe (report(key, value) carries the return), or send SimulateInput for input-driven behaviour",
  SpawnRuntimeScene:
    "spawn from a RunVerification probe, or instantiate into the EDITED scene with summer_instantiate_scene and restart the game",
  FreeRuntimeNode:
    "free the node from a RunVerification probe, or remove it from the EDITED scene with summer_remove_node and restart the game",
  RuntimeAnimation:
    "drive the AnimationPlayer from a RunVerification probe and save_frame the result",
  RuntimeAnimationTree:
    "drive the AnimationTree state machine from a RunVerification probe and report its playback state",
  GetRuntimeBones:
    "read bone poses from a RunVerification probe (Skeleton3D.get_bone_global_pose) or verify visually with summer_screenshot target:'game'",
  GamePause:
    "pause from a RunVerification probe (get_tree().paused = true) or observe with summer_screenshot target:'game'",
  GameStep:
    "await get_tree().physics_frame N times inside a RunVerification probe and assert there — this engine cannot step the live game frame by frame",
  GameSpeed:
    "set Engine.time_scale from a RunVerification probe, or accept real-time observation",
  SimulateInputScript:
    "send SimulateInput ops one at a time (summer_batch, single op each) or script the sequence in a RunVerification probe with press()/key()",
  InputRecordStart:
    "script the inputs by hand in a RunVerification probe — this engine cannot record live input",
  InputRecordStop:
    "script the inputs by hand in a RunVerification probe — this engine cannot record live input",
  InputReplay:
    "replay the sequence as SimulateInput ops or a RunVerification probe — this engine cannot replay a recording",
  GameProbe:
    "read live state from a RunVerification probe (dump_tree/report — see the playbook's rawOpsViaBatch) and capture pixels with summer_screenshot target:'game' (two calls, two frames — not one atomic frame)",
  ListGameInstances:
    "use summer_is_running for the main game — this engine has no parallel offscreen instances",
};

/** Instance-aware PlayGame rides the same engine wave as ListGameInstances;
 *  an engine that lacks the latter would start the MAIN game and silently
 *  ignore instance/mode, so the pre-flight keys on this kind. */
export const PLAY_INSTANCE_FALLBACK =
  "start the main game with summer_play without instance/mode (seed and fixed_fps still apply there) and observe it with summer_screenshot target:'game' or a RunVerification probe — this engine has no parallel offscreen instances";

// ---------------------------------------------------------------------------
// Failure hints — prescriptive recovery text keyed by failure_reason.
// ---------------------------------------------------------------------------

export const RUNTIME_FAILURE_HINTS: Readonly<Record<string, string>> = {
  game_not_running:
    "No game is running for this instance, so there is nothing to drive. Start it with summer_play (add instance + mode:'offscreen' for a disposable parallel instance; deterministic:true with seed for a reproducible run), confirm with summer_is_running or summer_game_control action:'instances' (attached:true), then retry. For the scene being EDITED use the scene tools or summer_run_script instead.",
  unknown_instance:
    "No live game instance has that name. summer_game_control action:'instances' lists the live ones; start a new one with summer_play {instance, mode:'offscreen'}.",
  request_failed:
    "The game's debug session has not attached yet (it may still be booting). Wait a moment, confirm with summer_game_control action:'instances' (attached:true) or summer_is_running, then retry.",
  game_breaked:
    "The game is stopped at a script breakpoint, so mutating runtime ops are refused until it continues. Resume it in the editor debugger (or summer_stop then summer_play), then retry. summer_game_probe, GetRuntimeBones and the input recorder still answer while breaked.",
  busy:
    "Another input script is already in flight on this instance (one per instance). Wait for it to finish — summer_game_probe shows the frame advancing and the result of the first script arrives on its own call — then retry; never fire two scripts at the same instance in parallel.",
  timeout:
    "The running game did not answer within the engine's watchdog. It may be wedged, minimized (a window that draws no frames cannot step or probe), or stopped at a breakpoint. Check summer_get_debugger_errors; if the game is gone, summer_stop then summer_play, and retry.",
  unsupported:
    "The running game build predates the summer runtime capture and this op has no zero-game-code fallback. Restart the game after updating Summer Engine (the capture lives in the game binary); until then use a RunVerification probe.",
  unsupported_transport:
    "This op was batched with others or sent over a channel without an async reply lane. Send it as the ONLY op in the request (the dedicated summer_* runtime tools already do); nothing from the rejected batch was applied.",
  not_applied:
    "applied:false — the read-back after the write did not match. The property is probably overwritten every frame by a script, read-only, or typed differently from the literal you sent (math values need Godot literal strings such as 'Vector3(1, 2, 3)'). Probe the value with summer_game_probe props, then either set it through the owning script's setter with summer_runtime_call or step the game and re-probe.",
  nondeterministic_instance:
    "seed only means something on a deterministic offscreen instance. Start one with summer_play {instance, mode:'offscreen', deterministic:true, seed} and replay there, or drop seed to replay on this instance without a reproducibility claim.",
  body_too_big:
    "The reply exceeded the 1 MiB body cap. Narrow it: smaller tree depth/limit, fewer props, a lower max_dim or screenshot:false on the probe; page bones with the bones filter.",
  rejected_identity:
    "The editor switched projects while the op was in flight; nothing was applied. Call summer_get_project_context to rebind (only if you meant to follow the switch), then retry.",
  node_not_found:
    "That path does not exist in the RUNNING game. Runtime paths are absolute ('/root/Main/Player') and often differ from the edited scene because nodes are spawned, renamed or reparented at runtime. List what actually exists with summer_game_probe tree (or summer_get_runtime_tree) and retry with a path from its result.",
  parent_not_found:
    "The spawn parent does not exist in the RUNNING game. Read the live tree with summer_game_probe tree and pass an absolute runtime path such as '/root/Main/Enemies'.",
  scene_load_failed:
    "The scene could not be loaded in the running game. Check the res:// path with summer_read_file and the console (summer_get_console) for the loader's error.",
  not_packed_scene:
    "That res:// path is not a PackedScene (.tscn/.scn). Pass a scene file, not a script or resource.",
  refused_root:
    "The scene root cannot be freed (it would end the game). Free a child node, or summer_stop to end the run.",
  refused_property:
    "script and owner are never set at runtime through this op (it would detach the node's behaviour). Change the script in the EDITED scene and restart, or call a method on the node instead.",
  property_not_found:
    "The node has no such property. summer_inspect_runtime_node lists its live properties; summer_api_docs lists the class's declared ones.",
  method_not_found:
    "The node has no such method. Check summer_api_docs for the class (walk inherits for inherited methods) or the node's script.",
  call_error:
    "The method ran and raised (call_error_detail carries the message). Fix the arguments or the script; nothing further was applied.",
  bad_args:
    "The engine rejected the arguments (the error names which). Fix them and retry — nothing was applied.",
  too_many_events:
    "More than 1000 events in one script. Split it into sequential scripts (each waits for the previous result).",
  horizon_exceeded:
    "The last event lands beyond the 36000-frame / 600 s horizon. Shorten the script or run it as several scripts.",
  all_rejected:
    "Every event was rejected (see rejected[] for each index and reason). unknown_action means the action is not in the project InputMap — bind it with summer_input_map_bind and restart the game, or drive keys directly with type:'key'.",
  already_recording:
    "A recording is already running on this instance. Stop it with action:'record_stop' (it returns the file) before starting another.",
  not_recording:
    "No recording is running on this instance. Start one with action:'record_start', play or script the inputs, then stop it.",
  recording_not_found:
    "No recording at that res:// path. action:'record_stop' returns the path it wrote (res://.summer/replays/<id>.json); pass that exact string.",
  bad_recording:
    "The recording file is not the version:1 schema {version, events[]}. Re-record it, or pass inline events instead.",
  not_animation_player:
    "That node is not an AnimationPlayer. Use target:'tree' for an AnimationTree or find the player under the character with summer_game_probe tree.",
  not_animation_tree:
    "That node is not an AnimationTree. Use target:'player' for an AnimationPlayer or find the tree with summer_game_probe tree.",
  no_state_machine:
    "playback_path does not resolve to an AnimationNodeStateMachinePlayback. Pass the parameter path of the state machine (default 'parameters/playback'; nested machines use 'parameters/<Node>/playback').",
  unknown_animation:
    "No clip with that name (the error lists the player's clips). Pass one of them exactly.",
  unknown_state:
    "No state with that name (the error lists the states). Pass one exactly.",
  unknown_parameter:
    "No such AnimationTree parameter. cmd:'state' lists the readable ones under parameters.",
  read_only_parameter:
    "That AnimationTree parameter is read-only (a playback object or a computed value). Drive it with travel/start/stop instead.",
  not_skeleton:
    "That node is not a Skeleton3D. Find the skeleton under the character with summer_game_probe tree and pass its absolute path.",
  unknown_bone:
    "No bone with that name (the error lists the rig's names, capped at 64). Omit bones to read the first 256, then filter.",
  too_many_instances:
    "At most 3 offscreen instances live at once. summer_stop {instance} one you no longer need, then retry.",
  session_timeout:
    "The child game did not attach to the debugger within 15 s and was killed. Check the editor Output for its stderr (summer_get_console), summer_stop {instance} to clear it, then summer_play again.",
  instance_exists:
    "A live instance already has that name. summer_stop {instance} first, or pick a new name.",
  unsupported_mode:
    "mode:'offscreen' needs an instance name other than 'main' (the main slot is the editor's embedded game). Pass instance:'a' (any name) with mode:'offscreen'.",
  spawn_failed:
    "The child game process could not be spawned. Check the console (summer_get_console) for the launcher's error and that the project runs with plain summer_play first.",
  main_scene_not_configured:
    "No valid main scene is configured. Set application/run/main_scene with summer_project_setting (or pass scene) and retry.",
  screenshot_failed:
    "The game could not capture its viewport this frame (minimized window or no drawn frame). Retry after summer_game_control action:'step', or pass screenshot:false to read state only.",
  decode_failed:
    "The editor could not decode the game's PNG. Retry once; if it persists pass screenshot:false and capture with summer_screenshot target:'game'.",
};

/**
 * Amend a runtime-op envelope with prescriptive recovery text. The structured
 * failure_reason stays intact for programmatic callers; on a failure only the
 * model-facing `error` string is taught. A SUCCESSFUL envelope that still
 * carries a reason (SetRuntimeProp applied:false + not_applied, InputReplay's
 * advisory nondeterministic_instance) gets a `hint` field instead — the op
 * did run, so its `error` must not be invented.
 */
export function withRuntimeFailureHints(
  result: unknown,
  extraHints: Record<string, string> = {}
): unknown {
  if (!result || typeof result !== "object") return result;
  const envelope = result as Record<string, unknown> & {
    results?: Array<Record<string, unknown> & { ok?: boolean; error?: string }>;
  };
  const failed = envelope.results?.find((entry) => entry.ok === false);
  const first = envelope.results?.[0];
  const hints = { ...RUNTIME_FAILURE_HINTS, ...extraHints };
  let reason =
    getFailureReason(envelope as { failureReason?: string; failure_reason?: string }) ??
    (failed ? getFailureReason(failed as { failureReason?: string; failure_reason?: string }) : undefined) ??
    (first ? getFailureReason(first as { failureReason?: string; failure_reason?: string }) : undefined);
  if (!reason && first?.applied === false) reason = "not_applied";
  if (typeof reason !== "string" || !(reason in hints)) return result;
  const hint = hints[reason]!;
  if (extractOpError(result)) {
    const engineError =
      (typeof envelope.error === "string" && envelope.error) ||
      (typeof failed?.error === "string" && failed.error) ||
      reason;
    return { ...envelope, error: `${hint} Engine said: ${engineError}` };
  }
  const existing = typeof envelope.hint === "string" ? `${envelope.hint} ` : "";
  return { ...envelope, hint: `${existing}${hint}` };
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

const INSTANCE_DESCRIPTION =
  "Game instance to address (default 'main' = the editor's embedded game). Offscreen instances are named by summer_play {instance, mode:'offscreen'}; summer_game_control action:'instances' lists the live ones.";

const instanceSchema = z.string().optional().describe(INSTANCE_DESCRIPTION);

/** Godot literal string ("Vector3(1, 2, 3)", "Color(1, 0, 0)") or a JSON scalar. */
const literalValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export interface BuiltRuntimeOp {
  /** Engine op kind the tool resolved to (for pre-flight, hints and tests). */
  kind: string;
  op: Record<string, unknown>;
  /** Client poll budget — always longer than the engine watchdog. */
  timeoutMs: number;
}

function withInstance(op: Record<string, unknown>, instance: string | undefined): Record<string, unknown> {
  const trimmed = typeof instance === "string" ? instance.trim() : "";
  if (trimmed.length > 0) op.instance = trimmed;
  return op;
}

function requireRuntimePath(value: unknown, field: string, example: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolInputError(
      `${field} is required: the ABSOLUTE runtime node path in the running game, e.g. '${example}' (read it from summer_game_probe tree or summer_get_runtime_tree).`
    );
  }
  return value.trim();
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

// ---------------------------------------------------------------------------
// summer_runtime_set — SetRuntimeProp
// ---------------------------------------------------------------------------

export const runtimeSetArgsSchema = z.object({
  path: z
    .string()
    .describe("ABSOLUTE runtime node path, e.g. '/root/Main/Player' (from summer_game_probe tree)."),
  property: z
    .string()
    .describe("Property name, e.g. 'position', 'health', 'visible'. 'script' and 'owner' are refused."),
  value: literalValueSchema.describe(
    "New value. JSON scalars for primitives; Godot literal strings for math types ('Vector3(1, 2, 3)', 'Color(1, 0, 0, 1)', 'Vector2(10, 0)'). Compared with Variant equality, so 1 and 1.0 both count as applied."
  ),
  field: z
    .string()
    .optional()
    .describe("Optional sub-field to set instead of the whole value, e.g. 'x' on a Vector3 property."),
  instance: instanceSchema,
});

export type RuntimeSetArgs = z.infer<typeof runtimeSetArgsSchema>;

export function buildRuntimeSetOp(args: RuntimeSetArgs): BuiltRuntimeOp {
  const path = requireRuntimePath(args.path, "path", "/root/Main/Player");
  if (typeof args.property !== "string" || args.property.trim().length === 0) {
    throw new ToolInputError("property is required: the property name to set on the running node.");
  }
  if (args.value === undefined) {
    throw new ToolInputError(
      "value is required: a JSON scalar, or a Godot literal string such as 'Vector3(1, 2, 3)' for math types."
    );
  }
  const op: Record<string, unknown> = {
    op: "SetRuntimeProp",
    path,
    property: args.property.trim(),
    value: args.value,
  };
  if (typeof args.field === "string" && args.field.trim().length > 0) op.field = args.field.trim();
  return { kind: "SetRuntimeProp", op: withInstance(op, args.instance), timeoutMs: runtimeBudgetMs(RUNTIME_WATCHDOG_DEFAULT_SEC) };
}

// ---------------------------------------------------------------------------
// summer_runtime_call — CallRuntimeMethod
// ---------------------------------------------------------------------------

export const runtimeCallArgsSchema = z.object({
  path: z.string().describe("ABSOLUTE runtime node path, e.g. '/root/Main/Player'."),
  method: z.string().describe("Method name to call on the node, e.g. 'take_damage', 'get_velocity'."),
  args: z
    .array(z.unknown())
    .optional()
    .describe(
      "Positional arguments. JSON scalars, arrays and objects pass as-is; math values as Godot literal strings ('Vector3(0, 1, 0)'). Object and RID arguments are refused (bad_args)."
    ),
  instance: instanceSchema,
});

export type RuntimeCallArgs = z.infer<typeof runtimeCallArgsSchema>;

export function buildRuntimeCallOp(args: RuntimeCallArgs): BuiltRuntimeOp {
  const path = requireRuntimePath(args.path, "path", "/root/Main/Player");
  if (typeof args.method !== "string" || args.method.trim().length === 0) {
    throw new ToolInputError("method is required: the method name to call on the running node.");
  }
  const op: Record<string, unknown> = { op: "CallRuntimeMethod", path, method: args.method.trim() };
  if (args.args !== undefined) {
    if (!Array.isArray(args.args)) throw new ToolInputError("args must be an array of positional arguments.");
    op.args = args.args;
  }
  return { kind: "CallRuntimeMethod", op: withInstance(op, args.instance), timeoutMs: runtimeBudgetMs(RUNTIME_WATCHDOG_DEFAULT_SEC) };
}

// ---------------------------------------------------------------------------
// summer_runtime_spawn — SpawnRuntimeScene | FreeRuntimeNode
// ---------------------------------------------------------------------------

export const runtimeSpawnArgsSchema = z.object({
  action: z
    .enum(["spawn", "free"])
    .describe("'spawn' instantiates a PackedScene under parent (SpawnRuntimeScene); 'free' removes a node (FreeRuntimeNode)."),
  parent: z
    .string()
    .optional()
    .describe("action:'spawn' — ABSOLUTE runtime path of the parent, e.g. '/root/Main/Enemies'."),
  scene: z
    .string()
    .optional()
    .describe("action:'spawn' — PackedScene to instantiate, e.g. 'res://enemies/goblin.tscn'."),
  name: z
    .string()
    .optional()
    .describe("action:'spawn' — node name; the engine renames on collision and reports renamed_to."),
  props: z
    .record(literalValueSchema)
    .optional()
    .describe(
      "action:'spawn' — properties set on the new node before it enters the tree ({position: 'Vector3(0, 1, 0)', health: 50}). Unknown ones land in prop_warnings, never fail the spawn."
    ),
  path: z.string().optional().describe("action:'free' — ABSOLUTE runtime path of the node to free."),
  mode: z
    .enum(["queue_free", "free"])
    .optional()
    .describe("action:'free' — 'queue_free' (default, safe: frees at the end of the frame) or 'free' (immediate)."),
  instance: instanceSchema,
});

export type RuntimeSpawnArgs = z.infer<typeof runtimeSpawnArgsSchema>;

export function buildRuntimeSpawnOp(args: RuntimeSpawnArgs): BuiltRuntimeOp {
  if (args.action === "spawn") {
    const parent = requireRuntimePath(args.parent, "parent", "/root/Main/Enemies");
    if (typeof args.scene !== "string" || !args.scene.trim().startsWith("res://")) {
      throw new ToolInputError("scene is required for action:'spawn': a res:// PackedScene path such as 'res://enemies/goblin.tscn'.");
    }
    const op: Record<string, unknown> = { op: "SpawnRuntimeScene", parent, scene: args.scene.trim() };
    if (typeof args.name === "string" && args.name.trim().length > 0) op.name = args.name.trim();
    if (args.props !== undefined) {
      if (!args.props || typeof args.props !== "object" || Array.isArray(args.props)) {
        throw new ToolInputError("props must be an object of property -> value.");
      }
      op.props = args.props;
    }
    return { kind: "SpawnRuntimeScene", op: withInstance(op, args.instance), timeoutMs: runtimeBudgetMs(RUNTIME_WATCHDOG_DEFAULT_SEC) };
  }
  if (args.action === "free") {
    const path = requireRuntimePath(args.path, "path", "/root/Main/Enemies/Goblin3");
    const op: Record<string, unknown> = { op: "FreeRuntimeNode", path };
    if (args.mode !== undefined) {
      if (args.mode !== "queue_free" && args.mode !== "free") {
        throw new ToolInputError("mode must be 'queue_free' (default) or 'free'.");
      }
      op.mode = args.mode;
    }
    return { kind: "FreeRuntimeNode", op: withInstance(op, args.instance), timeoutMs: runtimeBudgetMs(RUNTIME_WATCHDOG_DEFAULT_SEC) };
  }
  throw new ToolInputError("action must be 'spawn' or 'free'.");
}

// ---------------------------------------------------------------------------
// summer_runtime_animate — RuntimeAnimation | RuntimeAnimationTree | GetRuntimeBones
// ---------------------------------------------------------------------------

export const ANIMATION_PLAYER_CMDS = ["state", "play", "pause", "stop", "seek", "speed"] as const;
export const ANIMATION_TREE_CMDS = ["state", "travel", "start", "stop", "set_param", "get_param"] as const;

export const runtimeAnimateArgsSchema = z.object({
  target: z
    .enum(["player", "tree", "bones"])
    .describe("'player' = AnimationPlayer (RuntimeAnimation), 'tree' = AnimationTree state machine (RuntimeAnimationTree), 'bones' = Skeleton3D poses (GetRuntimeBones)."),
  path: z.string().describe("ABSOLUTE runtime path of the AnimationPlayer / AnimationTree / Skeleton3D."),
  cmd: z
    .enum(["state", "play", "pause", "stop", "seek", "speed", "travel", "start", "set_param", "get_param"])
    .optional()
    .describe(
      "Default 'state' (read-only). target:'player': state|play|pause|stop|seek|speed. target:'tree': state|travel|start|stop|set_param|get_param. Ignored for target:'bones'."
    ),
  name: z.string().optional().describe("target:'player' play — clip name (unknown_animation lists the clips)."),
  position: z.number().optional().describe("target:'player' seek — position in seconds."),
  speed: z.number().optional().describe("target:'player' speed — speed_scale (1.0 = normal, negative plays backwards)."),
  from_end: z.boolean().optional().describe("target:'player' play — start from the end (backwards)."),
  blend: z.number().optional().describe("target:'player' play — custom blend time in seconds."),
  update: z.boolean().optional().describe("target:'player' seek — apply the pose immediately (default true)."),
  state: z.string().optional().describe("target:'tree' travel/start — state machine node name (unknown_state lists them)."),
  reset: z.boolean().optional().describe("target:'tree' travel/start — reset the destination clip (default true)."),
  param: z.string().optional().describe("target:'tree' set_param/get_param — parameter path, e.g. 'parameters/Blend/blend_amount'."),
  value: literalValueSchema
    .optional()
    .describe("target:'tree' set_param — new value (JSON scalar or Godot literal string)."),
  playback_path: z
    .string()
    .optional()
    .describe("target:'tree' — state machine playback parameter (default 'parameters/playback'; nested machines use 'parameters/<Node>/playback')."),
  bones: z
    .array(z.string())
    .optional()
    .describe("target:'bones' — bone names to read (omit for the first 256; page larger rigs with this filter)."),
  space: z
    .enum(["global", "local", "both"])
    .optional()
    .describe("target:'bones' — 'global' (default, skeleton-space global_pose), 'local' (pose), or 'both'."),
  include_rest: z.boolean().optional().describe("target:'bones' — also return each bone's rest Transform3D."),
  instance: instanceSchema,
});

export type RuntimeAnimateArgs = z.infer<typeof runtimeAnimateArgsSchema>;

export function buildRuntimeAnimateOp(args: RuntimeAnimateArgs): BuiltRuntimeOp {
  const path = requireRuntimePath(args.path, "path", "/root/Main/Player/AnimationPlayer");
  if (args.target === "player") {
    const cmd = args.cmd ?? "state";
    if (!(ANIMATION_PLAYER_CMDS as readonly string[]).includes(cmd)) {
      throw new ToolInputError(`cmd '${cmd}' is not an AnimationPlayer command; target:'player' accepts ${ANIMATION_PLAYER_CMDS.join("|")}.`);
    }
    if (cmd === "seek" && typeof args.position !== "number") {
      throw new ToolInputError("cmd:'seek' needs position (seconds).");
    }
    if (cmd === "speed" && typeof args.speed !== "number") {
      throw new ToolInputError("cmd:'speed' needs speed (speed_scale, 1.0 = normal).");
    }
    const op: Record<string, unknown> = { op: "RuntimeAnimation", path, cmd };
    if (typeof args.name === "string" && args.name.length > 0) op.name = args.name;
    if (typeof args.position === "number") op.position = args.position;
    if (typeof args.speed === "number") op.speed = args.speed;
    if (typeof args.from_end === "boolean") op.from_end = args.from_end;
    if (typeof args.blend === "number") op.blend = args.blend;
    if (typeof args.update === "boolean") op.update = args.update;
    return { kind: "RuntimeAnimation", op: withInstance(op, args.instance), timeoutMs: runtimeBudgetMs(RUNTIME_WATCHDOG_DEFAULT_SEC) };
  }
  if (args.target === "tree") {
    const cmd = args.cmd ?? "state";
    if (!(ANIMATION_TREE_CMDS as readonly string[]).includes(cmd)) {
      throw new ToolInputError(`cmd '${cmd}' is not an AnimationTree command; target:'tree' accepts ${ANIMATION_TREE_CMDS.join("|")}.`);
    }
    if ((cmd === "travel" || cmd === "start") && (typeof args.state !== "string" || args.state.length === 0)) {
      throw new ToolInputError(`cmd:'${cmd}' needs state (the state machine node name).`);
    }
    if ((cmd === "set_param" || cmd === "get_param") && (typeof args.param !== "string" || args.param.length === 0)) {
      throw new ToolInputError(`cmd:'${cmd}' needs param (e.g. 'parameters/Blend/blend_amount').`);
    }
    if (cmd === "set_param" && args.value === undefined) {
      throw new ToolInputError("cmd:'set_param' needs value.");
    }
    const op: Record<string, unknown> = { op: "RuntimeAnimationTree", path, cmd };
    if (typeof args.state === "string" && args.state.length > 0) op.state = args.state;
    if (typeof args.reset === "boolean") op.reset = args.reset;
    if (typeof args.param === "string" && args.param.length > 0) op.param = args.param;
    if (args.value !== undefined) op.value = args.value;
    if (typeof args.playback_path === "string" && args.playback_path.length > 0) op.playback_path = args.playback_path;
    return { kind: "RuntimeAnimationTree", op: withInstance(op, args.instance), timeoutMs: runtimeBudgetMs(RUNTIME_WATCHDOG_DEFAULT_SEC) };
  }
  if (args.target === "bones") {
    const op: Record<string, unknown> = { op: "GetRuntimeBones", path };
    if (args.bones !== undefined) {
      if (!Array.isArray(args.bones) || args.bones.some((bone) => typeof bone !== "string")) {
        throw new ToolInputError("bones must be an array of bone names.");
      }
      op.bones = args.bones;
    }
    if (args.space !== undefined) {
      if (args.space !== "global" && args.space !== "local" && args.space !== "both") {
        throw new ToolInputError("space must be 'global', 'local' or 'both'.");
      }
      op.space = args.space;
    }
    if (typeof args.include_rest === "boolean") op.include_rest = args.include_rest;
    return { kind: "GetRuntimeBones", op: withInstance(op, args.instance), timeoutMs: runtimeBudgetMs(RUNTIME_WATCHDOG_DEFAULT_SEC) };
  }
  throw new ToolInputError("target must be 'player', 'tree' or 'bones'.");
}

// ---------------------------------------------------------------------------
// summer_game_control — GamePause | GameStep | GameSpeed | ListGameInstances
// ---------------------------------------------------------------------------

export const gameControlArgsSchema = z.object({
  action: z
    .enum(["pause", "resume", "step", "speed", "instances"])
    .describe(
      "'pause' suspends the game (Engine time frozen, physics inactive); 'resume' lifts the suspension; 'step' advances exactly N frames and leaves the game suspended; 'speed' sets the user time scale; 'instances' lists the live game instances (main + offscreen)."
    ),
  frames: z
    .number()
    .int()
    .optional()
    .describe("action:'step' — frames to advance, 1..600 (default 1)."),
  kind: z
    .enum(["physics", "process"])
    .optional()
    .describe("action:'step' — 'physics' (default: exact physics ticks, max_physics_steps_per_frame pinned to 1) or 'process' (rendered frames)."),
  speed: z
    .number()
    .optional()
    .describe("action:'speed' — user time scale in (0, 100]: 0.25 = quarter speed, 2 = double."),
  instance: instanceSchema,
});

export type GameControlArgs = z.infer<typeof gameControlArgsSchema>;

export function buildGameControlOp(args: GameControlArgs): BuiltRuntimeOp {
  switch (args.action) {
    case "pause":
      return { kind: "GamePause", op: withInstance({ op: "GamePause", paused: true }, args.instance), timeoutMs: runtimeBudgetMs(RUNTIME_WATCHDOG_DEFAULT_SEC) };
    case "resume":
      return { kind: "GamePause", op: withInstance({ op: "GamePause", paused: false }, args.instance), timeoutMs: runtimeBudgetMs(RUNTIME_WATCHDOG_DEFAULT_SEC) };
    case "step": {
      const frames = args.frames ?? 1;
      if (!isInt(frames) || frames < 1 || frames > GAME_STEP_MAX_FRAMES) {
        throw new ToolInputError(`frames must be an integer 1..${GAME_STEP_MAX_FRAMES} (got ${String(args.frames)}).`);
      }
      const kind = args.kind ?? "physics";
      if (kind !== "physics" && kind !== "process") {
        throw new ToolInputError("kind must be 'physics' (default) or 'process'.");
      }
      // Engine watchdog: max(10 s, frames / 10 s), capped at 20 s.
      const watchdogSec = Math.min(RUNTIME_WATCHDOG_MAX_SEC, Math.max(RUNTIME_WATCHDOG_DEFAULT_SEC, frames / 10));
      return { kind: "GameStep", op: withInstance({ op: "GameStep", frames, kind }, args.instance), timeoutMs: runtimeBudgetMs(watchdogSec) };
    }
    case "speed": {
      const speed = args.speed;
      if (typeof speed !== "number" || !Number.isFinite(speed) || speed <= 0 || speed > 100) {
        throw new ToolInputError("speed must be a number in (0, 100] — e.g. 0.25 for quarter speed, 2 for double.");
      }
      return { kind: "GameSpeed", op: withInstance({ op: "GameSpeed", speed }, args.instance), timeoutMs: runtimeBudgetMs(RUNTIME_WATCHDOG_DEFAULT_SEC) };
    }
    case "instances":
      // Synchronous editor read; `instance` does not apply.
      return { kind: "ListGameInstances", op: { op: "ListGameInstances" }, timeoutMs: runtimeBudgetMs(RUNTIME_WATCHDOG_DEFAULT_SEC) };
    default:
      throw new ToolInputError("action must be 'pause', 'resume', 'step', 'speed' or 'instances'.");
  }
}

// ---------------------------------------------------------------------------
// summer_game_input — SimulateInputScript | InputRecordStart | InputRecordStop | InputReplay
// ---------------------------------------------------------------------------

export const inputEventSchema = z.object({
  at_frame: z
    .number()
    .int()
    .optional()
    .describe("When to fire, in frames after scheduling (clock:'frame'). Default 0 = the next frame."),
  at_ms: z
    .number()
    .int()
    .optional()
    .describe("When to fire, in milliseconds after scheduling (clock:'ms'); mapped through --fixed-fps when the instance has one (clock_mapping 'exact'), else the physics tick rate ('approximate')."),
  type: z
    .enum(["action", "key", "mouse_click", "axis", "raw"])
    .describe("'action' = InputMap action press/release; 'key' = keycode; 'mouse_click' = click at a position; 'axis' = analog strength between two actions; 'raw' = a recorded InputEvent replayed as {class, props}."),
  action: z.string().optional().describe("type:'action' — InputMap action name (unknown_action if not bound)."),
  pressed: z.boolean().optional().describe("type:'action'|'key' — press (default true) or release."),
  strength: z.number().optional().describe("type:'action' — press strength 0..1 (default 1). type:'axis' — signed strength; negative selects action_negative."),
  hold_ms: z.number().int().optional().describe("type:'action'|'key' — auto-release after this many ms (0 = stays pressed until a release event)."),
  keycode: z.number().int().optional().describe("type:'key' — Godot Key enum value (e.g. 32 = Space, 4194320 = Right arrow)."),
  physical_keycode: z.number().int().optional().describe("type:'key' — physical Key enum value (alternative to keycode)."),
  position: z
    .tuple([z.number(), z.number()])
    .optional()
    .describe("type:'mouse_click' — [x, y] in window pixels."),
  button: z.number().int().optional().describe("type:'mouse_click' — MouseButton (1 = left, 2 = right, 3 = middle)."),
  action_negative: z.string().optional().describe("type:'axis' — action for negative strength (e.g. 'move_left')."),
  action_positive: z.string().optional().describe("type:'axis' — action for positive strength (e.g. 'move_right')."),
  duration_ms: z.number().int().optional().describe("type:'axis' — auto-release after this many ms."),
  class: z.string().optional().describe("type:'raw' — InputEvent class to instantiate (e.g. 'InputEventKey')."),
  props: z.record(z.unknown()).optional().describe("type:'raw' — properties set on the instantiated event."),
});

export type InputEvent = z.infer<typeof inputEventSchema>;

export const gameInputArgsSchema = z.object({
  action: z
    .enum(["script", "record_start", "record_stop", "replay"])
    .describe(
      "'script' schedules a timed sequence of synthetic inputs (SimulateInputScript); 'record_start'/'record_stop' capture the game's real input into res://.summer/replays/<id>.json; 'replay' plays a recording (or inline events) back."
    ),
  events: z
    .array(inputEventSchema)
    .optional()
    .describe("action:'script' (required) or 'replay' (instead of recording) — up to 1000 timed events; last event within 36000 frames / 600 s."),
  clock: z
    .enum(["frame", "ms"])
    .optional()
    .describe("action:'script' — whether at_frame ('frame', default, exact) or at_ms ('ms') schedules the events."),
  wait: z
    .boolean()
    .optional()
    .describe("action:'script'|'replay' — wait for the last event to fire (default true; the engine caps a waited script at 20 s). Scripts longer than that: wait:false and observe with summer_game_probe."),
  include_motion: z
    .boolean()
    .optional()
    .describe("action:'record_start' — also record mouse/joypad motion events (default false; large)."),
  save_as: z
    .string()
    .optional()
    .describe("action:'record_stop' — res://.summer/replays/<name>.json to write instead of a generated id."),
  recording: z
    .string()
    .optional()
    .describe("action:'replay' — the res://.summer/replays/<id>.json path returned by record_stop."),
  seed: z
    .number()
    .int()
    .optional()
    .describe("action:'replay' — assert the replay is reproducible; only accepted on an instance started with summer_play {mode:'offscreen', deterministic:true} (else nondeterministic_instance)."),
  instance: instanceSchema,
});

export type GameInputArgs = z.infer<typeof gameInputArgsSchema>;

/** Last-event horizon in frames (at_ms mapped at 60 fps, like the engine's pre-check). */
export function inputScriptHorizonFrames(events: Array<Record<string, unknown>>): number {
  let horizon = 0;
  for (const event of events) {
    if (typeof event.at_frame === "number") horizon = Math.max(horizon, Math.floor(event.at_frame));
    else if (typeof event.at_ms === "number") horizon = Math.max(horizon, Math.floor((event.at_ms * 60) / 1000));
  }
  return horizon;
}

/** Engine watchdog for a waited script: min(20 s, max(10 s, horizon/60 + 3 s)). */
export function inputScriptWatchdogSec(horizonFrames: number, wait: boolean): number {
  if (!wait) return RUNTIME_WATCHDOG_DEFAULT_SEC;
  return Math.min(RUNTIME_WATCHDOG_MAX_SEC, Math.max(RUNTIME_WATCHDOG_DEFAULT_SEC, horizonFrames / 60 + 3));
}

function validateEvents(events: unknown, action: string): Array<Record<string, unknown>> {
  if (!Array.isArray(events) || events.length === 0) {
    throw new ToolInputError(`action:'${action}' needs a non-empty events array ([{type:'action', action:'jump', hold_ms:50}, ...]).`);
  }
  if (events.length > INPUT_SCRIPT_MAX_EVENTS) {
    throw new ToolInputError(`${events.length} events exceeds the ${INPUT_SCRIPT_MAX_EVENTS}-event cap; split the script into sequential calls.`);
  }
  events.forEach((event, index) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new ToolInputError(`events[${index}] is not an object.`);
    }
    const type = (event as Record<string, unknown>).type;
    if (typeof type !== "string" || !["action", "key", "mouse_click", "axis", "raw"].includes(type)) {
      throw new ToolInputError(`events[${index}].type must be action|key|mouse_click|axis|raw.`);
    }
  });
  const horizon = inputScriptHorizonFrames(events as Array<Record<string, unknown>>);
  if (horizon > INPUT_SCRIPT_HORIZON_FRAMES) {
    throw new ToolInputError(
      `The last event lands at frame ${horizon}, beyond the ${INPUT_SCRIPT_HORIZON_FRAMES}-frame (600 s) horizon; shorten the script or split it.`
    );
  }
  return events as Array<Record<string, unknown>>;
}

export function buildGameInputOp(args: GameInputArgs): BuiltRuntimeOp {
  switch (args.action) {
    case "script": {
      const events = validateEvents(args.events, "script");
      const clock = args.clock ?? "frame";
      if (clock !== "frame" && clock !== "ms") throw new ToolInputError("clock must be 'frame' (default) or 'ms'.");
      const wait = args.wait ?? true;
      const op: Record<string, unknown> = { op: "SimulateInputScript", events, clock, wait };
      const watchdogSec = inputScriptWatchdogSec(inputScriptHorizonFrames(events), wait);
      return { kind: "SimulateInputScript", op: withInstance(op, args.instance), timeoutMs: runtimeBudgetMs(watchdogSec) };
    }
    case "record_start": {
      const op: Record<string, unknown> = { op: "InputRecordStart" };
      if (typeof args.include_motion === "boolean") op.include_motion = args.include_motion;
      return { kind: "InputRecordStart", op: withInstance(op, args.instance), timeoutMs: runtimeBudgetMs(RUNTIME_WATCHDOG_DEFAULT_SEC) };
    }
    case "record_stop": {
      const op: Record<string, unknown> = { op: "InputRecordStop" };
      if (typeof args.save_as === "string" && args.save_as.trim().length > 0) {
        const saveAs = args.save_as.trim();
        if (!saveAs.startsWith("res://") || saveAs.includes("..")) {
          throw new ToolInputError("save_as must be a traversal-free res:// path (the engine writes under res://.summer/replays/).");
        }
        op.save_as = saveAs;
      }
      return { kind: "InputRecordStop", op: withInstance(op, args.instance), timeoutMs: runtimeBudgetMs(RUNTIME_WATCHDOG_DEFAULT_SEC) };
    }
    case "replay": {
      const hasRecording = typeof args.recording === "string" && args.recording.trim().length > 0;
      const hasEvents = Array.isArray(args.events) && args.events.length > 0;
      if (!hasRecording && !hasEvents) {
        throw new ToolInputError(
          "action:'replay' needs recording (the res://.summer/replays/<id>.json path from record_stop) or inline events."
        );
      }
      const op: Record<string, unknown> = { op: "InputReplay" };
      let horizon = 0;
      if (hasRecording) {
        const recording = args.recording!.trim();
        if (!recording.startsWith("res://")) {
          throw new ToolInputError("recording must be the res:// path record_stop returned (res://.summer/replays/<id>.json).");
        }
        op.recording = recording;
      }
      if (hasEvents) {
        const events = validateEvents(args.events, "replay");
        op.events = events;
        horizon = inputScriptHorizonFrames(events);
      }
      if (args.seed !== undefined) {
        if (!isInt(args.seed)) throw new ToolInputError("seed must be an integer.");
        op.seed = args.seed;
      }
      const wait = args.wait ?? true;
      op.wait = wait;
      // A recording's horizon is only known engine-side; budget the cap.
      const watchdogSec = hasRecording ? (wait ? RUNTIME_WATCHDOG_MAX_SEC : RUNTIME_WATCHDOG_DEFAULT_SEC) : inputScriptWatchdogSec(horizon, wait);
      return { kind: "InputReplay", op: withInstance(op, args.instance), timeoutMs: runtimeBudgetMs(watchdogSec) };
    }
    default:
      throw new ToolInputError("action must be 'script', 'record_start', 'record_stop' or 'replay'.");
  }
}

// ---------------------------------------------------------------------------
// summer_game_probe — GameProbe
// ---------------------------------------------------------------------------

export const gameProbeArgsSchema = z.object({
  tree: z
    .object({
      path: z.string().optional().describe("Subtree root, ABSOLUTE runtime path (default the scene tree root)."),
      depth: z.number().int().optional().describe("Depth to walk, 1..8 (default 2)."),
      limit: z.number().int().optional().describe("Node cap, 1..4000 (default 200); truncated is reported."),
    })
    .optional()
    .describe("Include the live scene tree ({name, class, path, children}) built game-side on the SAME frame as the pixels. Omit for no tree."),
  props: z
    .array(z.string())
    .optional()
    .describe(
      "Up to 64 '<absolute path>:<property>' keys read on the same frame, e.g. '/root/Main/Player:position'. Values come back as Godot literal strings; misses land in `missing`."
    ),
  screenshot: z
    .boolean()
    .optional()
    .describe("Capture the game viewport (default true). false = state only, cheaper and works when the window draws nothing."),
  max_dim: z
    .number()
    .int()
    .optional()
    .describe("Longest image side in pixels, 16..4096 (default 1280); the frame is downscaled to fit."),
  instance: instanceSchema,
});

export type GameProbeArgs = z.infer<typeof gameProbeArgsSchema>;

export function buildGameProbeOp(args: GameProbeArgs): BuiltRuntimeOp {
  const op: Record<string, unknown> = { op: "GameProbe" };
  if (args.tree !== undefined) {
    if (!args.tree || typeof args.tree !== "object" || Array.isArray(args.tree)) {
      throw new ToolInputError("tree must be an object {path?, depth?, limit?}.");
    }
    const tree: Record<string, unknown> = {};
    if (typeof args.tree.path === "string" && args.tree.path.trim().length > 0) tree.path = args.tree.path.trim();
    if (args.tree.depth !== undefined) {
      if (!isInt(args.tree.depth) || args.tree.depth < 1 || args.tree.depth > GAME_PROBE_MAX_DEPTH) {
        throw new ToolInputError(`tree.depth must be an integer 1..${GAME_PROBE_MAX_DEPTH}.`);
      }
      tree.depth = args.tree.depth;
    }
    if (args.tree.limit !== undefined) {
      if (!isInt(args.tree.limit) || args.tree.limit < 1 || args.tree.limit > GAME_PROBE_MAX_LIMIT) {
        throw new ToolInputError(`tree.limit must be an integer 1..${GAME_PROBE_MAX_LIMIT}.`);
      }
      tree.limit = args.tree.limit;
    }
    op.tree = tree;
  }
  if (args.props !== undefined) {
    if (!Array.isArray(args.props) || args.props.some((key) => typeof key !== "string" || !key.includes(":"))) {
      throw new ToolInputError("props must be an array of '<absolute path>:<property>' strings, e.g. '/root/Main/Player:position'.");
    }
    if (args.props.length > GAME_PROBE_MAX_PROPS) {
      throw new ToolInputError(`props is capped at ${GAME_PROBE_MAX_PROPS} keys per probe; split the read.`);
    }
    op.props = args.props;
  }
  if (typeof args.screenshot === "boolean") op.screenshot = args.screenshot;
  if (args.max_dim !== undefined) {
    if (!isInt(args.max_dim) || args.max_dim < GAME_PROBE_MIN_DIM || args.max_dim > GAME_PROBE_MAX_DIM) {
      throw new ToolInputError(`max_dim must be an integer ${GAME_PROBE_MIN_DIM}..${GAME_PROBE_MAX_DIM}.`);
    }
    op.max_dim = args.max_dim;
  }
  return { kind: "GameProbe", op: withInstance(op, args.instance), timeoutMs: runtimeBudgetMs(RUNTIME_PROBE_WATCHDOG_SEC) };
}

/** The GameProbe result inside an ops envelope (or the bare op result). */
export function findProbePayload(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  if (record.op === "GameProbe") return record;
  if (Array.isArray(record.results)) {
    for (const entry of record.results) {
      if (entry && typeof entry === "object" && (entry as Record<string, unknown>).op === "GameProbe") {
        return entry as Record<string, unknown>;
      }
    }
    const first = record.results[0];
    if (first && typeof first === "object") return first as Record<string, unknown>;
  }
  return null;
}

/** The same envelope with the image bytes removed (for text rendering and logs). */
export function stripProbeImage(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const record = result as Record<string, unknown>;
  const strip = (entry: unknown): unknown => {
    if (!entry || typeof entry !== "object") return entry;
    const { image_base64: _dropped, ...rest } = entry as Record<string, unknown>;
    return rest;
  };
  if (Array.isArray(record.results)) {
    return { ...(strip(record) as Record<string, unknown>), results: record.results.map(strip) };
  }
  return strip(record);
}

/** One-line frame stamp for a probe payload: which frame the state and the
 *  pixels describe, so a claim can cite it. */
export function probeFrameStamp(payload: Record<string, unknown>): string {
  const frame = (payload.frame ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof frame.process_frames === "number") parts.push(`frame ${frame.process_frames}`);
  if (typeof frame.physics_frames === "number") parts.push(`physics ${frame.physics_frames}`);
  if (typeof frame.frames_drawn === "number") parts.push(`drawn ${frame.frames_drawn}`);
  if (typeof payload.image_frame === "number") parts.push(`image_frame ${payload.image_frame}`);
  if (typeof payload.instance === "string") parts.push(`instance ${payload.instance}`);
  if (payload.suspended === true) parts.push("SUSPENDED");
  if (payload.paused === true) parts.push("SceneTree.paused");
  if (typeof payload.time_scale === "number" && payload.time_scale !== 1) parts.push(`time_scale ${payload.time_scale}`);
  return parts.length > 0 ? parts.join(", ") : "frame unknown";
}

// ---------------------------------------------------------------------------
// summer_play / summer_stop — instance-aware PlayGame / StopGame
// ---------------------------------------------------------------------------

export const playGameExtensionSchema = {
  instance: z
    .string()
    .optional()
    .describe("Name a game instance. 'main' (default) = the editor's embedded game. Any other name with mode:'offscreen' spawns a disposable parallel instance (at most 3) that the runtime tools address by this name."),
  mode: z
    .enum(["embedded", "offscreen"])
    .optional()
    .describe("'embedded' (default) plays in the editor; 'offscreen' spawns a hidden child process (requires instance != 'main')."),
  deterministic: z
    .boolean()
    .optional()
    .describe("Offscreen only: launch with --fixed-fps 60 --summer-seed <seed> --audio-driver Dummy so the run is reproducible and input replays with seed are accepted."),
  seed: z
    .number()
    .int()
    .optional()
    .describe(
      "Pin the game's GLOBAL RNG for this launch (child gets --summer-seed <seed>; default 20260725 when deterministic:true and seed is omitted). Pins randi/randf/randi_range/randf_range/randfn, Array.shuffle/pick_random. Does NOT pin RandomNumberGenerator instances, scripts calling randomize(), or wall-clock reads. Omitted = randomized, as always."
    ),
  fixed_fps: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Fixed timestep for this launch (child gets --fixed-fps <n>): scene time decouples from the wall clock, the game runs as fast as it renders, frame-count-derived state repeats run to run, and at_ms input timing / GameStep frames map exactly. Opt-in per launch, never the default."
    ),
  time_scale: z
    .number()
    .positive()
    .optional()
    .describe("Engine time scale for this launch (child gets --time-scale <f>). Not a determinism pin on its own."),
  speed: z
    .number()
    .optional()
    .describe("User time scale applied on session start, (0, 100] — e.g. 0.5 for half speed."),
  focus: z
    .boolean()
    .optional()
    .describe(
      "Default false = QUIET play (PlayGame agent:true): the editor does not switch to the Game tab or grab focus for the embedded game, so the user keeps working. Pass true to launch the way the toolbar Play button does (Game tab + focus) — only when the user is watching and asked to see it."
    ),
};

export interface PlayGameArgs {
  scene?: string;
  instance?: string;
  mode?: "embedded" | "offscreen";
  deterministic?: boolean;
  seed?: number;
  fixed_fps?: number;
  time_scale?: number;
  speed?: number;
  /** true = today's toolbar-style launch (Game tab + focus). Absent/false = quiet. */
  focus?: boolean;
}

/**
 * Quiet is the default whenever an agent drives play — both faces of this tool
 * (MCP and `summer tool`) ARE agent faces, so the only way to a focus-stealing
 * launch is an explicit focus:true. Quiet travels as PlayGame `agent:true`
 * (debug_ops.cpp play_game -> GameView::set_agent_quiet_play), which the engine
 * has honoured since 0.5.45 (c7c490d84f3, 2026-07-02).
 */
export function playIsQuiet(args: PlayGameArgs): boolean {
  return args.focus !== true;
}

/** True when the call needs the PlayGame OP (instance-aware / determinism
 *  params) rather than the legacy /api/play route, which forwards only `scene`. */
export function playNeedsOp(args: PlayGameArgs): boolean {
  return (
    // The /api/play rung builds a PlayGame op with ONLY `scene`
    // (local_api_server.cpp play branch), so `agent:true` has to ride the op.
    playIsQuiet(args) ||
    (typeof args.instance === "string" && args.instance.trim().length > 0) ||
    args.mode !== undefined ||
    args.deterministic !== undefined ||
    args.seed !== undefined ||
    args.fixed_fps !== undefined ||
    args.time_scale !== undefined ||
    args.speed !== undefined
  );
}

/** True when the call addresses a non-main instance or an offscreen mode —
 *  the part of PlayGame that only a Wave I engine understands. */
export function playTargetsInstance(args: PlayGameArgs): boolean {
  const instance = typeof args.instance === "string" ? args.instance.trim() : "";
  return (instance.length > 0 && instance !== "main") || args.mode === "offscreen";
}

export function buildPlayGameOp(args: PlayGameArgs): BuiltRuntimeOp {
  const instance = typeof args.instance === "string" ? args.instance.trim() : "";
  if (args.mode !== undefined && args.mode !== "embedded" && args.mode !== "offscreen") {
    throw new ToolInputError("mode must be 'embedded' (default) or 'offscreen'.");
  }
  if (args.mode === "offscreen" && (instance.length === 0 || instance === "main")) {
    throw new ToolInputError(
      "mode:'offscreen' needs an instance name other than 'main' (the main slot is the editor's embedded game), e.g. instance:'a'."
    );
  }
  if (instance.length > 0 && instance !== "main" && args.mode !== "offscreen") {
    throw new ToolInputError(
      `instance:'${instance}' needs mode:'offscreen' — only the 'main' instance plays embedded in the editor.`
    );
  }
  if (args.deterministic === true && args.mode !== "offscreen") {
    throw new ToolInputError(
      "deterministic:true is offscreen-only (it launches a child with --fixed-fps 60 --summer-seed --audio-driver Dummy). Pass instance + mode:'offscreen', or use seed/fixed_fps alone for the embedded game."
    );
  }
  if (args.seed !== undefined && !isInt(args.seed)) throw new ToolInputError("seed must be an integer.");
  if (args.fixed_fps !== undefined && (!isInt(args.fixed_fps) || args.fixed_fps <= 0)) {
    throw new ToolInputError("fixed_fps must be an integer > 0.");
  }
  if (args.time_scale !== undefined && (typeof args.time_scale !== "number" || !Number.isFinite(args.time_scale) || args.time_scale <= 0)) {
    throw new ToolInputError("time_scale must be a number > 0.");
  }
  if (args.speed !== undefined && (typeof args.speed !== "number" || !Number.isFinite(args.speed) || args.speed <= 0 || args.speed > 100)) {
    throw new ToolInputError("speed must be a number in (0, 100].");
  }
  const op: Record<string, unknown> = { op: "PlayGame" };
  if (typeof args.scene === "string" && args.scene.trim().length > 0) op.scene = args.scene.trim();
  // Quiet concerns the editor's embedded Game view only; an offscreen
  // instance is a hidden child and never touches the editor's tab or focus.
  if (playIsQuiet(args) && !playTargetsInstance(args)) op.agent = true;
  if (instance.length > 0) op.instance = instance;
  if (args.mode !== undefined) op.mode = args.mode;
  if (args.deterministic !== undefined) op.deterministic = args.deterministic;
  if (args.seed !== undefined) op.seed = args.seed;
  if (args.fixed_fps !== undefined) op.fixed_fps = args.fixed_fps;
  if (args.time_scale !== undefined) op.time_scale = args.time_scale;
  if (args.speed !== undefined) op.speed = args.speed;
  return { kind: "PlayGame", op, timeoutMs: PLAY_INSTANCE_TIMEOUT_MS };
}

export function buildStopGameOp(instance: string): BuiltRuntimeOp {
  const trimmed = instance.trim();
  if (trimmed.length === 0) throw new ToolInputError("instance must be a non-empty instance name.");
  return { kind: "StopGame", op: { op: "StopGame", instance: trimmed }, timeoutMs: STOP_INSTANCE_TIMEOUT_MS };
}

/**
 * An engine that predates instance-aware PlayGame ignores `instance`/`mode`
 * and starts the MAIN embedded game. When the caller asked for an instance
 * and the result does not echo one, say so instead of letting the model
 * believe a parallel instance is up.
 */
export function withPlayInstanceEcho(result: unknown, args: PlayGameArgs): unknown {
  if (!playTargetsInstance(args) || !result || typeof result !== "object") return result;
  if (extractOpError(result)) return result;
  const envelope = result as Record<string, unknown> & { results?: Array<Record<string, unknown>> };
  const payload = envelope.results?.[0] ?? envelope;
  if (typeof payload.instance === "string") return result;
  return {
    ...envelope,
    warning:
      `This Summer Engine build did not echo \`instance\` in its PlayGame result — it predates instance-aware play and has most likely started the MAIN embedded game, ignoring instance:'${args.instance ?? ""}' / mode:'${args.mode ?? "embedded"}'. Verify with summer_is_running or summer_game_control action:'instances' before addressing that instance, and update Summer Engine for parallel instances.`,
  };
}

export const PLAY_QUIET_NOT_SUPPORTED =
  "This Summer Engine build did not echo `agent_quiet` in its PlayGame result — it predates quiet play and has most likely switched the editor to the Game tab and taken focus. Update Summer Engine (restart it after updating) for launches that leave the user's screen alone.";

/**
 * Quiet was requested: the engine echoes `agent_quiet` when it understood the
 * flag (debug_ops.cpp play_game — in the launch branch AND the already-running
 * branch on current engines). No echo at all means an engine that predates
 * the flag ignored it — say so instead of letting the model believe the user
 * was left alone. The field is the contract; the `note` text is never matched.
 */
export function withPlayPostureEcho(result: unknown, args: PlayGameArgs): unknown {
  if (!playIsQuiet(args) || playTargetsInstance(args) || !result || typeof result !== "object") return result;
  if (extractOpError(result)) return result;
  const envelope = result as Record<string, unknown> & { results?: Array<Record<string, unknown>> };
  const payload = envelope.results?.[0] ?? envelope;
  if (typeof payload.agent_quiet === "boolean") return result;
  return { ...envelope, posture_note: PLAY_QUIET_NOT_SUPPORTED };
}

/** The subset of EngineApiClient summer_play drives. Structural so tests can
 *  pass bare fakes; the capability getters come from CapabilityAdvertisingClient. */
export interface PlayGameClient extends CapabilityAdvertisingClient {
  play(scene?: string): Promise<unknown>;
  executeOps(ops: Array<Record<string, unknown>>, options?: undefined, timeoutMs?: number): Promise<unknown>;
}

/**
 * summer_play, ONE implementation for both faces (MCP debug-tools.ts and the
 * CLI dispatcher). Throws ToolInputError for a bad parameter combination
 * (nothing sent); returns the engine envelope, a structured engine_lacks_op
 * pre-flight result, or the envelope with the old-engine / posture / instance
 * annotations. Each face only decides how to RENDER failures.
 *
 * Routing: focus:true with no other parameter is the legacy /api/play route,
 * byte-for-byte the v1 call. Everything else — including the quiet default —
 * travels as the explicit PlayGame op, because the /api/play rung copies only
 * `scene` into the op and would drop agent/seed/instance.
 */
export async function playGame(client: PlayGameClient, args: PlayGameArgs): Promise<unknown> {
  if (!playNeedsOp(args)) return client.play(args.scene);
  // Validate the combination first (nothing sent); then, because an engine
  // without the runtime-control wave would start the MAIN game and silently
  // ignore instance/mode, the pre-flight keys on a Wave I kind.
  const { op, timeoutMs } = buildPlayGameOp(args);
  if (playTargetsInstance(args)) {
    const missing = missingEngineOpResult(client, "ListGameInstances", PLAY_INSTANCE_FALLBACK);
    if (missing) return missing;
  }
  const result = await client.executeOps([op], undefined, timeoutMs);
  return withPlayPostureEcho(
    withPlayInstanceEcho(withRuntimeFailureHints(withOldEngineHint(result, "PlayGame", PLAY_INSTANCE_FALLBACK)), args),
    args
  );
}
