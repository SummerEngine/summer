import { describe, expect, it } from "vitest";
import { runSceneScriptOn, type SceneScriptClient } from "./scene-script-target.js";

const SOURCE = "func run(ctx):\n    ctx.report(\"ok\", true)\n";

function fakeClient(current: string | null, options: { openFails?: boolean } = {}) {
  const sent: Array<Record<string, unknown>[]> = [];
  let edited = current;
  const client: SceneScriptClient = {
    async getSceneState() {
      return edited ? { ok: true, data: { scenePath: edited } } : { ok: true, data: {} };
    },
    async executeIdentityBoundOps(ops) {
      sent.push(ops);
      const op = ops[0];
      if (op.op === "OpenScene") {
        if (options.openFails) return { ok: false, error: `failed to open scene ${String(op.path)} (err 7)`, results: [{ ok: false, op: "OpenScene" }] };
        edited = String(op.path);
        return { ok: true, results: [{ ok: true, op: "OpenScene" }] };
      }
      return { ok: true, results: [{ ok: true, op: "RunSceneScript", ran: true, scene: edited }] };
    },
  };
  return { client, sent };
}

describe("summer_run_script with scenePath", () => {
  it("runs against the open scene when no scenePath is given (3.x behavior)", async () => {
    const { client, sent } = fakeClient("res://a.tscn");
    const result = await runSceneScriptOn(client, { source: SOURCE });
    expect(sent.map((ops) => ops[0].op)).toEqual(["RunSceneScript"]);
    expect(result).not.toHaveProperty("scene_target");
  });

  it("opens scenePath even when it looks like the edited scene (the read may be stale), and restores nothing", async () => {
    const { client, sent } = fakeClient("res://a.tscn");
    const result = await runSceneScriptOn(client, { scenePath: "res://a.tscn", source: SOURCE });
    expect(sent.map((ops) => ops[0].op)).toEqual(["OpenScene", "RunSceneScript"]);
    expect(result).toMatchObject({ ok: true, scene_target: { scenePath: "res://a.tscn", opened: false } });
    expect((result as { scene_target: Record<string, unknown> }).scene_target).not.toHaveProperty("restored");
  });

  it("says so when the earlier tab could not be read", async () => {
    const { client, sent } = fakeClient("res://a.tscn");
    client.getSceneState = async () => {
      throw new Error("state read timed out");
    };
    const result = await runSceneScriptOn(client, { scenePath: "res://b.tscn", source: SOURCE });
    expect(sent.map((ops) => ops[0].op)).toEqual(["OpenScene", "RunSceneScript"]);
    expect(result).toMatchObject({ scene_target: { opened: true, restore_error: expect.stringContaining("state read timed out") } });
  });

  it("opens the target alone, runs, then gives the person their tab back", async () => {
    const { client, sent } = fakeClient("res://a.tscn");
    const result = await runSceneScriptOn(client, { scenePath: "res://levels/b.tscn", source: SOURCE });
    expect(sent).toEqual([
      [{ op: "OpenScene", path: "res://levels/b.tscn" }],
      [expect.objectContaining({ op: "RunSceneScript", script_source: SOURCE })],
      [{ op: "OpenScene", path: "res://a.tscn" }],
    ]);
    expect(result).toMatchObject({
      results: [{ op: "RunSceneScript", scene: "res://levels/b.tscn" }],
      scene_target: { scenePath: "res://levels/b.tscn", opened: true, restored: "res://a.tscn" },
    });
  });

  it("opens the target and restores nothing when no scene was open", async () => {
    const { client, sent } = fakeClient(null);
    const result = await runSceneScriptOn(client, { scenePath: "res://b.tscn", source: SOURCE });
    expect(sent.map((ops) => ops[0].op)).toEqual(["OpenScene", "RunSceneScript"]);
    expect(result).toMatchObject({ scene_target: { scenePath: "res://b.tscn", opened: true } });
    expect((result as { scene_target: Record<string, unknown> }).scene_target).not.toHaveProperty("restored");
  });

  it("never runs the script when the target cannot be opened", async () => {
    const { client, sent } = fakeClient("res://a.tscn", { openFails: true });
    const result = await runSceneScriptOn(client, { scenePath: "res://missing.tscn", source: SOURCE });
    expect(sent.map((ops) => ops[0].op)).toEqual(["OpenScene"]);
    expect(result).toMatchObject({ ok: false, failure_reason: "scene_target_failed", scene_target: { opened: false } });
  });

  it("refuses a scenePath that is not a res:// scene before sending anything", async () => {
    const { client, sent } = fakeClient("res://a.tscn");
    await expect(runSceneScriptOn(client, { scenePath: "res://../x.tscn", source: SOURCE })).rejects.toThrow(/scenePath/);
    await expect(runSceneScriptOn(client, { scenePath: "res://main.gd", source: SOURCE })).rejects.toThrow(/scenePath/);
    expect(sent).toEqual([]);
  });
});
