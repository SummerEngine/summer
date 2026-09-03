import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withEngine, missingEngineOpResult, withOldEngineHint } from "./with-engine.js";
import {
  RUNTIME_FALLBACKS,
  buildGameControlOp,
  buildGameInputOp,
  buildGameProbeOp,
  buildRuntimeAnimateOp,
  buildRuntimeCallOp,
  buildRuntimeSetOp,
  buildRuntimeSpawnOp,
  findProbePayload,
  gameControlArgsSchema,
  gameInputArgsSchema,
  gameProbeArgsSchema,
  probeFrameStamp,
  runtimeAnimateArgsSchema,
  runtimeCallArgsSchema,
  runtimeSetArgsSchema,
  runtimeSpawnArgsSchema,
  stripProbeImage,
  withRuntimeFailureHints,
  type BuiltRuntimeOp,
} from "../../core/capabilities/runtime-control.js";

/**
 * Runtime control & playtest tools (engine Wave I): see and touch the RUNNING
 * game. Seven tools over sixteen engine op kinds; the argument contracts, op
 * builders, budgets and failure hints live in core/capabilities/runtime-control.ts
 * and are shared with the CLI face (`summer tool …`).
 *
 * Every op here is async single-only on the engine (a debugger round-trip
 * needs the reply channel) and is sent as the ONLY op in its request with a
 * budget that outlives the engine's own watchdog. Two layers cover an older
 * engine: the capability pre-flight (nothing is sent when /api/health PROVES
 * the op is missing) and the post-hoc rewrite of the per-op "unknown op"
 * answer into the same engine_lacks_op result.
 */

const LOOP =
  "THE LOOP: summer_play (add instance + mode:'offscreen' for a disposable instance; deterministic:true + seed for a reproducible run; fixed_fps for exact timing) -> wait for boot (summer_is_running, or summer_game_control action:'instances' showing attached:true) -> summer_game_probe BEFORE (frame-stamped state + pixels) -> act (summer_runtime_set / summer_runtime_call / summer_game_input) -> summer_game_control action:'step' for exact frames, or let it run -> summer_game_probe AFTER -> assert on the two probes. Never claim something moved, spawned or fired without a probe that shows it.";

const RUNNING_GAME_GATES =
  "Needs a RUNNING game: failure_reason game_not_running (summer_play first), request_failed (debug session still attaching — wait, retry), unknown_instance (summer_game_control action:'instances'), game_breaked (the game sits at a breakpoint — continue it first), timeout (game wedged, minimized or breaked — summer_get_debugger_errors, or summer_stop + summer_play), unsupported (the running game predates the summer capture; restart it after updating). All runtime paths are ABSOLUTE ('/root/Main/Player') and come from summer_game_probe tree / summer_get_runtime_tree.";

/** Send one runtime op with pre-flight, budget, and hints on both failure classes. */
async function runRuntimeOp(
  client: Parameters<Parameters<typeof withEngine>[0]>[0],
  built: BuiltRuntimeOp,
  extraHints: Record<string, string> = {}
): Promise<unknown> {
  const fallback = RUNTIME_FALLBACKS[built.kind] ?? "use a RunVerification probe";
  const missing = missingEngineOpResult(client, built.kind, fallback);
  if (missing) return missing;
  const result = await client.executeOps([built.op], undefined, built.timeoutMs);
  return withRuntimeFailureHints(withOldEngineHint(result, built.kind, fallback), extraHints);
}

export function registerRuntimeTools(server: McpServer): void {
  server.tool(
    "summer_runtime_set",
    `Set ONE property on a node in the RUNNING game — the live object, never the scene file (nothing is saved; the change dies with the run). Use it to put the game into the state you want to test without playing there by hand: teleport the player ('/root/Main/Player' position 'Vector3(0, 2, 0)'), set health to 1, flip a flag, toggle visibility.

Returns {path, property, value_before, value_after, applied, transport, frame}. READ applied: false means the read-back did not match (failure_reason not_applied) — a script rewrites the value every frame, or the literal type was wrong. Math values in and out are Godot literal strings ('Vector3(1, 2, 3)'); 'script' and 'owner' are refused. For a persistent change edit the EDITED scene (summer_set_prop) and restart.

${LOOP}

${RUNNING_GAME_GATES} On an engine build that predates SetRuntimeProp the result is a structured engine_lacks_op failure naming the fallback.`,
    runtimeSetArgsSchema.shape,
    async (args) => withEngine(async (client) => runRuntimeOp(client, buildRuntimeSetOp(args)))
  );

  server.tool(
    "summer_runtime_call",
    `Call ONE method on a node in the RUNNING game and get its return value: 'take_damage' [25], 'get_velocity', 'has_method', 'start_wave' [3]. The direct way to trigger gameplay code and read its answer without wiring input or waiting for a timer.

Returns {path, method, return, return_type, return_truncated, frame}; return is a Godot literal string for math values. Arguments are JSON scalars/arrays/objects or Godot literal strings ('Vector3(0, 1, 0)'); Object/RID arguments are refused (bad_args). failure_reason call_error carries call_error_detail (the method raised); method_not_found means check summer_api_docs / the node's script.

Calling a method is an ACTION, not evidence: probe after it (summer_game_probe) to see what it did. ${RUNNING_GAME_GATES} engine_lacks_op on an older build names the fallback; a game whose build predates the summer capture answers unsupported (no legacy fallback carries a return value).`,
    runtimeCallArgsSchema.shape,
    async (args) => withEngine(async (client) => runRuntimeOp(client, buildRuntimeCallOp(args)))
  );

  server.tool(
    "summer_runtime_spawn",
    `Spawn a PackedScene into the RUNNING game (action:'spawn' — SpawnRuntimeScene) or free a live node (action:'free' — FreeRuntimeNode). Stage a test in seconds: drop three goblins under '/root/Main/Enemies' with props {position: 'Vector3(4, 0, -2)', health: 10}, or remove the boss to test the empty-arena path. Nothing touches the scene file.

spawn returns {node: {path, class}, renamed_to?, prop_warnings[], frame} — use node.path (absolute) for follow-up set/call/probe; unknown props land in prop_warnings, they never fail the spawn. free returns {path, queued, freed}: mode 'queue_free' (default) frees at the end of the frame, so a probe on the SAME frame may still list the node — step one frame (summer_game_control action:'step') before asserting it is gone; 'free' is immediate. The scene root cannot be freed (refused_root).

${LOOP}

${RUNNING_GAME_GATES} engine_lacks_op on an older build names the fallback (summer_instantiate_scene / summer_remove_node in the EDITED scene, then restart).`,
    runtimeSpawnArgsSchema.shape,
    async (args) => withEngine(async (client) => runRuntimeOp(client, buildRuntimeSpawnOp(args)))
  );

  server.tool(
    "summer_runtime_animate",
    `Drive and read animation in the RUNNING game. target:'player' = an AnimationPlayer (cmd state|play|pause|stop|seek|speed — RuntimeAnimation); target:'tree' = an AnimationTree state machine (cmd state|travel|start|stop|set_param|get_param — RuntimeAnimationTree); target:'bones' = a Skeleton3D's live bone poses (GetRuntimeBones, read-only). Default cmd is 'state' (read-only), so the same tool answers "which clip is playing", "which state is the machine in" and "where is the hand bone" before and after an action.

player returns state {current_animation, assigned_animation, position, length, speed_scale, playing, animations[]}. tree returns state {active, current_node, travel_path, playing, position, length, fading_from, parameters{}}. bones returns {skeleton: {path, bone_count, motion_scale}, bones[{idx, name, parent, global_pose{origin, rotation, scale} | pose | rest}], truncated} — at most 256 bones per call; filter with bones[] to page larger rigs. unknown_animation / unknown_state / unknown_bone list the valid names in the error.

Animation is motion: one 'state' read proves a clip is assigned, not that it moves. Prove motion with summer_game_control action:'step' between two reads (position advances, bone poses change) or two summer_game_probe frames. ${RUNNING_GAME_GATES} target:'bones' and cmd:'state' still answer while the game is breaked; the mutating cmds do not. engine_lacks_op on an older build names the fallback.`,
    runtimeAnimateArgsSchema.shape,
    async (args) => withEngine(async (client) => runRuntimeOp(client, buildRuntimeAnimateOp(args)))
  );

  server.tool(
    "summer_game_control",
    `Control the clock of the RUNNING game and list instances. action:'pause' suspends it (GamePause — Engine time frozen, physics inactive; SceneTree.paused untouched), 'resume' lifts the suspension, 'step' advances EXACTLY frames (1..600) of kind 'physics' (default) or 'process' and leaves the game suspended (GameStep), 'speed' sets the user time scale (GameSpeed, 0.25 = quarter speed), 'instances' lists every live game instance (ListGameInstances: name, mode, pid, attached, breaked, scene, seed, fixed_fps, deterministic, summer_capture).

Frame stepping is how you make exact assertions: pause -> summer_game_probe -> act -> step 1 -> probe; the step result reports before/after frame counters, exact, overshoot, and draws the last stepped frame before replying so the following probe shows it. A minimized game window draws no frames and cannot step (timeout). step and pause answer game_breaked while the game sits at a breakpoint. GameSpeed rides a no-reply channel: acknowledged:false means the engine could not read the new time_scale back (older game build) — verify with summer_game_probe time_scale.

'instances' is also the boot check after summer_play {instance, mode:'offscreen'}: address an instance only once attached:true (before that the ops answer request_failed). ${LOOP}

${RUNNING_GAME_GATES} On an engine build that predates these ops the result is a structured engine_lacks_op failure; the fallback for exact frames is a RunVerification probe awaiting physics_frame N times.`,
    gameControlArgsSchema.shape,
    async (args) => withEngine(async (client) => runRuntimeOp(client, buildGameControlOp(args)))
  );

  server.tool(
    "summer_game_input",
    `Drive the RUNNING game's input like a player would. action:'script' schedules up to 1000 timed synthetic events (SimulateInputScript): [{at_frame: 0, type:'action', action:'move_right', hold_ms: 500}, {at_frame: 30, type:'action', action:'jump', hold_ms: 50}]; types action | key (keycode / physical_keycode) | mouse_click (position [x,y], button) | axis (action_negative/action_positive, signed strength) | raw ({class, props} — a recorded InputEvent). clock 'frame' (at_frame, exact) or 'ms' (at_ms — exact only when the instance runs with fixed_fps, else approximate; the result reports clock_mapping). action:'record_start' / 'record_stop' capture the game's REAL input into res://.summer/replays/<id>.json (InputRecordStart/Stop — cap 20,000 events / ~1 MiB, truncated:true when hit); action:'replay' plays a recording (or inline events) back (InputReplay), with seed asserting reproducibility on a deterministic offscreen instance.

script returns {scheduled, applied, rejected[{index, failure_reason, error}], first_frame, last_frame, completed, clock_mapping}; per-event rejections (unknown_action: not in the project InputMap — summer_input_map_bind, or use type:'key') are non-fatal unless all_rejected. ONE script in flight per instance: a second call answers busy — wait for the first. wait:true (default) blocks until the last event fires but the engine caps it at 20 s; a longer script uses wait:false and observes with summer_game_probe. replay returns the same shape plus {recording, deterministic}; seed on an instance not started with summer_play {mode:'offscreen', deterministic:true} answers nondeterministic_instance.

Scripts vs recordings: a script is the readable, editable repro you write from the spec; a recording is the exact repro of what a human (or a script) actually did — replay it on a deterministic instance for an A/B under identical inputs. Input is an ACTION: prove what it caused with summer_game_probe before/after (or summer_game_control action:'step' for the exact frame). ${LOOP}

${RUNNING_GAME_GATES} engine_lacks_op on an older build names the fallback (single SimulateInput ops via summer_batch, or a RunVerification probe's press()/key()).`,
    gameInputArgsSchema.shape,
    async (args) => withEngine(async (client) => runRuntimeOp(client, buildGameInputOp(args)))
  );

  server.tool(
    "summer_game_probe",
    `State AND pixels of ONE frame of the RUNNING game, atomically (GameProbe): the live scene tree (tree {path, depth, limit}), up to 64 property reads (props ['/root/Main/Player:position', '/root/Main/HUD/Health:value']) and a screenshot of the game viewport, all stamped with the SAME frame counters. This is the evidence tool of the playtest loop — the only read where "what the tree says" and "what the screen shows" cannot come from different moments.

You SEE the screenshot as an image block; the text block carries the frame stamp ({frame: {process_frames, physics_frames, frames_drawn}, image_frame, suspended, paused, time_scale}), values {key: Godot literal string}, missing[] (keys that did not resolve — a typo or a node that is gone), tree/total_nodes/truncated. Two probes around an action are a claim's proof: cite both frame numbers. screenshot:false is the cheap state-only read (works when the window draws nothing). max_dim (default 1280) bounds the image. Unlike summer_screenshot target:'game', the capture happens game-side, so it works for offscreen and floating instances.

${LOOP}

${RUNNING_GAME_GATES} A probe still answers while the game is breaked. On an engine build that predates GameProbe the result is a structured engine_lacks_op failure; fall back to summer_get_runtime_tree + summer_screenshot target:'game' (two calls, two frames).`,
    gameProbeArgsSchema.shape,
    async (args) =>
      withEngine(async (client) => runRuntimeOp(client, buildGameProbeOp(args)), {
        toContent: (result) => {
          const payload = findProbePayload(result);
          const text = JSON.stringify(stripProbeImage(result), null, 2);
          const image = payload && typeof payload.image_base64 === "string" ? payload.image_base64 : null;
          if (!payload || !image) {
            return [{ type: "text", text }];
          }
          const dims =
            typeof payload.width === "number" && typeof payload.height === "number"
              ? `${payload.width}x${payload.height}`
              : "unknown size";
          const caption =
            `Game probe — ${probeFrameStamp(payload)} (${dims}). The image above and the state below describe this ONE frame; ` +
            "review the image and describe what you actually see before claiming anything about it.\n\n" +
            text;
          return [
            { type: "image", data: image, mimeType: typeof payload.mime === "string" ? payload.mime : "image/jpeg" },
            { type: "text", text: caption },
          ];
        },
      })
  );
}
