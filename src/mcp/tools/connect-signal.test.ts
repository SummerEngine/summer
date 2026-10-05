import { describe, expect, it, vi } from "vitest";

vi.mock("../server.js", () => ({ getClient: vi.fn(), resetClient: vi.fn() }));
vi.mock("../../core/telemetry.js", () => ({ recordMcpSession: vi.fn() }));

import { getClient } from "../server.js";
import { registerSceneTools } from "./scene-tools.js";
import { FakeSceneEngine } from "../../test-helpers/fake-scene-engine.js";
import { connectScript, connectSignalPersisted } from "../../core/capabilities/connect-signal.js";
import { honestSceneReceipt } from "../../core/capabilities/engine-receipt.js";
import { dispatchTool } from "../../core/capabilities/tool-dispatch.js";

const SCENE = "res://_bugcheck2/check.tscn";
const OTHER = "res://three_houses_v2.tscn";
const LINE = '[connection signal="timeout" from="Clock" to="Door" method="queue_free"]';

const LEVEL = `[gd_scene format=3]

[node name="Root" type="Node3D"]

[node name="Clock" type="Timer" parent="."]

[node name="Door" type="Node3D" parent="."]
`;

const ARGS = { scenePath: SCENE, emitter: "./Clock", signal: "timeout", receiver: "Door", method: "queue_free" };

function engine(tscn = LEVEL, options: Partial<ConstructorParameters<typeof FakeSceneEngine>[2]> = {}) {
  return new FakeSceneEngine(SCENE, tscn, { scenes: {}, ...options });
}

type RegisteredTool = { name: string; handler: (args: Record<string, unknown>) => Promise<unknown> };
type ToolText = { isError?: boolean; content: Array<{ text: string }> };

function sceneTool(name: string): RegisteredTool {
  const registered: RegisteredTool[] = [];
  registerSceneTools({
    tool(toolName: string, _description: string, _schema: unknown, handler: RegisteredTool["handler"]) {
      registered.push({ name: toolName, handler });
      return { name: toolName };
    },
  } as never);
  return registered.find((candidate) => candidate.name === name)!;
}

describe("the fake engine reproduces the ConnectSignal field bug (regression guard)", () => {
  it("a raw ConnectSignal answers ok and the save 'ran', but the file has no [connection] line", async () => {
    const fake = engine();
    const receipt = (await fake.executeIdentityBoundOps(
      [{ op: "ConnectSignal", emitter: "Clock", signal: "timeout", receiver: "Door", method: "queue_free" }],
      { scenePath: SCENE }
    )) as { results: Array<{ ok: boolean }> };
    expect(receipt.results[0]!.ok).toBe(true);
    const save = (await fake.executeIdentityBoundOps([{ op: "SaveScene" }], { scenePath: SCENE })) as Record<string, unknown>;
    expect(save.scenePersistence).toMatchObject({ saved: true });
    expect(fake.savedScene().connections).toEqual([]);
  });
});

describe("summer_connect_signal persists the connection and verifies it", () => {
  it("connects with CONNECT_PERSIST through RunSceneScript, saves, and finds the [connection] line", async () => {
    const fake = engine();
    const result = await connectSignalPersisted(fake, ARGS);

    expect(result).toMatchObject({
      ok: true,
      persisted: true,
      verified: true,
      scenePath: SCENE,
      connection: { signal: "timeout", from: "Clock", to: "Door", method: "queue_free" },
      line: LINE,
      scenePersistence: { saved: true, verified: true },
      tab_clean: true,
    });
    expect(fake.disk.get(SCENE)).toContain(LINE);
    expect(fake.opsSent()).toEqual(["SaveScene", "RunSceneScript", "SaveScene"]);
    expect(fake.opsSent()).not.toContain("ConnectSignal");
    // RunSceneScript marked the tab unsaved; the final save leaves it clean.
    expect(fake.unsaved.size).toBe(0);
    const script = String(fake.sent[1]![0]!.script_source);
    expect(script).toContain("Object.CONNECT_PERSIST");
    expect(fake.sent[1]![0]).toMatchObject({ op: "RunSceneScript", checkpoint: false });
  });

  it("brings a background tab forward for the probe and restores the user's tab", async () => {
    const fake = engine(LEVEL, { activeScene: OTHER, openScenes: [OTHER] });
    const result = await connectSignalPersisted(fake, ARGS);
    expect(result).toMatchObject({ ok: true, verified: true, tab_switched: { to: SCENE, restored: OTHER } });
    expect(fake.sent.map((ops) => `${ops[0]!.op}${ops[0]!.path ? ` ${ops[0]!.path}` : ""}`)).toEqual([
      "SaveScene",
      `OpenScene ${SCENE}`,
      "RunSceneScript",
      "SaveScene",
      `OpenScene ${OTHER}`,
    ]);
    expect(fake.activeScene).toBe(OTHER);
    expect(fake.unsaved.has(OTHER)).toBe(false);
    expect(fake.unsaved.size).toBe(0);
  });

  it("replaces a non-persistent connection left by an earlier raw ConnectSignal", async () => {
    const fake = engine();
    await fake.executeIdentityBoundOps([{ op: "ConnectSignal", emitter: "Clock", signal: "timeout", receiver: "Door", method: "queue_free" }]);
    const result = await connectSignalPersisted(fake, ARGS);
    expect(result).toMatchObject({ ok: true, verified: true, replaced_non_persistent: true });
    expect(fake.disk.get(SCENE)!.split(LINE).length - 1).toBe(1);
  });

  it("a connection the saved file already holds is reported as done; nothing but the pre-save is sent", async () => {
    const fake = engine(`${LEVEL}\n${LINE}\n`);
    const result = await connectSignalPersisted(fake, ARGS);
    expect(result).toMatchObject({ ok: true, persisted: true, verified: true, already_connected: true, line: LINE });
    expect(fake.opsSent()).toEqual(["SaveScene"]);
  });

  it("reports persisted:false with failure_reason not_persisted when the saved file lacks the line", async () => {
    const fake = engine(LEVEL, { saveDropsChanges: true });
    const result = await connectSignalPersisted(fake, ARGS);
    expect(result).toMatchObject({ ok: false, failure_reason: "not_persisted", persisted: false, verified: false });
    expect(String(result.error)).toContain("did NOT persist");
    expect(String(result.error)).toContain('signal="timeout"');
  });

  it("an unknown signal is a structured failure; the tab is saved clean and nothing is connected", async () => {
    const fake = engine(LEVEL, { unknownSignals: ["tick"] });
    const result = await connectSignalPersisted(fake, { ...ARGS, signal: "tick" });
    expect(result).toMatchObject({ ok: false, failure_reason: "signal_not_found", persisted: false });
    expect(fake.savedScene().connections).toEqual([]);
    expect(fake.unsaved.size).toBe(0);
  });

  it("a missing emitter is a structured failure", async () => {
    const fake = engine();
    const result = await connectSignalPersisted(fake, { ...ARGS, emitter: "Nope" });
    expect(result).toMatchObject({ ok: false, failure_reason: "emitter_not_found" });
  });

  it("MCP face: success is a verified receipt; a lying save is isError with not_persisted", async () => {
    const good = engine();
    vi.mocked(getClient).mockResolvedValue(good as never);
    const ok = (await sceneTool("summer_connect_signal").handler(ARGS)) as ToolText;
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse(ok.content[0]!.text)).toMatchObject({ ok: true, persisted: true, verified: true, line: LINE });

    const lying = engine(LEVEL, { saveDropsChanges: true });
    vi.mocked(getClient).mockResolvedValue(lying as never);
    const bad = (await sceneTool("summer_connect_signal").handler(ARGS)) as ToolText;
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain("not_persisted");
    expect(bad.content[0]!.text).toContain("persisted:false");
  });

  it("CLI face runs the same implementation", async () => {
    const fake = engine();
    const result = await dispatchTool("connect-signal", ARGS, { engine: async () => fake as never });
    expect(result).toMatchObject({ ok: true, persisted: true, verified: true });
    expect(fake.disk.get(SCENE)).toContain(LINE);
  });

  it("validates before sending anything, and refuses when the engine lacks RunSceneScript", async () => {
    const fake = engine();
    await expect(connectSignalPersisted(fake, { ...ARGS, scenePath: "res://level.scn" })).rejects.toThrow(/\.tscn/);
    await expect(connectSignalPersisted(fake, { ...ARGS, signal: "time out" })).rejects.toThrow(/signal/);
    await expect(connectSignalPersisted(fake, { ...ARGS, method: "" })).rejects.toThrow(/method/);
    expect(fake.sent).toEqual([]);

    const old = engine(LEVEL, { opKinds: ["SaveScene", "ConnectSignal"] });
    const result = await connectSignalPersisted(old, ARGS);
    expect(result).toMatchObject({ ok: false, failure_reason: "engine_lacks_op", op: "RunSceneScript" });
    expect(old.sent).toEqual([]);
  });
});

describe("connectScript", () => {
  it("embeds the arguments as escaped string constants", () => {
    const source = connectScript("res://a b.tscn", 'Odd"Name', "pressed", "./UI/Start", "_on_start");
    expect(source).toContain('const TARGET_SCENE := "res://a b.tscn"');
    expect(source).toContain('const EMITTER := "Odd\\"Name"');
    expect(source).toContain("emitter.connect(SIGNAL_NAME, callable, Object.CONNECT_PERSIST)");
    expect(source).toMatch(/^func run\(ctx\):$/m);
  });
});

describe("honestSceneReceipt", () => {
  it("renames scenePersistence.persisted to saved, in nested chunk receipts too", () => {
    const raw = {
      status: "ok",
      scenePersistence: { ok: true, attempted: true, persisted: true, scenePath: SCENE },
      receipts: [{ scenePersistence: { ok: true, attempted: false, persisted: false } }, { status: "ok" }],
    };
    expect(honestSceneReceipt(raw)).toEqual({
      status: "ok",
      scenePersistence: { ok: true, attempted: true, saved: true, scenePath: SCENE },
      receipts: [{ scenePersistence: { ok: true, attempted: false, saved: false } }, { status: "ok" }],
    });
    expect(honestSceneReceipt(null)).toBeNull();
    expect(honestSceneReceipt({ status: "ok" })).toEqual({ status: "ok" });
  });
});
