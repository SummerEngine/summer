import { describe, expect, it } from "vitest";
import { QUEUED_ONLY_NOTE, enablePluginArgsSchema, enablePluginOp, interpretEnablePluginResult } from "./enable-plugin.js";

const envelope = (result: Record<string, unknown>) => ({ ok: result.ok !== false, results: [{ op: "EnableEditorPlugin", ...result }] });

describe("summer_enable_plugin", () => {
  it("sends EnableEditorPlugin with the plugin path and optional timeout", () => {
    expect(enablePluginOp(enablePluginArgsSchema.parse({ plugin: " quest_tools " }))).toEqual({ op: "EnableEditorPlugin", pluginPath: "quest_tools" });
    expect(enablePluginOp(enablePluginArgsSchema.parse({ plugin: "res://addons/q/plugin.cfg", timeoutMs: 60_000 }))).toEqual({
      op: "EnableEditorPlugin",
      pluginPath: "res://addons/q/plugin.cfg",
      timeoutMs: 60_000,
    });
    expect(() => enablePluginArgsSchema.parse({ plugin: "q", timeoutMs: 500 })).toThrow();
  });

  it("reports the real load result from engines that wait for the plugin", () => {
    expect(
      interpretEnablePluginResult(envelope({ ok: true, enabled: true, addonPath: "res://addons/q/plugin.cfg", autoloadsRegistered: ["autoload/Quests"], elapsedMs: 412 }))
    ).toEqual({ ok: true, enabled: true, addonPath: "res://addons/q/plugin.cfg", autoloadsRegistered: ["autoload/Quests"], elapsedMs: 412 });
    expect(interpretEnablePluginResult(envelope({ ok: true, alreadyEnabled: true, addonPath: "res://addons/q/plugin.cfg" }))).toMatchObject({
      ok: true,
      enabled: true,
      alreadyEnabled: true,
    });
  });

  it("passes failures through with the engine's code and a hint", () => {
    const failed = interpretEnablePluginResult(envelope({ ok: false, code: "NOT_TOOL", error: "plugin script must be a @tool script", addonPath: "res://addons/q/plugin.cfg" }));
    expect(failed).toMatchObject({ ok: false, enabled: false, code: "NOT_TOOL", error: "plugin script must be a @tool script" });
    expect(String(failed.hint)).toContain("@tool");
  });

  it("never claims success when an older engine only queued the enable", () => {
    const queued = interpretEnablePluginResult(envelope({ ok: true, alreadyEnabled: false, deferred: true, addonPath: "res://addons/q/plugin.cfg" }));
    expect(queued).toEqual({ ok: true, enabled: null, queued: true, addonPath: "res://addons/q/plugin.cfg", note: QUEUED_ONLY_NOTE });
  });
});
