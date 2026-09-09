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
 * Two suites share this file:
 *  - summer_screenshot against the REAL frames of the 2026-09-03 e2e run
 *    (docs/design/E2E-2026-09-03.md F-01 / F-05 / F-15). 01 is the all-black
 *    viewport capture that shipped with a "describe what you see" caption; 04 is
 *    a genuine 2D editor frame; 02 is the offscreen render of the 2D room whose
 *    caption falsely warned about a missing Camera3D.
 *  - the wave I perception surface: fixed-pose framings + Set-of-Mark overlay on
 *    target:"scene" and summer_camera_bookmark, driven with a fake (non-JPEG)
 *    frame — the content check reports "unavailable" for it, which is the
 *    honest answer for bytes no decoder can read.
 */
type Content = { type: string; text?: string; data?: string; mimeType?: string };
type Result = { isError?: boolean; content: Content[] };
type ToolResult = Result;
type RegisteredTool = { name: string; handler: (args: Record<string, unknown>) => Promise<unknown> };

function tools(): RegisteredTool[] {
  const registered: RegisteredTool[] = [];
  registerVisualTools({
    tool(name: string, _description: string, _schema: Record<string, unknown>, handler: RegisteredTool["handler"]) {
      registered.push({ name, handler });
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

const screenshotTool = (): RegisteredTool => tool("summer_screenshot");

/** All text blocks joined — the screenshot caption is the SECOND block (after the image). */
const text = (result: unknown): string =>
  (result as Result).content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
const image = (r: Result): Content | undefined => r.content.find((c) => c.type === "image");

// --- real e2e frames (F-01 / F-05 / F-15 suites) ---
const E2E_DIR = join(PACKAGE_ROOT, "docs", "design", "e2e");
const frame64 = (name: string): string => readFileSync(join(E2E_DIR, name)).toString("base64");
const BLACK = frame64("01-mcp-viewport-black.jpg");
const GOOD_2D = frame64("04-mcp-viewport-preplay.jpg");
const SCENE_RENDER = frame64("02-mcp-scene-render-pausemenu.jpg");



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

// --- wave I perception (fixed-pose framings, marks, camera bookmarks), fake frame ---
const PNG = Buffer.from("pixels").toString("base64");

function fakeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    base64: PNG,
    mime: "image/jpeg",
    width: 640,
    height: 480,
    localPath: "/tmp/scene.jpg",
    framing: "iso",
    metadata: {},
    ...overrides,
  };
}


describe("registration", () => {
  it("registers summer_screenshot and summer_camera_bookmark", () => {
    expect(tools().map((t) => t.name)).toEqual(["summer_screenshot", "summer_camera_bookmark"]);
  });
});

describe("summer_screenshot — fixed-pose framings + marks (wave I)", () => {
  it("sends framing bookmark:<name> and the marks params to scenePreview", async () => {
    const scenePreview = vi.fn().mockResolvedValue(
      fakeSnapshot({
        framing: "bookmark:hero",
        metadata: {
          framing_source: "bookmark",
          bookmark: "hero",
          camera_pose: { position: "Vector3(0, 5, 12)", look_at: "Vector3(0, 1, 0)", fov: 55 },
          environment_used: "scene_world_environment",
          marks: [
            { id: 1, path: "Props/Crate_02", class: "MeshInstance3D", screen_rect: { x: 120, y: 80, w: 200, h: 140 } },
            { id: 2, path: "Ground", class: "MeshInstance3D", screen_rect: { x: 0, y: 300, w: 640, h: 180 } },
          ],
          marks_skipped: 1,
          marks_candidates: 3,
          marks_truncated: false,
          max_marks: 32,
        },
      })
    );
    vi.mocked(getClient).mockResolvedValue({ scenePreview } as never);

    const result = (await tool("summer_screenshot").handler({
      target: "scene",
      framing: "bookmark",
      bookmark_name: "hero",
      marks: true,
      max_marks: 32,
      fov: 55,
    })) as ToolResult;

    expect(result.isError).toBeFalsy();
    expect(scenePreview).toHaveBeenCalledWith({ framing: "bookmark:hero", fov: 55, marks: true, maxMarks: 32 });
    expect(result.content[0]).toMatchObject({ type: "image", data: PNG });
    const caption = text(result);
    expect(caption).toContain("framing: bookmark:hero");
    expect(caption).toContain('framing source: bookmark "hero"');
    expect(caption).toContain("camera pose: position Vector3(0, 5, 12), look_at Vector3(0, 1, 0), fov 55");
    expect(caption).toContain("marks: 2 numbered label(s) drawn (3 candidate(s), 1 skipped off-screen/extent-less)");
    expect(caption).toContain("1 -> Props/Crate_02 (MeshInstance3D) @ 120,80 200x140");
    expect(caption).toContain("2 -> Ground (MeshInstance3D)");
    // Same-framing echo: no old-engine warning.
    expect(caption).not.toContain("predates the free/bookmark framings");
  });

  it("infers framing free from a camera pose and forwards camera_position/camera_look_at", async () => {
    const scenePreview = vi.fn().mockResolvedValue(
      fakeSnapshot({ framing: "free", metadata: { framing_source: "free", camera_pose: { position: "Vector3(1, 2, 3)", look_at: "Vector3(0, 0, 0)", fov: 60 } } })
    );
    vi.mocked(getClient).mockResolvedValue({ scenePreview } as never);

    const result = (await tool("summer_screenshot").handler({
      target: "scene",
      scenePath: "res://main.tscn",
      camera_position: "Vector3(1, 2, 3)",
      camera_look_at: "Vector3(0, 0, 0)",
    })) as ToolResult;

    expect(result.isError).toBeFalsy();
    expect(scenePreview).toHaveBeenCalledWith({
      scenePath: "res://main.tscn",
      framing: "free",
      cameraPosition: "Vector3(1, 2, 3)",
      cameraLookAt: "Vector3(0, 0, 0)",
    });
    expect(text(result)).toContain("framing source: free");
  });

  it("confesses when an older engine echoes a preset for a requested fixed pose", async () => {
    const scenePreview = vi.fn().mockResolvedValue(fakeSnapshot({ framing: "iso", usedSyntheticCamera: true, metadata: {} }));
    vi.mocked(getClient).mockResolvedValue({ scenePreview } as never);

    const result = (await tool("summer_screenshot").handler({
      target: "scene",
      framing: "bookmark",
      bookmark_name: "hero",
      marks: true,
    })) as ToolResult;

    expect(result.isError).toBeFalsy();
    const caption = text(result);
    expect(caption).toContain('you asked for framing:"bookmark:hero" but this Summer Engine build resolved it to "iso"');
    expect(caption).toContain("not pose-stable");
    // marks:true ignored (no marks key at all) -> say there are no labels.
    expect(caption).toContain("marks:true but this Summer Engine build ignored it");
    expect(caption).toContain("NO numbered labels");
  });

  it("reports marks_unsupported on a 2D scene honestly", async () => {
    const scenePreview = vi.fn().mockResolvedValue(
      fakeSnapshot({ framing: "iso", metadata: { marks: [], marks_unsupported: "2d_scene", marks_candidates: 0, marks_skipped: 0 } })
    );
    vi.mocked(getClient).mockResolvedValue({ scenePreview } as never);

    const result = (await tool("summer_screenshot").handler({ target: "scene", marks: true })) as ToolResult;
    const caption = text(result);
    expect(caption).toContain("marks: unsupported for this scene (2d_scene)");
    expect(caption).not.toContain("ignored it");
  });

  it("refuses a contradictory framing before sending (invalid_input, nothing sent)", async () => {
    const scenePreview = vi.fn();
    vi.mocked(getClient).mockResolvedValue({ scenePreview } as never);
    const registered = tool("summer_screenshot");

    const noName = (await registered.handler({ target: "scene", framing: "bookmark" })) as ToolResult;
    expect(noName.isError).toBe(true);
    expect(text(noName)).toContain("invalid_input");
    expect(text(noName)).toContain("bookmark_name");

    const halfPose = (await registered.handler({ target: "scene", framing: "free", camera_position: "Vector3(0, 0, 0)" })) as ToolResult;
    expect(halfPose.isError).toBe(true);
    expect(text(halfPose)).toContain("BOTH camera_position and camera_look_at");

    const presetWithPose = (await registered.handler({ target: "scene", framing: "iso", bookmark_name: "hero" })) as ToolResult;
    expect(presetWithPose.isError).toBe(true);
    // Classified failures render as JSON, so quotes inside the hint are escaped.
    expect(text(presetWithPose)).toContain("is a fixed preset; camera_position/camera_look_at need framing");

    expect(scenePreview).not.toHaveBeenCalled();
  });

  it("teaches unknown_bookmark with the engine's available names", async () => {
    const scenePreview = vi.fn().mockResolvedValue({
      ok: false,
      error: "unknown bookmark 'hero'; available: front_door, tower",
      failureReason: "unknown_bookmark",
      metadata: { available: ["front_door", "tower"] },
    });
    vi.mocked(getClient).mockResolvedValue({ scenePreview } as never);

    const result = (await tool("summer_screenshot").handler({ target: "scene", framing: "bookmark", bookmark_name: "hero" })) as ToolResult;
    expect(result.isError).toBe(true);
    const body = text(result);
    expect(body).toContain("unknown_bookmark");
    expect(body).toContain("List the saved names with summer_camera_bookmark action:");
    expect(body).toContain("front_door, tower");
  });

  it("keeps the plain viewport capture unchanged (no scene params sent)", async () => {
    const viewportSnapshot = vi.fn().mockResolvedValue(fakeSnapshot({ framing: undefined }));
    const scenePreview = vi.fn();
    vi.mocked(getClient).mockResolvedValue({ viewportSnapshot, scenePreview } as never);

    const result = (await tool("summer_screenshot").handler({})) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(viewportSnapshot).toHaveBeenCalledTimes(1);
    expect(scenePreview).not.toHaveBeenCalled();
    expect(text(result)).toContain("Editor viewport (640x480)");
  });
});

describe("summer_camera_bookmark", () => {
  const envelope = (result: Record<string, unknown>) => ({ status: "ok", results: [{ ok: true, ...result }] });

  it("save without a pose sends SaveCameraBookmark {name} and explains how to reuse it", async () => {
    const executeOps = vi.fn().mockResolvedValue(
      envelope({ op: "SaveCameraBookmark", name: "hero", pose_source: "editor_viewport", overwritten: false, path: "res://.summer/camera_bookmarks.json" })
    );
    vi.mocked(getClient).mockResolvedValue({ executeOps } as never);

    const result = (await tool("summer_camera_bookmark").handler({ action: "save", name: "hero" })) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(executeOps).toHaveBeenCalledWith([{ op: "SaveCameraBookmark", name: "hero" }]);
    const body = text(result);
    expect(body).toContain('Saved camera bookmark "hero" from the current editor 3D viewport camera');
    expect(body).toContain('framing:"bookmark" bookmark_name:"hero"');
  });

  it("save with an explicit pose forwards position/look_at/fov as given", async () => {
    const executeOps = vi.fn().mockResolvedValue(envelope({ op: "SaveCameraBookmark", name: "top_down", pose_source: "explicit", overwritten: true }));
    vi.mocked(getClient).mockResolvedValue({ executeOps } as never);

    const result = (await tool("summer_camera_bookmark").handler({
      action: "save",
      name: "top_down",
      position: "Vector3(0, 20, 0)",
      look_at: "Vector3(0, 0, 0)",
      fov: 45,
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(executeOps).toHaveBeenCalledWith([
      { op: "SaveCameraBookmark", name: "top_down", position: "Vector3(0, 20, 0)", look_at: "Vector3(0, 0, 0)", fov: 45 },
    ]);
    expect(text(result)).toContain("replaced an existing bookmark");
  });

  it("list and delete send their own op kinds and summarize names", async () => {
    const executeOps = vi
      .fn()
      .mockResolvedValueOnce(envelope({ op: "ListCameraBookmarks", names: ["front_door", "tower"], count: 2, bookmarks: {} }))
      .mockResolvedValueOnce(envelope({ op: "DeleteCameraBookmark", name: "tower", deleted: true, remaining: ["front_door"] }));
    vi.mocked(getClient).mockResolvedValue({ executeOps } as never);

    const listed = (await tool("summer_camera_bookmark").handler({ action: "list" })) as ToolResult;
    expect(text(listed)).toContain("2 camera bookmark(s): front_door, tower");
    const deleted = (await tool("summer_camera_bookmark").handler({ action: "delete", name: "tower" })) as ToolResult;
    expect(text(deleted)).toContain('Deleted camera bookmark "tower". Remaining: front_door.');
    expect(executeOps.mock.calls.map((call) => call[0])).toEqual([
      [{ op: "ListCameraBookmarks" }],
      [{ op: "DeleteCameraBookmark", name: "tower" }],
    ]);
  });

  it("refuses bad names and half-given poses before sending (invalid_input)", async () => {
    const executeOps = vi.fn();
    vi.mocked(getClient).mockResolvedValue({ executeOps } as never);
    const registered = tool("summer_camera_bookmark");

    const noName = (await registered.handler({ action: "save" })) as ToolResult;
    expect(noName.isError).toBe(true);
    expect(text(noName)).toContain("invalid_input");
    expect(text(noName)).toContain("needs a bookmark name");

    const badName = (await registered.handler({ action: "delete", name: "hero shot!" })) as ToolResult;
    expect(badName.isError).toBe(true);
    expect(text(badName)).toContain("is invalid");

    const halfPose = (await registered.handler({ action: "save", name: "hero", position: "Vector3(0, 0, 0)" })) as ToolResult;
    expect(halfPose.isError).toBe(true);
    expect(text(halfPose)).toContain("position and look_at go together");

    expect(executeOps).not.toHaveBeenCalled();
  });

  it("pre-flights the op kind of THIS action: list allowed, save refused when only ListCameraBookmarks is advertised", async () => {
    const executeOps = vi.fn().mockResolvedValue(envelope({ op: "ListCameraBookmarks", names: [], count: 0 }));
    vi.mocked(getClient).mockResolvedValue({
      executeOps,
      getEngineCapabilities: () => ({ opKinds: ["ListCameraBookmarks", "ScenePreview"] }),
      getEngineVersion: () => "0.5.66",
    } as never);
    const registered = tool("summer_camera_bookmark");

    const listed = (await registered.handler({ action: "list" })) as ToolResult;
    expect(listed.isError).toBeFalsy();
    expect(text(listed)).toContain("No camera bookmarks saved");

    const saved = (await registered.handler({ action: "save", name: "hero" })) as ToolResult;
    expect(saved.isError).toBe(true);
    expect(text(saved)).toContain("engine_lacks_op");
    expect(text(saved)).toContain("SaveCameraBookmark");
    expect(text(saved)).toContain("engine version 0.5.66");
    expect(text(saved)).toContain("camera_position + camera_look_at");
    expect(executeOps).toHaveBeenCalledTimes(1);
  });

  it("rewrites an old engine's unknown-op answer into engine_lacks_op (no capability advert)", async () => {
    const executeOps = vi.fn().mockResolvedValue({
      ok: false,
      results: [{ ok: false, op: "SaveCameraBookmark", error: "unknown op: SaveCameraBookmark" }],
    });
    vi.mocked(getClient).mockResolvedValue({ executeOps } as never);

    const result = (await tool("summer_camera_bookmark").handler({ action: "save", name: "hero" })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("doesn't support SaveCameraBookmark yet");
    expect(text(result)).toContain("engine_lacks_op");
  });

  it("teaches not_found with the available names and no_editor_camera with the explicit-pose recovery", async () => {
    const executeOps = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        results: [{ ok: false, op: "DeleteCameraBookmark", failure_reason: "not_found", error: "no bookmark 'x'", available: ["front_door"] }],
      })
      .mockResolvedValueOnce({
        ok: false,
        results: [{ ok: false, op: "SaveCameraBookmark", failure_reason: "no_editor_camera", error: "no viewport camera" }],
      });
    vi.mocked(getClient).mockResolvedValue({ executeOps } as never);
    const registered = tool("summer_camera_bookmark");

    const missing = (await registered.handler({ action: "delete", name: "x" })) as ToolResult;
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("not_found");
    expect(text(missing)).toContain("Saved bookmarks: front_door");

    const noCamera = (await registered.handler({ action: "save", name: "hero" })) as ToolResult;
    expect(noCamera.isError).toBe(true);
    expect(text(noCamera)).toContain("no_editor_camera");
    expect(text(noCamera)).toContain("Pass position and look_at explicitly");
  });
});
