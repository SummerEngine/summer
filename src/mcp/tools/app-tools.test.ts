import { expect, it, vi } from "vitest";
import { getClient } from "../server.js";
import { registerAppTools } from "./app-tools.js";

vi.mock("../server.js", () => ({ getClient: vi.fn(), resetClient: vi.fn() }));

it.each([
  ["CFG_MISSING", "plugin.cfg not found", "folder name"],
  ["NOT_EDITOR_PLUGIN", "must extend EditorPlugin", "EditorPlugin"],
])("returns the native %s rejection from the registered plugin tool", async (code, error, hint) => {
  const addonPath = "res://addons/marker/plugin.cfg";
  vi.mocked(getClient).mockResolvedValue({
    executeOps: vi.fn().mockResolvedValue({
      results: [{ op: "EnableEditorPlugin", ok: false, code, error, addonPath }],
    }),
  } as never);
  const tool = vi.fn();
  registerAppTools({ tool } as never);
  const handler = tool.mock.calls.find(([name]) => name === "summer_enable_plugin")![3];
  const reply = await handler({ plugin: "marker" });
  expect(reply.isError).toBe(true);
  expect(JSON.parse(reply.content[0].text)).toMatchObject({
    ok: false, enabled: false, code, error, addonPath, hint: expect.stringContaining(hint),
  });
});
