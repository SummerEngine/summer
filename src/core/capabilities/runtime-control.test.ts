import { describe, expect, it } from "vitest";
import { ToolInputError } from "../tool-errors.js";
import {
  GAME_STEP_MAX_FRAMES,
  INPUT_SCRIPT_MAX_EVENTS,
  PLAY_INSTANCE_TIMEOUT_MS,
  RUNTIME_ASYNC_OP_KINDS,
  RUNTIME_CLIENT_HEADROOM_MS,
  RUNTIME_CONTROL_OP_KINDS,
  RUNTIME_FALLBACKS,
  RUNTIME_FAILURE_HINTS,
  buildGameControlOp,
  buildGameInputOp,
  buildGameProbeOp,
  buildPlayGameOp,
  buildRuntimeAnimateOp,
  buildRuntimeCallOp,
  buildRuntimeSetOp,
  buildRuntimeSpawnOp,
  buildStopGameOp,
  findProbePayload,
  playGame,
  playIsQuiet,
  playNeedsOp,
  playTargetsInstance,
  probeFrameStamp,
  runtimeBudgetMs,
  stripProbeImage,
  withPlayInstanceEcho,
  withPlayPostureEcho,
  withRuntimeFailureHints,
  PLAY_QUIET_NOT_SUPPORTED,
} from "./runtime-control.js";
import { vi } from "vitest";

describe("op kind tables", () => {
  it("names the fifteen async kinds plus ListGameInstances, each with a fallback", () => {
    expect(RUNTIME_ASYNC_OP_KINDS).toHaveLength(15);
    expect(RUNTIME_CONTROL_OP_KINDS).toHaveLength(16);
    expect(RUNTIME_CONTROL_OP_KINDS).toContain("ListGameInstances");
    expect(RUNTIME_ASYNC_OP_KINDS).not.toContain("ListGameInstances");
    for (const kind of RUNTIME_CONTROL_OP_KINDS) {
      expect(RUNTIME_FALLBACKS[kind], kind).toBeTruthy();
    }
  });

  it("budgets always outlive the engine watchdog", () => {
    expect(runtimeBudgetMs(10)).toBe(10_000 + RUNTIME_CLIENT_HEADROOM_MS);
    expect(runtimeBudgetMs(20)).toBeGreaterThan(20_000);
  });
});

describe("buildRuntimeSetOp", () => {
  it("sends path/property/value and only includes instance when given", () => {
    const plain = buildRuntimeSetOp({ path: "/root/Main/Player", property: "position", value: "Vector3(0, 2, 0)" });
    expect(plain).toEqual({
      kind: "SetRuntimeProp",
      op: { op: "SetRuntimeProp", path: "/root/Main/Player", property: "position", value: "Vector3(0, 2, 0)" },
      timeoutMs: 25_000,
    });
    const scoped = buildRuntimeSetOp({ path: "/root/Main/Player", property: "health", value: 1, field: "x", instance: " b " });
    expect(scoped.op).toEqual({ op: "SetRuntimeProp", path: "/root/Main/Player", property: "health", value: 1, field: "x", instance: "b" });
  });

  it("refuses a missing path or value before anything is sent", () => {
    expect(() => buildRuntimeSetOp({ path: "", property: "x", value: 1 })).toThrow(ToolInputError);
    expect(() => buildRuntimeSetOp({ path: "/root/A", property: "x", value: undefined as never })).toThrow(/value is required/);
  });
});

describe("buildRuntimeCallOp", () => {
  it("passes args verbatim", () => {
    const built = buildRuntimeCallOp({ path: "/root/Main/Boss", method: "take_damage", args: [25, "Vector3(0, 1, 0)"], instance: "a" });
    expect(built.kind).toBe("CallRuntimeMethod");
    expect(built.op).toEqual({ op: "CallRuntimeMethod", path: "/root/Main/Boss", method: "take_damage", args: [25, "Vector3(0, 1, 0)"], instance: "a" });
  });
});

describe("buildRuntimeSpawnOp", () => {
  it("routes action:'spawn' to SpawnRuntimeScene and action:'free' to FreeRuntimeNode", () => {
    const spawn = buildRuntimeSpawnOp({ action: "spawn", parent: "/root/Main/Enemies", scene: "res://goblin.tscn", name: "G", props: { health: 10 } });
    expect(spawn.kind).toBe("SpawnRuntimeScene");
    expect(spawn.op).toEqual({ op: "SpawnRuntimeScene", parent: "/root/Main/Enemies", scene: "res://goblin.tscn", name: "G", props: { health: 10 } });
    const free = buildRuntimeSpawnOp({ action: "free", path: "/root/Main/Enemies/G", mode: "free", instance: "a" });
    expect(free.kind).toBe("FreeRuntimeNode");
    expect(free.op).toEqual({ op: "FreeRuntimeNode", path: "/root/Main/Enemies/G", mode: "free", instance: "a" });
  });

  it("refuses spawn without a res:// scene and free without a path", () => {
    expect(() => buildRuntimeSpawnOp({ action: "spawn", parent: "/root/Main", scene: "goblin.tscn" })).toThrow(/res:\/\//);
    expect(() => buildRuntimeSpawnOp({ action: "free" })).toThrow(/path is required/);
  });
});

describe("buildRuntimeAnimateOp", () => {
  it("routes target to the three kinds with cmd defaulting to state", () => {
    expect(buildRuntimeAnimateOp({ target: "player", path: "/root/P/Anim" }).op).toEqual({ op: "RuntimeAnimation", path: "/root/P/Anim", cmd: "state" });
    expect(buildRuntimeAnimateOp({ target: "tree", path: "/root/P/Tree", cmd: "travel", state: "Attack", reset: false }).op).toEqual({
      op: "RuntimeAnimationTree", path: "/root/P/Tree", cmd: "travel", state: "Attack", reset: false,
    });
    expect(buildRuntimeAnimateOp({ target: "bones", path: "/root/P/Skel", bones: ["Hand.L"], space: "both", instance: "a" }).op).toEqual({
      op: "GetRuntimeBones", path: "/root/P/Skel", bones: ["Hand.L"], space: "both", instance: "a",
    });
  });

  it("refuses a cmd that belongs to the other target and missing per-cmd arguments", () => {
    expect(() => buildRuntimeAnimateOp({ target: "player", path: "/root/A", cmd: "travel" })).toThrow(/not an AnimationPlayer command/);
    expect(() => buildRuntimeAnimateOp({ target: "tree", path: "/root/A", cmd: "seek" })).toThrow(/not an AnimationTree command/);
    expect(() => buildRuntimeAnimateOp({ target: "player", path: "/root/A", cmd: "seek" })).toThrow(/position/);
    expect(() => buildRuntimeAnimateOp({ target: "tree", path: "/root/A", cmd: "set_param", param: "parameters/x" })).toThrow(/value/);
  });
});

describe("buildGameControlOp", () => {
  it("maps the actions and scales the step budget with the engine watchdog", () => {
    expect(buildGameControlOp({ action: "pause", instance: "a" }).op).toEqual({ op: "GamePause", paused: true, instance: "a" });
    expect(buildGameControlOp({ action: "resume" }).op).toEqual({ op: "GamePause", paused: false });
    const one = buildGameControlOp({ action: "step" });
    expect(one.op).toEqual({ op: "GameStep", frames: 1, kind: "physics" });
    expect(one.timeoutMs).toBe(runtimeBudgetMs(10));
    const many = buildGameControlOp({ action: "step", frames: GAME_STEP_MAX_FRAMES, kind: "process" });
    expect(many.timeoutMs).toBe(runtimeBudgetMs(20)); // max(10, 600/10) capped at 20
    expect(buildGameControlOp({ action: "speed", speed: 0.25 }).op).toEqual({ op: "GameSpeed", speed: 0.25 });
    expect(buildGameControlOp({ action: "instances", instance: "ignored" }).op).toEqual({ op: "ListGameInstances" });
  });

  it("refuses out-of-range frames and speed before sending", () => {
    expect(() => buildGameControlOp({ action: "step", frames: 0 })).toThrow(/1\.\.600/);
    expect(() => buildGameControlOp({ action: "step", frames: 601 })).toThrow(/1\.\.600/);
    expect(() => buildGameControlOp({ action: "speed", speed: 0 })).toThrow(/\(0, 100\]/);
    expect(() => buildGameControlOp({ action: "speed" })).toThrow(/speed/);
  });
});

describe("buildGameInputOp", () => {
  const events = [
    { at_frame: 0, type: "action" as const, action: "move_right", hold_ms: 500 },
    { at_frame: 30, type: "action" as const, action: "jump", hold_ms: 50 },
  ];

  it("script sends events with clock/wait defaults and a horizon-based budget", () => {
    const built = buildGameInputOp({ action: "script", events, instance: "a" });
    expect(built.kind).toBe("SimulateInputScript");
    expect(built.op).toEqual({ op: "SimulateInputScript", events, clock: "frame", wait: true, instance: "a" });
    expect(built.timeoutMs).toBe(runtimeBudgetMs(10)); // horizon 30 frames -> 3.5 s -> floor 10 s
    const long = buildGameInputOp({ action: "script", events: [{ at_frame: 3000, type: "key", keycode: 32 }] });
    expect(long.timeoutMs).toBe(runtimeBudgetMs(20)); // 3000/60 + 3 = 53 s -> capped 20 s
    const unwaited = buildGameInputOp({ action: "script", events: [{ at_frame: 3000, type: "key", keycode: 32 }], wait: false });
    expect(unwaited.timeoutMs).toBe(runtimeBudgetMs(10));
  });

  it("refuses empty, oversized, or over-horizon scripts before sending", () => {
    expect(() => buildGameInputOp({ action: "script" })).toThrow(/non-empty events/);
    const tooMany = Array.from({ length: INPUT_SCRIPT_MAX_EVENTS + 1 }, () => ({ type: "key" as const, keycode: 32 }));
    expect(() => buildGameInputOp({ action: "script", events: tooMany })).toThrow(/1000-event cap/);
    expect(() => buildGameInputOp({ action: "script", events: [{ at_frame: 36_001, type: "key", keycode: 32 }] })).toThrow(/horizon/);
  });

  it("record_start / record_stop carry only their own parameters", () => {
    expect(buildGameInputOp({ action: "record_start", include_motion: true }).op).toEqual({ op: "InputRecordStart", include_motion: true });
    expect(buildGameInputOp({ action: "record_stop", save_as: "res://.summer/replays/run1.json", instance: "a" }).op).toEqual({
      op: "InputRecordStop", save_as: "res://.summer/replays/run1.json", instance: "a",
    });
    expect(() => buildGameInputOp({ action: "record_stop", save_as: "../escape.json" })).toThrow(/res:\/\//);
  });

  it("replay needs a recording or inline events and passes seed through", () => {
    expect(() => buildGameInputOp({ action: "replay" })).toThrow(/recording .* or inline events/);
    const fromFile = buildGameInputOp({ action: "replay", recording: "res://.summer/replays/abc.json", seed: 42 });
    expect(fromFile.kind).toBe("InputReplay");
    expect(fromFile.op).toEqual({ op: "InputReplay", recording: "res://.summer/replays/abc.json", seed: 42, wait: true });
    expect(fromFile.timeoutMs).toBe(runtimeBudgetMs(20));
    const inline = buildGameInputOp({ action: "replay", events, wait: false });
    expect(inline.op).toEqual({ op: "InputReplay", events, wait: false });
  });
});

describe("buildGameProbeOp", () => {
  it("sends tree/props/screenshot/max_dim with bounds", () => {
    const built = buildGameProbeOp({
      tree: { path: "/root/Main", depth: 2, limit: 100 },
      props: ["/root/Main/Player:position"],
      screenshot: false,
      max_dim: 640,
      instance: "a",
    });
    expect(built.kind).toBe("GameProbe");
    expect(built.op).toEqual({
      op: "GameProbe",
      tree: { path: "/root/Main", depth: 2, limit: 100 },
      props: ["/root/Main/Player:position"],
      screenshot: false,
      max_dim: 640,
      instance: "a",
    });
    expect(built.timeoutMs).toBe(runtimeBudgetMs(15));
    expect(buildGameProbeOp({}).op).toEqual({ op: "GameProbe" });
  });

  it("refuses malformed props keys and out-of-range bounds", () => {
    expect(() => buildGameProbeOp({ props: ["no-colon"] })).toThrow(/path>:<property/);
    expect(() => buildGameProbeOp({ props: Array.from({ length: 65 }, (_, i) => `/root/A:${i}`) })).toThrow(/64/);
    expect(() => buildGameProbeOp({ tree: { depth: 9 } })).toThrow(/1\.\.8/);
    expect(() => buildGameProbeOp({ max_dim: 8 })).toThrow(/16\.\.4096/);
  });
});

describe("probe helpers", () => {
  const envelope = {
    ok: true,
    results: [
      {
        ok: true,
        op: "GameProbe",
        frame: { process_frames: 120, physics_frames: 118, frames_drawn: 119 },
        image_frame: 120,
        instance: "main",
        suspended: true,
        image_base64: "AAAA",
        mime: "image/jpeg",
        width: 640,
        height: 360,
        values: { "/root/Main/Player:position": "Vector3(1, 2, 3)" },
        missing: [],
      },
    ],
  };

  it("finds the payload, strips the image, and stamps the frame", () => {
    expect(findProbePayload(envelope)?.width).toBe(640);
    const stripped = stripProbeImage(envelope) as { results: Array<Record<string, unknown>> };
    expect(stripped.results[0]!.image_base64).toBeUndefined();
    expect(stripped.results[0]!.values).toBeDefined();
    expect(probeFrameStamp(envelope.results[0]!)).toBe("frame 120, physics 118, drawn 119, image_frame 120, instance main, SUSPENDED");
  });
});

describe("withRuntimeFailureHints", () => {
  it("teaches a classified failure while keeping failure_reason intact", () => {
    const result = withRuntimeFailureHints({
      ok: false,
      results: [{ ok: false, op: "GameStep", failure_reason: "game_not_running", error: "no game" }],
    }) as { error: string; results: Array<{ failure_reason: string }> };
    expect(result.results[0]!.failure_reason).toBe("game_not_running");
    expect(result.error).toContain("summer_play");
    expect(result.error).toContain("Engine said: no game");
  });

  it("covers every gate the contract names", () => {
    for (const reason of ["busy", "game_not_running", "game_breaked", "unsupported", "not_applied", "nondeterministic_instance", "unknown_instance", "timeout"]) {
      expect(RUNTIME_FAILURE_HINTS[reason], reason).toBeTruthy();
    }
  });

  it("adds a hint (not an error) to a SUCCESSFUL result that still carries a reason", () => {
    const notApplied = withRuntimeFailureHints({
      ok: true,
      results: [{ ok: true, op: "SetRuntimeProp", applied: false, failure_reason: "not_applied", value_after: "1" }],
    }) as { error?: string; hint?: string };
    expect(notApplied.error).toBeUndefined();
    expect(notApplied.hint).toContain("read-back");

    const bareApplied = withRuntimeFailureHints({ ok: true, results: [{ ok: true, op: "SetRuntimeProp", applied: false }] }) as { hint?: string };
    expect(bareApplied.hint).toContain("applied:false");

    const advisory = withRuntimeFailureHints({
      ok: true,
      results: [{ ok: true, op: "InputReplay", deterministic: false, failure_reason: "nondeterministic_instance" }],
    }) as { hint?: string };
    expect(advisory.hint).toContain("deterministic:true");
  });

  it("leaves results without a known reason untouched", () => {
    const payload = { ok: true, results: [{ ok: true, op: "GamePause", suspended: true }] };
    expect(withRuntimeFailureHints(payload)).toBe(payload);
  });
});

describe("PlayGame / StopGame variants", () => {
  it("plain focus play (scene only) does not need the op; quiet, determinism and instances do", () => {
    expect(playNeedsOp({ scene: "res://a.tscn", focus: true })).toBe(false);
    expect(playNeedsOp({ scene: "res://a.tscn" })).toBe(true);
    expect(playNeedsOp({ seed: 7 })).toBe(true);
    expect(playNeedsOp({ instance: "a", mode: "offscreen" })).toBe(true);
    expect(playTargetsInstance({ seed: 7 })).toBe(false);
    expect(playTargetsInstance({ instance: "main", seed: 7 })).toBe(false);
    expect(playTargetsInstance({ instance: "a", mode: "offscreen" })).toBe(true);
  });

  it("builds the op with exactly the given params and the attach budget", () => {
    const built = buildPlayGameOp({ scene: "res://a.tscn", instance: "a", mode: "offscreen", deterministic: true, seed: 42, fixed_fps: 60, speed: 0.5, focus: true });
    expect(built.kind).toBe("PlayGame");
    expect(built.op).toEqual({ op: "PlayGame", scene: "res://a.tscn", instance: "a", mode: "offscreen", deterministic: true, seed: 42, fixed_fps: 60, speed: 0.5 });
    expect(built.timeoutMs).toBe(PLAY_INSTANCE_TIMEOUT_MS);
    expect(buildPlayGameOp({ seed: 7, fixed_fps: 60, focus: true }).op).toEqual({ op: "PlayGame", seed: 7, fixed_fps: 60 });
    // The quiet default adds exactly one key.
    expect(buildPlayGameOp({ seed: 7, fixed_fps: 60 }).op).toEqual({ op: "PlayGame", agent: true, seed: 7, fixed_fps: 60 });
  });

  it("refuses the combinations the engine would reject, before sending", () => {
    expect(() => buildPlayGameOp({ mode: "offscreen" })).toThrow(/instance name other than 'main'/);
    expect(() => buildPlayGameOp({ instance: "main", mode: "offscreen" })).toThrow(/other than 'main'/);
    expect(() => buildPlayGameOp({ instance: "a" })).toThrow(/needs mode:'offscreen'/);
    expect(() => buildPlayGameOp({ deterministic: true })).toThrow(/offscreen-only/);
    expect(() => buildPlayGameOp({ fixed_fps: 0 })).toThrow(/fixed_fps/);
    expect(() => buildPlayGameOp({ speed: 0 })).toThrow(/speed/);
    expect(buildStopGameOp(" a ").op).toEqual({ op: "StopGame", instance: "a" });
    expect(() => buildStopGameOp("  ")).toThrow(ToolInputError);
  });

  it("warns when an instance was requested but the engine did not echo one", () => {
    const args = { instance: "a", mode: "offscreen" as const };
    const echoed = { ok: true, results: [{ ok: true, op: "PlayGame", instance: "a", session_attached: true }] };
    expect(withPlayInstanceEcho(echoed, args)).toBe(echoed);
    const silent = withPlayInstanceEcho({ ok: true, results: [{ ok: true, op: "PlayGame", playing: true }] }, args) as { warning?: string };
    expect(silent.warning).toContain("MAIN");
    expect(withPlayInstanceEcho({ ok: true, results: [{ ok: true, op: "PlayGame" }] }, { seed: 1 })).toEqual({
      ok: true, results: [{ ok: true, op: "PlayGame" }],
    });
  });
});

describe("summer_play posture — quiet by default, focus:true opts in", () => {
  it("quiet unless focus:true, and quiet rides the PlayGame op as agent:true", () => {
    expect(playIsQuiet({})).toBe(true);
    expect(playIsQuiet({ focus: false })).toBe(true);
    expect(playIsQuiet({ focus: true })).toBe(false);
    // The /api/play rung copies only `scene`, so the quiet default needs the op.
    expect(playNeedsOp({})).toBe(true);
    expect(playNeedsOp({ scene: "res://a.tscn", focus: true })).toBe(false);
    expect(buildPlayGameOp({ scene: "res://a.tscn" }).op).toEqual({ op: "PlayGame", scene: "res://a.tscn", agent: true });
    expect(buildPlayGameOp({ focus: true, seed: 3 }).op).toEqual({ op: "PlayGame", seed: 3 });
    // An offscreen instance is a hidden child: quiet is moot, no agent key, no posture note.
    expect(buildPlayGameOp({ instance: "a", mode: "offscreen" }).op).toEqual({ op: "PlayGame", instance: "a", mode: "offscreen" });
    const attached = { ok: true, results: [{ ok: true, op: "PlayGame", instance: "a", session_attached: true }] };
    expect(withPlayPostureEcho(attached, { instance: "a", mode: "offscreen" })).toBe(attached);
  });

  it("withPlayPostureEcho trusts an engine that echoes agent_quiet and flags one that does not", () => {
    const honoured = { status: "ok", results: [{ ok: true, op: "PlayGame", playing: true, agent_quiet: true }] };
    expect(withPlayPostureEcho(honoured, {})).toBe(honoured);
    const old = { status: "ok", results: [{ ok: true, op: "PlayGame", playing: true, scene: "main_scene" }] };
    expect(withPlayPostureEcho(old, {})).toMatchObject({ posture_note: PLAY_QUIET_NOT_SUPPORTED });
    // Already running on a current engine: agent_quiet is echoed there too, so nothing is added.
    const running = { status: "ok", results: [{ ok: true, op: "PlayGame", playing: true, note: "Game was already running", agent_quiet: true }] };
    expect(withPlayPostureEcho(running, {})).toBe(running);
    // focus:true or a failure: untouched.
    expect(withPlayPostureEcho(old, { focus: true })).toBe(old);
    const failed = { ok: false, results: [{ ok: false, op: "PlayGame", error: "boom" }] };
    expect(withPlayPostureEcho(failed, {})).toBe(failed);
  });

  it("playGame: focus:true with nothing else is the legacy /api/play call; the quiet default is the op", async () => {
    const play = vi.fn(async () => ({ status: "ok", results: [{ ok: true, op: "PlayGame", playing: true }] }));
    const executeOps = vi.fn(async () => ({ status: "ok", results: [{ ok: true, op: "PlayGame", playing: true, agent_quiet: true }] }));
    const client = { play, executeOps };

    await playGame(client, { scene: "res://a.tscn", focus: true });
    expect(play).toHaveBeenCalledWith("res://a.tscn");
    expect(executeOps).not.toHaveBeenCalled();

    const quiet = (await playGame(client, { scene: "res://a.tscn" })) as Record<string, unknown>;
    expect(executeOps).toHaveBeenCalledWith([{ op: "PlayGame", scene: "res://a.tscn", agent: true }], undefined, PLAY_INSTANCE_TIMEOUT_MS);
    expect(quiet).not.toHaveProperty("posture_note");
  });

  it("playGame validates before sending and pre-flights the Wave I advert for instances", async () => {
    const executeOps = vi.fn();
    const client = { play: vi.fn(), executeOps, getEngineCapabilities: () => ({ opKinds: ["PlayGame"] }), getEngineVersion: () => "0.5.65" };
    await expect(playGame(client, { mode: "offscreen" })).rejects.toThrow(ToolInputError);
    const missing = (await playGame(client, { instance: "a", mode: "offscreen" })) as Record<string, unknown>;
    expect(missing).toMatchObject({ ok: false, failure_reason: "engine_lacks_op", op: "ListGameInstances" });
    expect(executeOps).not.toHaveBeenCalled();
  });
});
