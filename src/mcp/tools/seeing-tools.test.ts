import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../server.js", () => ({
  getClient: vi.fn(),
  resetClient: vi.fn(),
}));

vi.mock("../../core/telemetry.js", () => ({
  recordMcpSession: vi.fn(),
}));

import { getClient } from "../server.js";
import { registerSeeingTools } from "./seeing-tools.js";
import { registerVisualTools } from "./visual-tools.js";
import { fakeEngine, OK_JPEG } from "../../test-helpers/seeing-engine.js";

type Content = { type: string; text?: string; data?: string; mimeType?: string };
type Result = { isError?: boolean; content: Content[] };
type RegisteredTool = { name: string; description: string; handler: (args: Record<string, unknown>) => Promise<unknown> };

function tools(register: (server: never) => void = registerSeeingTools): RegisteredTool[] {
  const registered: RegisteredTool[] = [];
  register({
    tool(name: string, description: string, _schema: Record<string, unknown>, handler: RegisteredTool["handler"]) {
      registered.push({ name, description, handler });
      return { name };
    },
  } as never);
  return registered;
}

const tool = (name: string, register?: (server: never) => void) => tools(register).find((t) => t.name === name)!;

let project: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "seeing-mcp-"));
  writeFileSync(join(project, "project.godot"), "config_version=5\n");
});
afterEach(() => {
  rmSync(project, { recursive: true, force: true });
  vi.mocked(getClient).mockReset();
});

const bounds = (config: Record<string, unknown>) => ({
  ok: true,
  subjects: ((config.subjects ?? []) as string[]).map((p) => ({ path: p, resolved: p, has_geometry: true, visuals: 3, aabb: { position: [-1, 0, -1], size: [2, 2, 2] } })),
});

describe("seeing tools — MCP face", () => {
  it("registers the five tools with descriptions that state read-only and inline images", () => {
    const registered = tools();
    expect(registered.map((t) => t.name)).toEqual(["summer_frame_nodes", "summer_shot_sheet", "summer_debug_views", "summer_zoom", "summer_frame_shot"]);
    for (const t of registered) {
      expect(t.description).toContain("The image arrives inline");
      expect(t.description).toContain("failure_reason");
    }
  });

  it("returns ONE inline image block plus a compact caption", async () => {
    vi.mocked(getClient).mockResolvedValue(fakeEngine({ projectRoot: project, analyze: bounds }) as never);
    const result = (await tool("summer_frame_nodes").handler({ scenePath: "res://a.tscn", nodes: ["Crate"] })) as Result;
    expect(result.isError).toBeFalsy();
    expect(result.content.map((c) => c.type)).toEqual(["image", "text"]);
    expect(result.content[0]).toMatchObject({ type: "image", mimeType: "image/jpeg", data: OK_JPEG.toString("base64") });
    expect(Buffer.byteLength(result.content[1]!.text!)).toBeLessThan(5000);
  });

  it("returns structured failures (isError + failure_reason JSON), never a silent fallback", async () => {
    vi.mocked(getClient).mockResolvedValue(fakeEngine({ projectRoot: project, silentKernel: true }) as never);
    const result = (await tool("summer_debug_views").handler({ scenePath: "res://a.tscn", camera_position: "Vector3(0, 2, 5)", camera_look_at: "Vector3(0, 0, 0)" })) as Result;
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]!.text!);
    expect(body.failure_reason).toBe("probe_did_not_run");
  });

  it("classifies bad arguments as invalid_input with nothing sent", async () => {
    const engine = fakeEngine({ projectRoot: project });
    vi.mocked(getClient).mockResolvedValue(engine as never);
    const result = (await tool("summer_zoom").handler({ scenePath: "res://a.tscn", bookmark_name: "hero" })) as Result;
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text!)).toMatchObject({ failure_reason: "invalid_input", sent: false });
    expect(engine.calls).toEqual([]);
  });
});

describe("summer_screenshot keeps one previous image per bookmark and can compare", () => {
  const bookmarks = { hero: { position: "Vector3(0, 5, 20)", look_at: "Vector3(0, 2, 0)", fov: 55 } };

  function screenshotClient() {
    const engine = fakeEngine({ projectRoot: project, bookmarks });
    return Object.assign(engine, {
      scenePreview: vi.fn().mockResolvedValue({ ok: true, base64: OK_JPEG.toString("base64"), mime: "image/jpeg", width: 1024, height: 768, framing: "bookmark:hero", metadata: {} }),
      getSceneState: vi.fn().mockResolvedValue({}),
    });
  }

  it("a clean bookmark render becomes that bookmark's previous image", async () => {
    vi.mocked(getClient).mockResolvedValue(screenshotClient() as never);
    const result = (await tool("summer_screenshot", registerVisualTools).handler({ target: "scene", framing: "bookmark", bookmark_name: "hero" })) as Result;
    expect(result.isError).toBeFalsy();
    expect(existsSync(join(project, ".summer", "shots", "hero.jpg"))).toBe(true);
    expect(result.content.at(-1)!.text).toContain("res://.summer/shots/hero.jpg");
  });

  it("a marks render is not kept", async () => {
    vi.mocked(getClient).mockResolvedValue(screenshotClient() as never);
    const result = (await tool("summer_screenshot", registerVisualTools).handler({ target: "scene", framing: "bookmark", bookmark_name: "hero", marks: true })) as Result;
    expect(existsSync(join(project, ".summer", "shots"))).toBe(false);
    expect(result.content.at(-1)!.text).toContain("not kept");
  });

  it("compare_previous returns previous | now | difference as one image", async () => {
    mkdirSync(join(project, ".summer", "shots"), { recursive: true });
    writeFileSync(join(project, ".summer", "shots", "hero.jpg"), OK_JPEG);
    const client = screenshotClient();
    vi.mocked(getClient).mockResolvedValue(client as never);
    const result = (await tool("summer_screenshot", registerVisualTools).handler({ target: "scene", scenePath: "res://a.tscn", framing: "bookmark", bookmark_name: "hero", compare_previous: true })) as Result;
    expect(result.isError).toBeFalsy();
    expect(result.content.filter((c) => c.type === "image")).toHaveLength(1);
    expect((client.configs[0]!.tiles as Array<{ kind: string }>).map((t) => t.kind)).toEqual(["prev", "shot", "diff"]);
    expect(result.content.at(-1)!.text).toContain("of pixels changed visibly");
  });

  it("compare_previous without a bookmark framing is refused before anything is sent", async () => {
    const client = screenshotClient();
    vi.mocked(getClient).mockResolvedValue(client as never);
    const result = (await tool("summer_screenshot", registerVisualTools).handler({ target: "scene", framing: "iso", compare_previous: true })) as Result;
    expect(result.isError).toBe(true);
    expect(client.calls).toEqual([]);
  });
});
