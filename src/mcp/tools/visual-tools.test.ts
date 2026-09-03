import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../server.js", () => ({
  getClient: vi.fn(),
  resetClient: vi.fn(),
}));

vi.mock("../../core/telemetry.js", () => ({
  recordMcpSession: vi.fn(),
}));

import { getClient } from "../server.js";
import { PACKAGE_ROOT } from "../../core/package-root.js";
import { registerVisualTools, VIEWPORT_RECAPTURE_DELAY_MS } from "./visual-tools.js";

/**
 * summer_screenshot against the REAL frames of the 2026-09-03 e2e run
 * (docs/design/E2E-2026-09-03.md F-01 / F-05 / F-15). 01 is the all-black
 * viewport capture that shipped with a "describe what you see" caption; 04 is
 * a genuine 2D editor frame; 02 is the offscreen render of the 2D room whose
 * caption falsely warned about a missing Camera3D.
 */
const E2E_DIR = join(PACKAGE_ROOT, "docs", "design", "e2e");
const frame64 = (name: string): string => readFileSync(join(E2E_DIR, name)).toString("base64");
const BLACK = frame64("01-mcp-viewport-black.jpg");
const GOOD_2D = frame64("04-mcp-viewport-preplay.jpg");
const SCENE_RENDER = frame64("02-mcp-scene-render-pausemenu.jpg");

type Content = { type: string; text?: string; data?: string; mimeType?: string };
type Result = { isError?: boolean; content: Content[] };
type RegisteredTool = { name: string; handler: (args: Record<string, unknown>) => Promise<unknown> };

function screenshotTool(): RegisteredTool {
  const registered: RegisteredTool[] = [];
  registerVisualTools({
    tool(name: string, _description: string, _schema: Record<string, unknown>, handler: RegisteredTool["handler"]) {
      registered.push({ name, handler });
      return { name };
    },
  } as never);
  const found = registered.find((t) => t.name === "summer_screenshot");
  if (!found) throw new Error("summer_screenshot was not registered");
  return found;
}

const text = (r: Result): string => r.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
const image = (r: Result): Content | undefined => r.content.find((c) => c.type === "image");

function snapshot(base64: string, extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    base64,
    mime: "image/jpeg",
    width: 1280,
    height: 768,
    localPath: "/tmp/summer/viewport-test.jpg",
    metadata: { source_surface: "editor_2d_subviewport_texture", capture_scope: "active_editor_viewport" },
    ...extra,
  };
}

function mockClient(overrides: Record<string, unknown>) {
  const client = {
    viewportSnapshot: vi.fn(),
    gameSnapshot: vi.fn(),
    scenePreview: vi.fn(),
    getSceneState: vi.fn(),
    ...overrides,
  };
  vi.mocked(getClient).mockResolvedValue(client as never);
  return client;
}

const tree2d = {
  ok: true,
  activeTab: "3D",
  data: {
    name: "Room01",
    class: "Node2D",
    path: ".",
    children: [
      { name: "Geometry", class: "Node2D", path: "Geometry", children: [{ name: "Ground", class: "StaticBody2D", path: "Geometry/Ground", children: [] }] },
      { name: "HUD", class: "CanvasLayer", path: "HUD", children: [{ name: "Label", class: "Label", path: "HUD/Label", children: [] }] },
    ],
  },
};
const tree3d = {
  ok: true,
  data: { name: "Main", class: "Node3D", path: ".", children: [{ name: "Floor", class: "MeshInstance3D", path: "Floor", children: [] }] },
};

afterEach(() => vi.clearAllMocks());

describe("summer_screenshot viewport — F-01 blank-frame handling", () => {
  it("returns a real frame once, labelled by its source surface, with a not-blank frame check", async () => {
    const client = mockClient({ viewportSnapshot: vi.fn().mockResolvedValue(snapshot(GOOD_2D)) });
    const result = (await screenshotTool().handler({ target: "viewport" })) as Result;
    expect(result.isError).toBeFalsy();
    expect(client.viewportSnapshot).toHaveBeenCalledTimes(1);
    expect(image(result)?.data).toBe(GOOD_2D);
    const caption = text(result);
    expect(caption).toContain("Editor viewport (2D tab)");
    expect(caption).toContain("Frame check: not blank");
    expect(caption).not.toContain("WARNING");
    // The old caption asserted the frame was real ("describe what you actually see").
    expect(caption).not.toContain("actually see");
  });

  it("recaptures once after the settle delay when the first frame is the e2e black frame, and returns the second", async () => {
    const viewportSnapshot = vi
      .fn()
      .mockResolvedValueOnce(snapshot(BLACK, { width: 1072, height: 1280 }))
      .mockResolvedValueOnce(snapshot(GOOD_2D));
    const client = mockClient({ viewportSnapshot });
    const started = Date.now();
    const result = (await screenshotTool().handler({ target: "viewport" })) as Result;
    expect(Date.now() - started).toBeGreaterThanOrEqual(VIEWPORT_RECAPTURE_DELAY_MS - 20);
    expect(client.viewportSnapshot).toHaveBeenCalledTimes(2);
    expect(image(result)?.data).toBe(GOOD_2D);
    const caption = text(result);
    expect(caption).toContain("1280x768");
    expect(caption).toContain("automatic recapture");
    expect(caption).toContain("uniformly black");
    expect(caption).toContain("Frame check: not blank");
    expect(caption).not.toContain("WARNING: this frame");
  });

  it("warns loudly and never asserts content when the recapture is black too", async () => {
    const viewportSnapshot = vi.fn().mockResolvedValue(snapshot(BLACK, { width: 1072, height: 1280 }));
    mockClient({ viewportSnapshot });
    const result = (await screenshotTool().handler({ target: "viewport" })) as Result;
    expect(result.isError).toBeFalsy(); // the frame is still returned — the caption carries the verdict
    expect(viewportSnapshot).toHaveBeenCalledTimes(2);
    const caption = text(result);
    expect(caption).toContain("WARNING: this frame is uniformly black");
    expect(caption).toContain(`automatic recapture ${VIEWPORT_RECAPTURE_DELAY_MS} ms later`);
    expect(caption).toContain("NOT evidence about lights, cameras");
    expect(caption).toContain("summer_screenshot again");
    expect(caption).not.toContain("Frame check: not blank");
  });

  it("keeps the first frame and reports the error when the recapture itself fails", async () => {
    const viewportSnapshot = vi
      .fn()
      .mockResolvedValueOnce(snapshot(BLACK, { width: 1072, height: 1280 }))
      .mockResolvedValueOnce({ ok: false, error: "Switch to 3D or 2D tab to capture scene viewport", failureReason: "wrong_editor_context" });
    mockClient({ viewportSnapshot });
    const result = (await screenshotTool().handler({ target: "viewport" })) as Result;
    expect(image(result)?.data).toBe(BLACK);
    const caption = text(result);
    expect(caption).toContain("WARNING: this frame is uniformly black");
    expect(caption).toContain("the recapture failed: Switch to 3D or 2D tab");
  });

  it("still fails loud when the capture itself fails (no recapture attempted)", async () => {
    const viewportSnapshot = vi.fn().mockResolvedValue({ ok: false, error: "Switch to 3D or 2D tab to capture scene viewport" });
    mockClient({ viewportSnapshot });
    const result = (await screenshotTool().handler({ target: "viewport" })) as Result;
    expect(result.isError).toBe(true);
    expect(viewportSnapshot).toHaveBeenCalledTimes(1);
    expect(text(result)).toContain("Switch to 3D or 2D tab");
  });
});

describe("summer_screenshot scene — F-05 camera confession by scene kind", () => {
  const preview = (extra: Record<string, unknown> = {}) =>
    snapshot(SCENE_RENDER, {
      width: 1024,
      height: 768,
      metadata: {},
      sceneHasCamera: false,
      sceneHadLight: true,
      usedSyntheticCamera: true,
      framing: "iso",
      renderRetries: 0,
      ...extra,
    });

  it("a 2D scene with no Camera2D gets a NOTE, never the Camera3D grey/black warning", async () => {
    const client = mockClient({
      scenePreview: vi.fn().mockResolvedValue(preview()),
      getSceneState: vi.fn().mockResolvedValue(tree2d),
    });
    const result = (await screenshotTool().handler({ target: "scene", scenePath: "res://scenes/rooms/room_01.tscn" })) as Result;
    expect(result.isError).toBeFalsy();
    expect(client.getSceneState).toHaveBeenCalledWith("res://scenes/rooms/room_01.tscn", { depth: 8, limit: 600 });
    const caption = text(result);
    expect(caption).not.toContain("Camera3D");
    expect(caption).toContain("no Camera2D");
    expect(caption).toContain("not an error");
    // F-05 second half: runtime-hidden UI (the PauseMenu) renders visible here.
    expect(caption).toContain("scripts not running");
    expect(caption).toContain("PauseMenu");
    expect(caption).toContain("framing: iso");
  });

  it("a 3D scene with no Camera3D keeps the grey/black warning", async () => {
    mockClient({
      scenePreview: vi.fn().mockResolvedValue(preview({ sceneHadLight: false })),
      getSceneState: vi.fn().mockResolvedValue(tree3d),
    });
    const result = (await screenshotTool().handler({ target: "scene", scenePath: "res://main.tscn" })) as Result;
    const caption = text(result);
    expect(caption).toContain("WARNING: this 3D scene has no Camera3D — it will render grey/black when played.");
    expect(caption).toContain("no light");
  });

  it("hedges when the scene tree cannot be read", async () => {
    mockClient({
      scenePreview: vi.fn().mockResolvedValue(preview()),
      getSceneState: vi.fn().mockRejectedValue(new Error("scene not loaded")),
    });
    const result = (await screenshotTool().handler({ target: "scene", scenePath: "res://x.tscn" })) as Result;
    const caption = text(result);
    expect(caption).toContain("could not be read to tell 2D from 3D (scene not loaded)");
    expect(caption).not.toContain("this 3D scene has no Camera3D");
  });

  it("does not read the tree when the scene has its own camera; untargeted preview uses the untargeted tree read", async () => {
    const withCamera = mockClient({
      scenePreview: vi.fn().mockResolvedValue(preview({ sceneHasCamera: true })),
    });
    await screenshotTool().handler({ target: "scene", scenePath: "res://main.tscn" });
    expect(withCamera.getSceneState).not.toHaveBeenCalled();

    const open = mockClient({
      scenePreview: vi.fn().mockResolvedValue(preview()),
      getSceneState: vi.fn().mockResolvedValue(tree2d),
    });
    await screenshotTool().handler({ target: "scene" });
    expect(open.getSceneState).toHaveBeenCalledWith();
  });
});

describe("summer_screenshot game — F-15 works locally; blank frames are called out", () => {
  it("returns a running-game frame captured over the local connection", async () => {
    mockClient({ gameSnapshot: vi.fn().mockResolvedValue(snapshot(frame64("05-mcp-game-frame.jpg"), { width: 1280, height: 719, metadata: {} })) });
    const result = (await screenshotTool().handler({ target: "game" })) as Result;
    expect(result.isError).toBeFalsy();
    const caption = text(result);
    expect(caption).toContain("Running game frame (1280x719)");
    expect(caption).toContain("Frame check: not blank");
  });

  it("flags a flat game frame as a boot/loading condition rather than a missing camera", async () => {
    mockClient({ gameSnapshot: vi.fn().mockResolvedValue(snapshot(BLACK, { width: 1072, height: 1280, metadata: {} })) });
    const result = (await screenshotTool().handler({ target: "game" })) as Result;
    const caption = text(result);
    expect(caption).toContain("WARNING: this game frame is uniformly black");
    expect(caption).toContain("just booted");
  });

  it("keeps the honest bridge_required failure for builds that still refuse", async () => {
    mockClient({ gameSnapshot: vi.fn().mockResolvedValue({ ok: true, failureReason: "bridge_required", error: "needs bridge" }) });
    const result = (await screenshotTool().handler({ target: "game" })) as Result;
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("on this Summer Engine build");
    expect(text(result)).toContain("save_frame");
  });
});
