import { describe, expect, it, vi } from "vitest";
import { playGame, type PlayGameClient } from "./runtime-control.js";

// Model the engine's public contract: PlayGame reuses the running process;
// only a new process reads the saved script. Edits may come from outside MCP.
function engine() {
  let saved = "original";
  let nextPid = 1;
  let running: { pid: number; script: string; scene: unknown; seed: unknown } | null = null;
  const launch = async (scene?: unknown, seed?: unknown) => {
    const reused = running !== null;
    running ??= { pid: nextPid++, script: saved, scene, seed };
    return { ok: true, playing: true, reuseExistingInstance: reused, ...running };
  };
  const client: PlayGameClient = {
    stop: vi.fn(async () => {
      running = null;
      return { status: "ok", results: [{ op: "StopGame", ok: true, playing: false }] };
    }),
    play: vi.fn(launch),
    executeOps: vi.fn(async ([op]) => ({ status: "ok", results: [await launch(op!.scene, op!.seed)] })),
  };
  return { client, edit: (text: string) => { saved = text; }, runtime: () => running };
}

describe("play uses the current saved game", () => {
  it.each([false, true])("loads external script edits on the next play (focus:%s)", async (focus) => {
    const game = engine();
    await playGame(game.client, { focus });
    const first = game.runtime()!;
    game.edit("edited outside MCP");
    await playGame(game.client, { focus, scene: "res://test.tscn" });
    expect(game.runtime()).toMatchObject({ script: "edited outside MCP", scene: "res://test.tscn" });
    expect(game.runtime()!.pid).not.toBe(first.pid);
  });

  it("does not launch before the stop finishes, and keeps the requested seed", async () => {
    const game = engine();
    await playGame(game.client, {});
    const first = game.runtime();
    const stop = game.client.stop;
    let finishStop!: () => void;
    game.client.stop = async () => {
      await new Promise<void>((resolve) => { finishStop = resolve; });
      return stop();
    };
    game.edit("new");
    const pending = playGame(game.client, { seed: 42 });
    await Promise.resolve();
    expect(game.runtime()).toBe(first);
    finishStop();
    await pending;
    expect(game.runtime()).toMatchObject({ script: "new", seed: 42 });
  });

  it.each([
    { ok: false, error: "stop failed" },
    { terminalState: "identity_mismatch", errorClass: "rejected_identity" },
    { status: "error", results: [{ op: "StopGame", ok: false, error: "busy" }] },
  ])("preserves a failed stop receipt and leaves the current game alone: %j", async (failure) => {
    const game = engine();
    await playGame(game.client, {});
    const first = game.runtime();
    game.client.stop = async () => failure;
    expect(await playGame(game.client, {})).toBe(failure);
    expect(game.runtime()).toBe(first);
  });

  it.each([undefined, {}, { ok: true, playing: true }])("refuses to launch without a successful stop: %j", async (receipt) => {
    const game = engine();
    await playGame(game.client, {});
    const first = game.runtime();
    game.client.stop = async () => receipt;
    expect(await playGame(game.client, {})).toMatchObject({ ok: false, failure_reason: "stop_not_confirmed" });
    expect(game.runtime()).toBe(first);
  });

  it("a stop transport failure prevents launch", async () => {
    const game = engine();
    await playGame(game.client, {});
    const first = game.runtime();
    game.client.stop = async () => { throw new Error("stop timed out"); };
    await expect(playGame(game.client, {})).rejects.toThrow("stop timed out");
    expect(game.runtime()).toBe(first);
  });

  it("rejects invalid launch arguments before stopping the existing game", async () => {
    const game = engine();
    await playGame(game.client, {});
    const first = game.runtime();
    await expect(playGame(game.client, { fixed_fps: 0 })).rejects.toThrow(/fixed_fps/);
    expect(game.runtime()).toBe(first);
  });

  it.each([false, true])("reports a competing launch instead of claiming a fresh run (focus:%s)", async (focus) => {
    const game = engine();
    const stop = game.client.stop;
    game.client.stop = async () => {
      const receipt = await stop();
      await game.client.play(); // A different caller launches before ours.
      return receipt;
    };
    expect(await playGame(game.client, { focus })).toMatchObject({ ok: false, failure_reason: "game_not_restarted" });
    expect(game.runtime()!.pid).toBe(1); // No destructive retry loop.
  });

  it("named offscreen launches leave the main game running", async () => {
    const game = engine();
    await playGame(game.client, {});
    const first = game.runtime();
    game.client.executeOps = async () => ({ ok: false, failure_reason: "instance_exists", error: "instance a already exists" });
    expect(await playGame(game.client, { instance: "a", mode: "offscreen" })).toMatchObject({ ok: false, failure_reason: "instance_exists" });
    expect(game.runtime()).toBe(first);
  });
});
