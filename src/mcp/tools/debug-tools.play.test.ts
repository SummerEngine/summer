import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../server.js", () => ({
  getClient: vi.fn(),
  resetClient: vi.fn(),
}));

vi.mock("../../core/telemetry.js", () => ({
  recordMcpSession: vi.fn(),
}));

import { getClient } from "../server.js";
import { registerDebugTools } from "./debug-tools.js";

type RegisteredTool = {
  name: string;
  description: string;
  shape: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

function tool(name: string): RegisteredTool {
  const registered: RegisteredTool[] = [];
  registerDebugTools({
    tool(
      toolName: string,
      description: string,
      shape: Record<string, unknown>,
      handler: (args: Record<string, unknown>) => Promise<unknown>
    ) {
      registered.push({ name: toolName, description, shape, handler });
      return { name: toolName };
    },
  } as never);
  const found = registered.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

function text(result: unknown): string {
  const envelope = result as { content?: Array<{ text?: string }> };
  return envelope.content?.map((block) => block.text ?? "").join("\n") ?? "";
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("summer_play — instance-aware / deterministic variants", () => {
  it("exposes the playtest launch parameters and teaches the loop", () => {
    const play = tool("summer_play");
    expect(Object.keys(play.shape).sort()).toEqual(["deterministic", "fixed_fps", "focus", "instance", "mode", "scene", "seed", "speed", "time_scale"]);
    for (const phrase of ["summer_is_running", "seed_scope", "summer_game_control", "agent-playtesting", "too_many_instances", "QUIET BY DEFAULT", "agent_quiet", "focus:true"]) {
      expect(play.description).toContain(phrase);
    }
  });

  it("plain focus:true play still takes the legacy /api/play route byte-for-byte", async () => {
    const play = vi.fn().mockResolvedValue({ ok: true, playing: true });
    const executeOps = vi.fn();
    vi.mocked(getClient).mockResolvedValue({ play, executeOps } as never);

    const result = (await tool("summer_play").handler({ scene: "res://a.tscn", focus: true })) as { isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(play).toHaveBeenCalledWith("res://a.tscn");
    expect(executeOps).not.toHaveBeenCalled();
  });

  it("seed / fixed_fps travel as a PlayGame op (the /api/play route drops them) without an instance pre-flight", async () => {
    const play = vi.fn();
    const executeOps = vi.fn().mockResolvedValue({
      ok: true,
      results: [{ ok: true, op: "PlayGame", playing: true, determinism: { seed: 7, fixed_fps: 60, seed_scope: "global RNG only" } }],
    });
    vi.mocked(getClient).mockResolvedValue({
      play,
      executeOps,
      // An engine without the runtime-control wave still supports seed/fixed_fps on the main game.
      getEngineCapabilities: () => ({ opKinds: ["PlayGame", "StopGame"] }),
    } as never);

    const result = (await tool("summer_play").handler({ scene: "res://a.tscn", seed: 7, fixed_fps: 60 })) as { isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(play).not.toHaveBeenCalled();
    // Quiet default: agent:true rides the same op.
    expect(executeOps).toHaveBeenCalledWith([{ op: "PlayGame", scene: "res://a.tscn", agent: true, seed: 7, fixed_fps: 60 }], undefined, 60_000);
    expect(text(result)).toContain("seed_scope");
  });

  it("an offscreen instance is refused BEFORE sending on an engine that provably lacks the runtime-control wave", async () => {
    const executeOps = vi.fn();
    vi.mocked(getClient).mockResolvedValue({
      executeOps,
      getEngineCapabilities: () => ({ opKinds: ["PlayGame", "StopGame"] }),
      getEngineVersion: () => "0.5.66",
    } as never);

    const result = (await tool("summer_play").handler({ instance: "a", mode: "offscreen", deterministic: true })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(executeOps).not.toHaveBeenCalled();
    expect(text(result)).toContain("engine_lacks_op");
    expect(text(result)).toContain("ListGameInstances");
    expect(text(result)).toContain("without instance/mode");
  });

  it("sends the instance op and passes the attach result through; warns when the engine did not echo the instance", async () => {
    const executeOps = vi.fn().mockResolvedValue({
      ok: true,
      results: [{ ok: true, op: "PlayGame", instance: "a", mode: "offscreen", pid: 4242, session_attached: true, seed: 20260725, fixed_fps: 60 }],
    });
    vi.mocked(getClient).mockResolvedValue({ executeOps } as never);

    const attached = (await tool("summer_play").handler({ instance: "a", mode: "offscreen", deterministic: true })) as { isError?: boolean };
    expect(attached.isError).toBeUndefined();
    expect(executeOps).toHaveBeenCalledWith([{ op: "PlayGame", instance: "a", mode: "offscreen", deterministic: true }], undefined, 60_000);
    expect(text(attached)).toContain("session_attached");
    expect(text(attached)).not.toContain("warning");

    executeOps.mockResolvedValue({ ok: true, results: [{ ok: true, op: "PlayGame", playing: true }] });
    const silent = await tool("summer_play").handler({ instance: "a", mode: "offscreen" });
    expect(text(silent)).toContain("MAIN embedded game");
  });

  it("teaches the instance failure reasons", async () => {
    const executeOps = vi.fn().mockResolvedValue({
      ok: false,
      results: [{ ok: false, op: "PlayGame", failure_reason: "too_many_instances", error: "3 live" }],
    });
    vi.mocked(getClient).mockResolvedValue({ executeOps } as never);

    const result = (await tool("summer_play").handler({ instance: "d", mode: "offscreen" })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("summer_stop {instance}");
    expect(text(result)).toContain("Engine said: 3 live");
  });

  it("refuses impossible combinations pre-apply (nothing sent)", async () => {
    const executeOps = vi.fn();
    vi.mocked(getClient).mockResolvedValue({ executeOps } as never);

    const result = (await tool("summer_play").handler({ mode: "offscreen" })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(executeOps).not.toHaveBeenCalled();
    expect(text(result)).toContain("invalid_input");
  });
});

describe("summer_stop — instance variant", () => {
  it("plain stop uses /api/stop; instance sends StopGame {instance}", async () => {
    const stop = vi.fn().mockResolvedValue({ ok: true });
    const executeOps = vi.fn().mockResolvedValue({ ok: true, results: [{ ok: true, op: "StopGame", instance: "a", was_playing: true, killed: true }] });
    vi.mocked(getClient).mockResolvedValue({ stop, executeOps } as never);

    await tool("summer_stop").handler({});
    expect(stop).toHaveBeenCalledTimes(1);
    expect(executeOps).not.toHaveBeenCalled();

    await tool("summer_stop").handler({ instance: "main" });
    expect(stop).toHaveBeenCalledTimes(2);

    const result = (await tool("summer_stop").handler({ instance: "a" })) as { isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(executeOps).toHaveBeenCalledWith([{ op: "StopGame", instance: "a" }], undefined, 15_000);
    expect(text(result)).toContain("killed");
  });

  it("refuses an instance stop before sending on an engine without the runtime-control wave", async () => {
    const executeOps = vi.fn();
    vi.mocked(getClient).mockResolvedValue({
      executeOps,
      getEngineCapabilities: () => ({ opKinds: ["PlayGame", "StopGame"] }),
    } as never);

    const result = (await tool("summer_stop").handler({ instance: "a" })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(executeOps).not.toHaveBeenCalled();
    expect(text(result)).toContain("engine_lacks_op");
  });
});
