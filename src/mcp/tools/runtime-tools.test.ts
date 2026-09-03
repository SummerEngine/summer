import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../server.js", () => ({
  getClient: vi.fn(),
  resetClient: vi.fn(),
}));

vi.mock("../../core/telemetry.js", () => ({
  recordMcpSession: vi.fn(),
}));

import { getClient } from "../server.js";
import { registerRuntimeTools } from "./runtime-tools.js";

type RegisteredTool = {
  name: string;
  description: string;
  shape: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

type Content = Array<{ type: string; text?: string; data?: string; mimeType?: string }>;

function tools(): RegisteredTool[] {
  const registered: RegisteredTool[] = [];
  registerRuntimeTools({
    tool(
      name: string,
      description: string,
      shape: Record<string, unknown>,
      handler: (args: Record<string, unknown>) => Promise<unknown>
    ) {
      registered.push({ name, description, shape, handler });
      return { name };
    },
  } as never);
  return registered;
}

function tool(name: string): RegisteredTool {
  const found = tools().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

function text(result: unknown): string {
  const content = (result as { content?: Content }).content ?? [];
  return content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
}

function ok(op: string, extra: Record<string, unknown> = {}) {
  return { ok: true, results: [{ ok: true, op, frame: { process_frames: 10, physics_frames: 9, frames_drawn: 10 }, ...extra }] };
}

function failed(op: string, failure_reason: string, error: string) {
  return { ok: false, results: [{ ok: false, op, failure_reason, error }] };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("registration", () => {
  it("registers the seven runtime-control tools", () => {
    expect(tools().map((t) => t.name)).toEqual([
      "summer_runtime_set",
      "summer_runtime_call",
      "summer_runtime_spawn",
      "summer_runtime_animate",
      "summer_game_control",
      "summer_game_input",
      "summer_game_probe",
    ]);
  });

  it("every tool takes `instance` and teaches the loop, the gates and the fallback", () => {
    for (const registered of tools()) {
      expect(Object.keys(registered.shape), registered.name).toContain("instance");
      for (const phrase of ["summer_play", "summer_game_probe", "game_not_running", "game_breaked", "engine_lacks_op"]) {
        expect(registered.description, `${registered.name} mentions ${phrase}`).toContain(phrase);
      }
    }
    expect(tool("summer_game_input").description).toContain("busy");
    expect(tool("summer_game_input").description).toContain("nondeterministic_instance");
    expect(tool("summer_runtime_set").description).toContain("not_applied");
    expect(tool("summer_game_control").description).toContain("summer_is_running");
    expect(tool("summer_game_probe").description).toContain("Never claim");
  });
});

describe("pre-flight", () => {
  it("refuses BEFORE sending when the engine advertises ops without the kind", async () => {
    const executeOps = vi.fn();
    vi.mocked(getClient).mockResolvedValue({
      executeOps,
      getEngineCapabilities: () => ({ opKinds: ["AddNode", "GetRuntimeSceneTree"] }),
      getEngineVersion: () => "0.5.66",
    } as never);

    const result = (await tool("summer_runtime_set").handler({ path: "/root/Main/Player", property: "health", value: 1 })) as {
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(executeOps).not.toHaveBeenCalled();
    expect(text(result)).toContain("engine_lacks_op");
    expect(text(result)).toContain("SetRuntimeProp");
    expect(text(result)).toContain("engine version 0.5.66");
    expect(text(result)).toContain("RunVerification");
  });

  it("pre-flights on the RESOLVED kind (action:'free' -> FreeRuntimeNode, target:'bones' -> GetRuntimeBones)", async () => {
    const executeOps = vi.fn();
    vi.mocked(getClient).mockResolvedValue({
      executeOps,
      getEngineCapabilities: () => ({ opKinds: ["SpawnRuntimeScene", "RuntimeAnimation"] }),
    } as never);

    const free = await tool("summer_runtime_spawn").handler({ action: "free", path: "/root/Main/G" });
    expect(text(free)).toContain("FreeRuntimeNode");
    const bones = await tool("summer_runtime_animate").handler({ target: "bones", path: "/root/Main/Skel" });
    expect(text(bones)).toContain("GetRuntimeBones");
    expect(executeOps).not.toHaveBeenCalled();
  });

  it("sends when the kind is advertised only under capabilities.runtimeControl.ops", async () => {
    const executeOps = vi.fn().mockResolvedValue(ok("GamePause", { suspended: true }));
    vi.mocked(getClient).mockResolvedValue({
      executeOps,
      getEngineCapabilities: () => ({ opKinds: ["AddNode"], runtimeControl: { ops: ["GamePause"], summerCapture: true } }),
    } as never);

    const result = (await tool("summer_game_control").handler({ action: "pause" })) as { isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(executeOps).toHaveBeenCalledTimes(1);
  });
});

describe("payload shapes and budgets", () => {
  it("summer_runtime_set sends one SetRuntimeProp op with instance and the default budget", async () => {
    const executeOps = vi.fn().mockResolvedValue(ok("SetRuntimeProp", { applied: true, value_before: "1", value_after: "2" }));
    vi.mocked(getClient).mockResolvedValue({ executeOps } as never);

    const result = (await tool("summer_runtime_set").handler({
      path: "/root/Main/Player",
      property: "health",
      value: 2,
      instance: "b",
    })) as { isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(executeOps).toHaveBeenCalledWith(
      [{ op: "SetRuntimeProp", path: "/root/Main/Player", property: "health", value: 2, instance: "b" }],
      undefined,
      25_000
    );
    expect(text(result)).toContain("value_after");
  });

  it("summer_game_control step sends GameStep alone and omits instance when not given", async () => {
    const executeOps = vi.fn().mockResolvedValue(ok("GameStep", { requested: 3, exact: true, overshoot: 0 }));
    vi.mocked(getClient).mockResolvedValue({ executeOps } as never);

    await tool("summer_game_control").handler({ action: "step", frames: 3 });
    expect(executeOps).toHaveBeenCalledWith([{ op: "GameStep", frames: 3, kind: "physics" }], undefined, 25_000);

    await tool("summer_game_control").handler({ action: "instances" });
    expect(executeOps).toHaveBeenLastCalledWith([{ op: "ListGameInstances" }], undefined, 25_000);
  });

  it("summer_game_input script budgets the waited horizon and replay passes seed through", async () => {
    const executeOps = vi.fn().mockResolvedValue(ok("SimulateInputScript", { scheduled: 1, applied: 1, rejected: [], completed: true }));
    vi.mocked(getClient).mockResolvedValue({ executeOps } as never);

    await tool("summer_game_input").handler({
      action: "script",
      events: [{ at_frame: 1200, type: "action", action: "jump", hold_ms: 50 }],
      instance: "a",
    });
    const [ops, , timeoutMs] = executeOps.mock.calls[0]!;
    expect(ops).toEqual([
      {
        op: "SimulateInputScript",
        events: [{ at_frame: 1200, type: "action", action: "jump", hold_ms: 50 }],
        clock: "frame",
        wait: true,
        instance: "a",
      },
    ]);
    expect(timeoutMs).toBe(35_000); // 1200/60 + 3 = 23 s -> capped 20 s + 15 s headroom

    executeOps.mockResolvedValue(ok("InputReplay", { completed: true, deterministic: true, recording: "res://.summer/replays/x.json" }));
    await tool("summer_game_input").handler({ action: "replay", recording: "res://.summer/replays/x.json", seed: 42, instance: "det" });
    expect(executeOps).toHaveBeenLastCalledWith(
      [{ op: "InputReplay", recording: "res://.summer/replays/x.json", seed: 42, wait: true, instance: "det" }],
      undefined,
      35_000
    );
  });

  it("argument problems are pre-apply failures: nothing is sent and the model is told so", async () => {
    const executeOps = vi.fn();
    vi.mocked(getClient).mockResolvedValue({ executeOps } as never);

    const result = (await tool("summer_game_control").handler({ action: "step", frames: 601 })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(executeOps).not.toHaveBeenCalled();
    expect(text(result)).toContain("invalid_input");
    expect(text(result)).toContain("1..600");
  });
});

describe("failure passthrough", () => {
  it("game_not_running teaches summer_play and keeps the reason", async () => {
    const executeOps = vi.fn().mockResolvedValue(failed("GameProbe", "game_not_running", "no game"));
    vi.mocked(getClient).mockResolvedValue({ executeOps } as never);

    const result = (await tool("summer_game_probe").handler({})) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("game_not_running");
    expect(text(result)).toContain("summer_play");
    expect(text(result)).toContain("Engine said: no game");
  });

  it("busy, game_breaked, unsupported and nondeterministic_instance each get their own recovery text", async () => {
    const executeOps = vi.fn();
    vi.mocked(getClient).mockResolvedValue({ executeOps } as never);
    const events = [{ type: "action", action: "jump" }];

    executeOps.mockResolvedValue(failed("SimulateInputScript", "busy", "script in flight"));
    expect(text(await tool("summer_game_input").handler({ action: "script", events }))).toContain("one per instance");

    executeOps.mockResolvedValue(failed("GameStep", "game_breaked", "breaked"));
    expect(text(await tool("summer_game_control").handler({ action: "step" }))).toContain("breakpoint");

    executeOps.mockResolvedValue(failed("CallRuntimeMethod", "unsupported", "no capture"));
    expect(text(await tool("summer_runtime_call").handler({ path: "/root/A", method: "m" }))).toContain("summer runtime capture");

    executeOps.mockResolvedValue(failed("InputReplay", "nondeterministic_instance", "not deterministic"));
    const replay = (await tool("summer_game_input").handler({ action: "replay", recording: "res://.summer/replays/x.json", seed: 1 })) as {
      isError?: boolean;
    };
    expect(replay.isError).toBe(true);
    expect(text(replay)).toContain("deterministic:true");
  });

  it("renders not_applied honestly: the op succeeded, the result carries a hint, not an error", async () => {
    const executeOps = vi.fn().mockResolvedValue(
      ok("SetRuntimeProp", { applied: false, failure_reason: "not_applied", value_before: "1", value_after: "1" })
    );
    vi.mocked(getClient).mockResolvedValue({ executeOps } as never);

    const result = (await tool("summer_runtime_set").handler({ path: "/root/A", property: "health", value: 5 })) as { isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('"applied": false');
    expect(text(result)).toContain("read-back");
  });

  it("rewrites an old engine's unknown-op answer into engine_lacks_op with the fallback", async () => {
    const executeOps = vi.fn().mockResolvedValue({
      ok: false,
      results: [{ ok: false, op: "GameProbe", error: "unknown op: GameProbe" }],
    });
    vi.mocked(getClient).mockResolvedValue({ executeOps } as never);

    const result = (await tool("summer_game_probe").handler({ screenshot: false })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("doesn't support GameProbe yet");
    expect(text(result)).toContain("engine_lacks_op");
    expect(text(result)).toContain("RunVerification probe");
  });
});

describe("summer_game_probe rendering", () => {
  it("returns the screenshot as an image block plus frame-stamped text without the base64", async () => {
    const executeOps = vi.fn().mockResolvedValue(
      ok("GameProbe", {
        image_frame: 10,
        image_base64: "QUJD",
        mime: "image/jpeg",
        width: 320,
        height: 180,
        values: { "/root/Main/Player:position": "Vector3(1, 2, 3)" },
        missing: [],
        instance: "main",
      })
    );
    vi.mocked(getClient).mockResolvedValue({ executeOps } as never);

    const result = (await tool("summer_game_probe").handler({ props: ["/root/Main/Player:position"] })) as {
      isError?: boolean;
      content: Content;
    };
    expect(result.isError).toBeUndefined();
    expect(executeOps).toHaveBeenCalledWith([{ op: "GameProbe", props: ["/root/Main/Player:position"] }], undefined, 30_000);
    expect(result.content[0]).toEqual({ type: "image", data: "QUJD", mimeType: "image/jpeg" });
    const caption = result.content[1]!.text ?? "";
    expect(caption).toContain("frame 10, physics 9, drawn 10, image_frame 10, instance main");
    expect(caption).toContain("320x180");
    expect(caption).toContain("Vector3(1, 2, 3)");
    expect(caption).not.toContain("QUJD");
  });

  it("with screenshot:false returns text only", async () => {
    const executeOps = vi.fn().mockResolvedValue(ok("GameProbe", { values: {}, missing: ["/root/X:y"] }));
    vi.mocked(getClient).mockResolvedValue({ executeOps } as never);

    const result = (await tool("summer_game_probe").handler({ screenshot: false })) as { content: Content };
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
    expect(result.content[0]!.text).toContain("/root/X:y");
  });
});
