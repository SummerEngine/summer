import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { EngineApiClient } from "../api-client.js";
import { PREVIEW_PAGE_HTML } from "./page.js";
import {
  EDITOR_IDLE_INTERVAL_MS,
  MAX_FRAME_INTERVAL_MS,
  MIN_FRAME_INTERVAL_MS,
  NO_EDITOR_MESSAGE,
  PreviewSource,
  frameIntervalMs,
  scheduleInputBatch,
  type PreviewEngine,
} from "./preview-source.js";
import { startPreviewServer, type PreviewServer } from "./server.js";

/**
 * `summer preview` over real HTTP on both sides: a fake Summer Engine local
 * API (the routes the preview reads, answering like engine 0.7.2 does) found
 * through a throwaway instance registry, the real EngineApiClient, and the
 * real preview server on a free port.
 */

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);
const GAME_JPEG = Buffer.from("fake-game-jpeg-bytes");
const TOKEN = "fake-engine-token";

interface FakeEngine {
  playing: boolean;
  gameFrameFails: boolean;
  opKinds: string[] | null;
  ops: Record<string, unknown>[];
  snapshots: string[];
}

const engine: FakeEngine = { playing: false, gameFrameFails: false, opKinds: null, ops: [], snapshots: [] };
let fake: Server;
let enginePort = 0;
let root: string;
let summerDir: string;
let emptySummerDir: string;
let clock = 1_000_000;
let preview: PreviewServer | null = null;

function send(res: import("node:http").ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  fake = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/health") {
      send(res, 200, {
        ok: true,
        engine: "summer",
        version: "0.7.2",
        port: enginePort,
        instanceId: "inst-1",
        projectId: "proj-1",
        projectIdHash: "hash-1",
        ...(engine.opKinds ? { capabilities: { opKinds: engine.opKinds } } : {}),
      });
      return;
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      send(res, 401, { ok: false, error: "unauthorized" });
      return;
    }
    if (url.pathname === "/api/snapshot/viewport") {
      engine.snapshots.push("viewport");
      send(res, 200, { ok: true, op: "ViewportSnapshot", image_base64: PNG.toString("base64"), mime: "image/png", width: 1, height: 1 });
      return;
    }
    if (url.pathname === "/api/snapshot/game") {
      engine.snapshots.push("game");
      if (!engine.playing) {
        send(res, 200, { ok: true, op: "GameSnapshot", game_running: false, failure_reason: "not_running" });
      } else if (engine.gameFrameFails) {
        send(res, 200, { ok: false, op: "GameSnapshot", error: "Game screenshot timeout (20 seconds)", failure_reason: "timeout" });
      } else {
        send(res, 200, {
          ok: true,
          op: "GameSnapshot",
          base64: GAME_JPEG.toString("base64"),
          mime: "image/jpeg",
          width: 640,
          height: 360,
          source_width: 1920,
          source_height: 1080,
        });
      }
      return;
    }
    if (url.pathname === "/api/state/project") {
      send(res, 200, { ok: true, data: { projectName: "Fake Harbour", entries: [] } });
      return;
    }
    if (url.pathname === "/api/state/scene") {
      send(res, 200, { ok: true, data: { scenePath: "res://main.tscn", children: [] } });
      return;
    }
    if (url.pathname === "/api/ops" && req.method === "POST") {
      let text = "";
      req.on("data", (chunk) => (text += chunk));
      req.on("end", () => {
        const body = JSON.parse(text) as { ops: Record<string, unknown>[] };
        const op = body.ops[0]!;
        engine.ops.push(op);
        if (op.op === "IsGameRunning") {
          send(res, 200, { status: "ok", results: [{ ok: true, op: "IsGameRunning", playing: engine.playing, scene: engine.playing ? "res://level.tscn" : "" }] });
        } else {
          send(res, 200, { status: "ok", results: [{ ok: true, op: op.op, scheduled: (op.events as unknown[]).length }] });
        }
      });
      return;
    }
    send(res, 404, { ok: false, error: "not found" });
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  enginePort = (fake.address() as AddressInfo).port;

  root = mkdtempSync(join(tmpdir(), "summer-preview-test-"));
  summerDir = join(root, "summer");
  emptySummerDir = join(root, "empty-summer");
  mkdirSync(join(summerDir, "instances"), { recursive: true });
  mkdirSync(join(root, "game"));
  writeFileSync(
    join(summerDir, "instances", "inst-1.json"),
    JSON.stringify({
      schemaVersion: 1,
      instanceId: "inst-1",
      pid: process.pid,
      port: enginePort,
      token: TOKEN,
      projectId: "proj-1",
      projectIdHash: "hash-1",
      projectName: "Fake Harbour",
      resourceRoot: join(root, "game"),
      heartbeatAt: Math.floor(Date.now() / 1000),
    })
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => fake.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

afterEach(async () => {
  await preview?.close();
  preview = null;
  Object.assign(engine, { playing: false, gameFrameFails: false, opKinds: null, ops: [], snapshots: [] });
});

async function startPreview(dir = summerDir): Promise<PreviewServer> {
  preview = await startPreviewServer({
    port: 0,
    strictPort: true,
    connect: () => EngineApiClient.connect(undefined, { summerDir: dir, env: {}, cwd: root }),
    now: () => clock,
  });
  return preview;
}

/** The next request is a new moment: past every throttle in the source. */
function later(): void {
  clock += 10_000;
}

function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: preview!.port, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

function post(path: string, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) {
  return fetch(`${preview!.url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

function statusOf(res: { headers: Record<string, string | string[] | undefined> }): Record<string, unknown> {
  return JSON.parse(decodeURIComponent(String(res.headers["x-summer-status"])));
}

describe("summer preview server", () => {
  it("serves one self-contained page: no outside URL, no token, a CSP that keeps it on this origin", async () => {
    await startPreview();
    const res = await get("/");
    const html = res.body.toString("utf-8");
    expect(res.status).toBe(200);
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["content-security-policy"]).toContain("connect-src 'self'");
    expect(html).toContain("/api/frame");
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain(TOKEN);
  });

  it("shows the editor viewport while no game runs, with the project and scene", async () => {
    await startPreview();
    const res = await get("/api/frame");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.body.equals(PNG)).toBe(true);
    expect(statusOf(res)).toMatchObject({
      state: "editor",
      message: "Game not running: showing the editor",
      project: "Fake Harbour",
      scene: "res://main.tscn",
      engineVersion: "0.7.2",
      frame: { source: "editor", width: 1, height: 1 },
      input: false,
    });
    expect(engine.snapshots).toEqual(["viewport"]);
  });

  it("shows the running game's frames, and the editor again once it stops", async () => {
    await startPreview();
    engine.playing = true;
    const game = await get("/api/frame");
    expect(game.headers["content-type"]).toBe("image/jpeg");
    expect(game.body.equals(GAME_JPEG)).toBe(true);
    expect(statusOf(game)).toMatchObject({ state: "game", message: "Game running: res://level.tscn", scene: "res://level.tscn", input: true });

    engine.playing = false;
    later();
    const editor = await get("/api/frame");
    expect(editor.body.equals(PNG)).toBe(true);
    expect(statusOf(editor)).toMatchObject({ state: "editor", message: "Game not running: showing the editor" });
  });

  it("says why when a running game's frame cannot be read, and shows the editor meanwhile", async () => {
    await startPreview();
    engine.playing = true;
    engine.gameFrameFails = true;
    const res = await get("/api/frame");
    expect(res.body.equals(PNG)).toBe(true);
    expect(statusOf(res)).toMatchObject({
      state: "editor",
      message: "Game running, but its frame could not be read (timeout): showing the editor",
    });
  });

  it("shares one capture between viewers asking at the same moment", async () => {
    await startPreview();
    const [a, b] = await Promise.all([get("/api/frame"), get("/api/frame")]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(statusOf(b).frame).toEqual(statusOf(a).frame);
    expect(engine.snapshots).toEqual(["viewport"]);
    const again = await get("/api/frame");
    expect(statusOf(again).frame).toEqual(statusOf(a).frame);
    expect(engine.snapshots).toEqual(["viewport"]);
    later();
    await get("/api/frame");
    expect(engine.snapshots).toEqual(["viewport", "viewport"]);
  });

  it("answers 503 with the next step while no editor runs", async () => {
    await startPreview(emptySummerDir);
    const res = await get("/api/frame");
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body.toString("utf-8"))).toMatchObject({
      service: "summer-preview",
      state: "no_editor",
      message: NO_EDITOR_MESSAGE,
      frame: null,
      intervalMs: 2000,
    });
    expect(NO_EDITOR_MESSAGE).toBe("Editor not running: run npx -y summer-engine@latest dev");
  });

  it("captures a fresh frame on ?fresh=1 instead of sharing the last one", async () => {
    await startPreview();
    await get("/api/frame");
    await get("/api/frame");
    expect(engine.snapshots).toEqual(["viewport"]);
    clock += 2500;
    await get("/api/frame?fresh=1");
    expect(engine.snapshots).toEqual(["viewport", "viewport"]);
  });

  it("refuses API requests another site makes (Sec-Fetch-Site), so an <img> elsewhere cannot make it capture", async () => {
    await startPreview();
    for (const site of ["cross-site", "same-site"]) {
      const res = await get("/api/frame", { "sec-fetch-site": site });
      expect(res.status).toBe(403);
    }
    expect(engine.snapshots).toEqual([]);
    expect((await get("/api/frame", { "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect((await get("/", { "sec-fetch-site": "none" })).status).toBe(200);
  });

  it("still takes a key release while the game's frames cannot be read, so no key stays held", async () => {
    await startPreview();
    engine.playing = true;
    engine.gameFrameFails = true;
    const res = await get("/api/frame");
    expect(statusOf(res)).toMatchObject({ state: "editor", input: true });
    const release = await post("/api/input", { inputs: [{ kind: "key", code: "KeyW", pressed: false }] });
    expect(await release.json()).toEqual({ ok: true, sent: 1 });
    const click = await post("/api/input", { inputs: [{ kind: "click", x: 0, y: 0 }] });
    expect(click.status).toBe(409);
  });

  it("answers a failure with a fixed text and keeps the details in the local log", async () => {
    const lines: string[] = [];
    preview = await startPreviewServer({
      port: 0,
      strictPort: true,
      connect: () => EngineApiClient.connect(undefined, { summerDir, env: {}, cwd: root }),
      log: (line) => lines.push(line),
    });
    preview.source.frame = () => Promise.reject(new Error("secret detail at /Users/someone"));
    const res = await get("/api/frame");
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body.toString("utf-8"))).toEqual({ ok: false, error: "internal_error" });
    expect(lines.join("\n")).toContain("secret detail");
  });

  it("refuses a request that names another host (DNS rebinding)", async () => {
    await startPreview();
    const res = await get("/api/frame", { host: `evil.example:${preview!.port}` });
    expect(res.status).toBe(403);
    expect(engine.snapshots).toEqual([]);
  });

  it("sends clicks (scaled to the game window) and keys to the running game as one input script", async () => {
    await startPreview();
    engine.playing = true;
    await get("/api/frame");
    const res = await post("/api/input", {
      inputs: [
        { kind: "click", x: 320, y: 180, button: 1 },
        { kind: "key", code: "ArrowRight", pressed: true },
      ],
    });
    expect(await res.json()).toEqual({ ok: true, sent: 2 });
    const script = engine.ops.find((op) => op.op === "SimulateInputScript");
    expect(script).toMatchObject({
      op: "SimulateInputScript",
      wait: false,
      events: [
        { type: "mouse_click", position: [960, 540], button: 1, at_frame: 0 },
        { type: "key", keycode: 4194321, physical_keycode: 4194321, pressed: true, at_frame: 0 },
      ],
    });
  });

  it("takes input only from the page itself, and only while a game runs", async () => {
    await startPreview();
    await get("/api/frame");
    const noGame = await post("/api/input", { inputs: [{ kind: "key", code: "Space", pressed: true }] });
    expect(noGame.status).toBe(409);
    engine.playing = true;
    later();
    await get("/api/frame");
    const crossSite = await post("/api/input", { inputs: [{ kind: "key", code: "Space", pressed: true }] }, {
      "content-type": "application/json",
      origin: "https://evil.example",
    });
    expect(crossSite.status).toBe(403);
    const plainText = await post("/api/input", { inputs: [{ kind: "key", code: "Space", pressed: true }] }, { "content-type": "text/plain" });
    expect(plainText.status).toBe(403);
    expect(engine.ops.some((op) => op.op === "SimulateInputScript")).toBe(false);
  });

  it("turns input off on an engine that advertises no SimulateInputScript", async () => {
    engine.opKinds = ["IsGameRunning", "PlayGame"];
    await startPreview();
    engine.playing = true;
    const res = await get("/api/frame");
    expect(statusOf(res)).toMatchObject({ state: "game", input: false });
  });
});

describe("capture pace", () => {
  it("is at most 5 frames a second; capture takes at most half the editor's time and a sixteenth of the game's", () => {
    expect(frameIntervalMs(null)).toBe(MIN_FRAME_INTERVAL_MS);
    expect(frameIntervalMs(45)).toBe(200);
    expect(frameIntervalMs(150)).toBe(300);
    expect(frameIntervalMs(45, "editor", true)).toBe(EDITOR_IDLE_INTERVAL_MS);
    expect(frameIntervalMs(1300, "game")).toBe(20_800);
    expect(frameIntervalMs(60_000, "game")).toBe(MAX_FRAME_INTERVAL_MS);
  });

  /** A PreviewSource over a scripted engine whose captures take time on the fake clock. */
  function scripted(options: { playing: boolean; captureMs: number; frames?: () => string }) {
    let clock = 1_000_000;
    let captures = 0;
    const snap = async (): Promise<Awaited<ReturnType<PreviewEngine["viewportSnapshot"]>>> => {
      captures += 1;
      clock += options.captureMs;
      const bytes = options.frames ? options.frames() : `frame-${captures}`;
      return { ok: true, base64: Buffer.from(bytes).toString("base64"), mime: "image/jpeg", width: 4, height: 3 };
    };
    const engine: PreviewEngine = {
      viewportSnapshot: snap,
      gameSnapshot: snap,
      executeOps: async () => ({ results: [{ ok: true, op: "IsGameRunning", playing: options.playing, scene: "res://main.tscn" }] }),
      getProjectState: async () => ({}),
      getSceneState: async () => ({}),
      credentialsChanged: async () => false,
    };
    const source = new PreviewSource({ connect: async () => engine, now: () => clock });
    return {
      source,
      captures: () => captures,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  it("reads a running game about every 20 s, and a fresh frame on demand at most every 2 s", async () => {
    const run = scripted({ playing: true, captureMs: 1300 });
    await run.source.frame();
    expect(run.source.status()).toMatchObject({ state: "game", intervalMs: 20_800 });
    run.advance(5000);
    await run.source.frame();
    expect(run.captures()).toBe(1);
    await run.source.frame({ fresh: true });
    expect(run.captures()).toBe(2);
    await run.source.frame({ fresh: true });
    expect(run.captures()).toBe(2);
    run.advance(16_000);
    await run.source.frame();
    expect(run.captures()).toBe(3);
  });

  it("slows the editor to 2 fps while its view does not change, and speeds up when it does", async () => {
    let picture = "still";
    const run = scripted({ playing: false, captureMs: 45, frames: () => picture });
    for (let i = 0; i < 3; i += 1) {
      await run.source.frame();
      run.advance(500);
    }
    expect(run.source.status().intervalMs).toBe(EDITOR_IDLE_INTERVAL_MS);
    picture = "moved";
    await run.source.frame();
    expect(run.source.status().intervalMs).toBe(MIN_FRAME_INTERVAL_MS);
  });
});

describe("scheduleInputBatch", () => {
  it("puts the second event of a fast tap one frame later", () => {
    const events = scheduleInputBatch([
      { type: "key", keycode: 65, pressed: true },
      { type: "key", keycode: 65, pressed: false },
      { type: "key", keycode: 66, pressed: true },
      { type: "mouse_click", position: [1, 1], button: 1 },
      { type: "key", keycode: 66, pressed: false },
    ]);
    expect(events.map((event) => event.at_frame)).toEqual([0, 1, 1, 1, 2]);
  });
});

describe("the page script", () => {
  it("compiles", () => {
    const lower = PREVIEW_PAGE_HTML.toLowerCase();
    const start = lower.indexOf("<script>") + "<script>".length;
    const script = PREVIEW_PAGE_HTML.slice(start, lower.lastIndexOf("</script>"));
    expect(script.length).toBeGreaterThan(1000);
    expect(() => new Function(script)).not.toThrow();
  });
});

describe("EngineApiClient snapshots for the preview", () => {
  it("saveFile:false returns the frame without writing it to the snapshots folder", async () => {
    const client = new EngineApiClient(enginePort, TOKEN);
    const unsaved = await client.viewportSnapshot({ saveFile: false });
    expect(unsaved).toMatchObject({ ok: true, base64: PNG.toString("base64") });
    expect(unsaved.localPath).toBeUndefined();
    const saved = await client.viewportSnapshot();
    expect(saved.localPath).toEqual(expect.stringContaining("viewport-"));
    rmSync(saved.localPath!, { force: true });
  });
});
