import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EngineApiClient, EngineRebindError } from "./api-client.js";

// Verifies the Block E async port (commit 261a085945): the client must resolve
// the engine's async 202->poll terminal result, NOT return the queued ack; reads
// stay synchronous 200; snapshots decode image_base64; errors surface.

type Route = (url: string, method: string) => Response;

function mockFetch(route: Route) {
  vi.stubGlobal("fetch", (input: unknown, init?: { method?: string }) =>
    Promise.resolve(route(String(input), init?.method ?? "GET"))
  );
}

// Captures the request body each fetch call sends, keyed by url substring.
function mockFetchCapturing(route: Route, sink: { lastBody?: unknown }) {
  vi.stubGlobal(
    "fetch",
    (input: unknown, init?: { method?: string; body?: string }) => {
      if (typeof init?.body === "string") {
        try {
          sink.lastBody = JSON.parse(init.body);
        } catch {
          sink.lastBody = init.body;
        }
      }
      return Promise.resolve(route(String(input), init?.method ?? "GET"));
    }
  );
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const client = () => new EngineApiClient(6550, "test-token");

afterEach(() => vi.unstubAllGlobals());

describe("EngineApiClient — async 202->poll port", () => {
  it("pins every request to the engine and project captured at connect time", async () => {
    const seen: string[] = [];
    mockFetch((url) => {
      seen.push(url);
      return json({ nodes: [] });
    });
    const scoped = new EngineApiClient(6550, "test-token", {
      instanceId: "engine-a",
      projectId: "project-a",
      projectIdHash: "hash-a",
    });

    await scoped.getSceneState();

    const url = new URL(seen[0]);
    expect(url.searchParams.get("instanceId")).toBe("engine-a");
    expect(url.searchParams.get("projectId")).toBe("project-a");
    expect(url.searchParams.get("projectIdHash")).toBe("hash-a");
    expect(url.searchParams.get("projectIdentityVersion")).toBe("1");
  });

  it("updates the complete request identity after an explicit rebind", async () => {
    const seen: string[] = [];
    mockFetch((url) => {
      if (url.includes("/api/health")) {
        return json({
          ok: true,
          engine: "summer",
          version: "0.5.43",
          instanceId: "engine-b",
          projectId: "project-b",
          projectIdHash: "hash-b",
        });
      }
      seen.push(url);
      return json({ nodes: [] });
    });
    const scoped = new EngineApiClient(6550, "test-token", {
      instanceId: "engine-a",
      projectId: "project-a",
      projectIdHash: "hash-a",
    });

    await expect(scoped.rebind()).resolves.toBe("hash-b");
    await scoped.getSceneState();

    const url = new URL(seen[0]);
    expect(url.searchParams.get("instanceId")).toBe("engine-b");
    expect(url.searchParams.get("projectId")).toBe("project-b");
    expect(url.searchParams.get("projectIdHash")).toBe("hash-b");
    expect(url.searchParams.get("projectIdentityVersion")).toBe("1");
  });

  it("names the request when a 200 carries a non-JSON body", async () => {
    mockFetch(() => new Response("<html>proxy error</html>", { status: 200 }));
    await expect(client().getSceneState()).rejects.toThrow(
      /non-JSON response for GET \/api\/state\/scene/
    );
  });

  it("reaps snapshot files older than 24h when writing a new one (best-effort)", async () => {
    const dir = join(tmpdir(), "summer-engine", "snapshots");
    mkdirSync(dir, { recursive: true });
    const stale = join(dir, `viewport-stale-test-${process.pid}.jpg`);
    const fresh = join(dir, `viewport-fresh-test-${process.pid}.jpg`);
    writeFileSync(stale, "old");
    writeFileSync(fresh, "new");
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(stale, twoDaysAgo, twoDaysAgo);
    const b64 = Buffer.from("bytes").toString("base64");
    mockFetch((url) =>
      url.includes("/api/snapshot/viewport")
        ? json({ op: "ViewportSnapshot", ok: true, image_base64: b64, mime: "image/jpeg" })
        : json({}, 404)
    );

    const snap = await client().viewportSnapshot();
    try {
      expect(snap.ok).toBe(true);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
    } finally {
      for (const path of [fresh, snap.localPath]) {
        if (path) rmSync(path, { force: true });
      }
    }
  });

  it("rebind throws a typed error and keeps the old identity when health is unreadable", async () => {
    const seen: string[] = [];
    mockFetch((url) => {
      if (url.includes("/api/health")) return new Response("gone", { status: 503 });
      seen.push(url);
      return json({ nodes: [] });
    });
    const scoped = new EngineApiClient(6550, "test-token", {
      instanceId: "engine-a",
      projectId: "project-a",
      projectIdHash: "hash-a",
    });

    await expect(scoped.rebind()).rejects.toBeInstanceOf(EngineRebindError);
    await expect(scoped.rebind()).rejects.toThrow(/still bound to hash-a/);
    // Identity untouched: subsequent requests still carry the old binding.
    await scoped.getSceneState();
    expect(new URL(seen[0]).searchParams.get("projectIdHash")).toBe("hash-a");
  });

  it("executeOps resolves the TERMINAL apply result via poll, not the queued ack", async () => {
    mockFetch((url, method) => {
      if (method === "POST" && url.includes("/api/ops")) {
        return json({ accepted: true, status: "queued", requestId: "r1" }, 202);
      }
      if (url.includes("/api/ops/result")) {
        return json({
          requestId: "r1",
          status: "done",
          result: { status: "ok", results: [{ ok: true, op: "AddNode" }] },
          terminalState: "applied",
          appliedSeq: 1,
        });
      }
      return json({}, 404);
    });

    const r = (await client().executeOps([{ op: "AddNode" }])) as Record<string, unknown>;
    expect(r.status).toBe("ok"); // NOT "queued"
    expect(r.accepted).toBeUndefined(); // not the ack
    expect(r.terminalState).toBe("applied");
    expect(r.appliedSeq).toBe(1);
    expect((r.results as unknown[])).toHaveLength(1);
  });

  it("mints one stable requestId before POST and uses it for polling", async () => {
    let submittedRequestId = "";
    let polledRequestId = "";
    vi.stubGlobal(
      "fetch",
      async (input: unknown, init?: { method?: string; body?: string }) => {
        const url = String(input);
        if (init?.method === "POST" && url.includes("/api/ops")) {
          const body = JSON.parse(init.body ?? "{}") as {
            options?: { requestId?: string };
          };
          submittedRequestId = body.options?.requestId ?? "";
          return json(
            { accepted: true, status: "queued", requestId: submittedRequestId },
            202
          );
        }
        if (url.includes("/api/ops/result")) {
          polledRequestId = new URL(url).searchParams.get("requestId") ?? "";
          return json({
            requestId: polledRequestId,
            status: "done",
            result: { status: "ok", results: [] },
            terminalState: "applied",
          });
        }
        return json({}, 404);
      }
    );

    await client().executeOps([{ op: "X" }]);
    expect(submittedRequestId).toMatch(/^mcp-/);
    expect(polledRequestId).toBe(submittedRequestId);
  });

  it("polls an older engine's acknowledged requestId when it differs from the submitted ID", async () => {
    let submittedRequestId = "";
    let polledRequestId = "";
    vi.stubGlobal(
      "fetch",
      async (input: unknown, init?: { method?: string; body?: string }) => {
        const url = String(input);
        if (init?.method === "POST" && url.includes("/api/ops")) {
          const body = JSON.parse(init.body ?? "{}") as {
            options?: { requestId?: string };
          };
          submittedRequestId = body.options?.requestId ?? "";
          return json(
            { accepted: true, status: "queued", requestId: "legacy-engine-id" },
            202
          );
        }
        if (url.includes("/api/ops/result")) {
          polledRequestId = new URL(url).searchParams.get("requestId") ?? "";
          return json({
            requestId: polledRequestId,
            status: "done",
            result: { status: "ok", results: [] },
            terminalState: "applied",
          });
        }
        return json({}, 404);
      }
    );

    const result = (await client().executeOps([{ op: "X" }])) as Record<string, unknown>;
    expect(submittedRequestId).toMatch(/^mcp-/);
    expect(polledRequestId).toBe("legacy-engine-id");
    expect(result.requestId).toBe("legacy-engine-id");
    expect(result.submissionRequestId).toBe(submittedRequestId);
  });

  it("executeOps passes a legacy synchronous 200 result straight through (no poll)", async () => {
    let pollHits = 0;
    mockFetch((url, method) => {
      if (url.includes("/api/ops/result")) pollHits++;
      if (method === "POST" && url.includes("/api/ops")) {
        return json({ status: "ok", results: [], legacy: true });
      }
      return json({}, 404);
    });
    const r = (await client().executeOps([{ op: "X" }])) as Record<string, unknown>;
    expect(r.legacy).toBe(true);
    expect(pollHits).toBe(0); // never polled — legacy path
  });

  it("identity-bound file mutations fail closed when the client is unbound", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      client().executeIdentityBoundOps([{ op: "WriteFile" }])
    ).rejects.toThrow(/complete engine\/project identity/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("identity-bound file mutations stamp the bound hash after caller options", async () => {
    const sink: { lastBody?: unknown } = {};
    mockFetchCapturing(
      (url, method) =>
        method === "POST" && url.includes("/api/ops")
          ? json({ status: "ok", results: [{ ok: true, op: "WriteFile" }] })
          : json({}, 404),
      sink
    );
    const scoped = new EngineApiClient(6550, "test-token", {
      instanceId: "engine-a",
      projectId: "project-a",
      projectIdHash: "hash-a",
    });

    await scoped.executeIdentityBoundOps(
      [{ op: "WriteFile", path: "res://main.tscn" }],
      { projectIdHash: "caller-must-not-override" }
    );

    expect(sink.lastBody).toMatchObject({
      options: { projectIdHash: "hash-a" },
    });
  });

  it("reads stay synchronous 200 (no 202/poll)", async () => {
    mockFetch((url) =>
      url.includes("/api/state/scene") ? json({ nodes: ["root"], appliedThroughSeq: 0 }) : json({}, 404)
    );
    const r = (await client().getSceneState()) as Record<string, unknown>;
    expect(r.nodes).toEqual(["root"]);
  });

  it("viewportSnapshot resolves 202->poll and decodes image_base64", async () => {
    const b64 = Buffer.from("fake-jpeg-bytes").toString("base64");
    mockFetch((url) => {
      if (url.includes("/api/snapshot/viewport")) {
        return json({ accepted: true, status: "queued", requestId: "s1" }, 202);
      }
      if (url.includes("/api/ops/result")) {
        return json({
          requestId: "s1",
          status: "done",
          result: {
            status: "ok",
            results: [{ op: "ViewportSnapshot", ok: true, image_base64: b64, mime: "image/jpeg", width: 10, height: 10 }],
          },
          terminalState: "applied",
        });
      }
      return json({}, 404);
    });
    const snap = await client().viewportSnapshot();
    try {
      expect(snap.ok).toBe(true);
      expect(snap.mime).toBe("image/jpeg");
      expect(snap.bytes).toBeGreaterThan(0);
    } finally {
      if (snap.localPath) {
        try {
          rmSync(snap.localPath);
        } catch {
          /* ignore */
        }
      }
    }
  });

  it("play() nests scene inside options so the engine actually receives it", async () => {
    // Regression: the engine reads play params from body.options (and the play
    // handler reads options.scene); a top-level { scene } is silently dropped.
    const sink: { lastBody?: unknown } = {};
    mockFetchCapturing((url, method) => {
      if (method === "POST" && url.includes("/api/play")) {
        return json({ accepted: true, status: "queued", requestId: "p1" }, 202);
      }
      if (url.includes("/api/ops/result")) {
        return json({ requestId: "p1", status: "done", result: { status: "ok" }, terminalState: "applied" });
      }
      return json({}, 404);
    }, sink);

    await client().play("res://levels/boss.tscn");
    expect(sink.lastBody).toMatchObject({
      options: {
        scene: "res://levels/boss.tscn",
        requestId: expect.stringMatching(/^mcp-/),
      },
    });
  });

  it("play() with no scene sends only lifecycle options (plays the main scene)", async () => {
    const sink: { lastBody?: unknown } = {};
    mockFetchCapturing((url, method) => {
      if (method === "POST" && url.includes("/api/play")) {
        return json({ accepted: true, status: "queued", requestId: "p2" }, 202);
      }
      if (url.includes("/api/ops/result")) {
        return json({ requestId: "p2", status: "done", result: { status: "ok" }, terminalState: "applied" });
      }
      return json({}, 404);
    }, sink);

    await client().play();
    expect(sink.lastBody).toEqual({
      options: { requestId: expect.stringMatching(/^mcp-/) },
    });
  });

  it("play() with determinism pins sends an explicit PlayGame op through /api/ops (the /api/play rung forwards only `scene`)", async () => {
    const sink: { lastBody?: unknown } = {};
    const urls: string[] = [];
    mockFetchCapturing((url, method) => {
      urls.push(`${method} ${new URL(url).pathname}`);
      if (method === "POST" && url.includes("/api/ops") && !url.includes("/api/ops/result")) {
        return json({ accepted: true, status: "queued", requestId: "p3" }, 202);
      }
      if (url.includes("/api/ops/result")) {
        return json({
          requestId: "p3",
          status: "done",
          result: { status: "ok", results: [{ ok: true, op: "PlayGame", playing: true, determinism: { seed: 42, applied: true } }] },
          terminalState: "applied",
        });
      }
      return json({}, 404);
    }, sink);

    const result = (await client().play("res://levels/boss.tscn", { seed: 42, fixed_fps: 60, time_scale: undefined })) as {
      results?: Array<{ determinism?: { applied?: boolean } }>;
    };
    expect(urls[0]).toBe("POST /api/ops");
    expect(urls.some((u) => u.endsWith("/api/play"))).toBe(false);
    expect(sink.lastBody).toEqual({
      ops: [{ op: "PlayGame", scene: "res://levels/boss.tscn", seed: 42, fixed_fps: 60 }],
      options: { requestId: expect.stringMatching(/^mcp-/) },
    });
    expect(result.results?.[0]?.determinism?.applied).toBe(true);
  });

  it("play() with an all-undefined determinism object stays on /api/play (byte-for-byte v1)", async () => {
    const sink: { lastBody?: unknown } = {};
    const urls: string[] = [];
    mockFetchCapturing((url, method) => {
      urls.push(`${method} ${new URL(url).pathname}`);
      if (method === "POST" && url.includes("/api/play")) {
        return json({ accepted: true, status: "queued", requestId: "p4" }, 202);
      }
      if (url.includes("/api/ops/result")) {
        return json({ requestId: "p4", status: "done", result: { status: "ok" }, terminalState: "applied" });
      }
      return json({}, 404);
    }, sink);

    await client().play(undefined, { seed: undefined, fixed_fps: undefined, time_scale: undefined });
    expect(urls[0]).toBe("POST /api/play");
    expect(sink.lastBody).toEqual({ options: { requestId: expect.stringMatching(/^mcp-/) } });
  });

  it("surfaces a hard transport error (non-2xx, non-202/429) as a throw", async () => {
    mockFetch(() => new Response("boom", { status: 500 }));
    await expect(client().executeOps([{ op: "X" }])).rejects.toThrow(/Engine API error 500/);
  });

  it("returns a 429 backpressure body as a result (transient), without throwing", async () => {
    mockFetch(() => json({ ok: false, error: "queue full", errorClass: "transient" }, 429));
    const r = (await client().executeOps([{ op: "X" }])) as Record<string, unknown>;
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe("transient");
    expect(r.dispatchState).toBe("not_sent");
    expect(r.requestId).toMatch(/^mcp-/);
  });

  it("preserves the accepted requestId when the final receipt cannot be fetched", async () => {
    let submittedRequestId = "";
    vi.stubGlobal(
      "fetch",
      async (input: unknown, init?: { method?: string; body?: string }) => {
        const url = String(input);
        if (init?.method === "POST" && url.includes("/api/ops")) {
          const body = JSON.parse(init.body ?? "{}") as {
            options?: { requestId?: string };
          };
          submittedRequestId = body.options?.requestId ?? "";
          return json(
            { accepted: true, status: "queued", requestId: submittedRequestId },
            202
          );
        }
        throw new Error("socket closed");
      }
    );

    const r = (await client().executeOps([{ op: "X" }])) as Record<string, unknown>;
    expect(r).toMatchObject({
      terminalState: "uncertain",
      dispatchState: "uncertain",
      requestId: submittedRequestId,
    });
    expect(String(r.error)).toContain("may still be running or may already have applied");
  });
});

describe("EngineApiClient — See-Work Loop P5 capture additions", () => {
  const boundClient = () => new EngineApiClient(6550, "test-token", "bound-hash");

  it("gameSnapshot detects the 409 bridge_required shape and returns it structured (not a truncated throw)", async () => {
    let snapshotGets = 0;
    mockFetch((url) => {
      if (url.includes("/api/snapshot/game")) {
        snapshotGets += 1;
        return json(
          {
            ok: false,
            error: "Game snapshots require the desktop bridge async transport",
            failure_reason: "unsupported_transport",
            bridge_required: true,
          },
          409
        );
      }
      return json({}, 404);
    });
    const snap = await client().gameSnapshot();
    expect(snap.ok).toBe(false);
    expect(snap.failureReason).toBe("unsupported_transport");
    expect(snap.error).toContain("desktop bridge");
    expect(snapshotGets).toBe(1);
  });

  it("gameSnapshot falls through to the normal queued path when the engine answers 200/202 (P4.4 forward-compat)", async () => {
    const b64 = Buffer.from("game-bytes").toString("base64");
    let snapshotGets = 0;
    let resultPolls = 0;
    mockFetch((url) => {
      // No 409 — the same 202 response flows into the queued path; a separate
      // probe request would capture the game twice (and orphan requestId g1).
      if (url.includes("/api/snapshot/game")) {
        snapshotGets += 1;
        return json({ accepted: true, status: "queued", requestId: "g1" }, 202);
      }
      if (url.includes("/api/ops/result")) resultPolls += 1;
      if (url.includes("/api/ops/result")) {
        return json({
          requestId: "g1",
          status: "done",
          result: {
            status: "ok",
            results: [{ op: "GameSnapshot", ok: true, image_base64: b64, mime: "image/jpeg", width: 8, height: 8 }],
          },
          terminalState: "applied",
        });
      }
      return json({}, 404);
    });
    const snap = await client().gameSnapshot();
    try {
      expect(snap.ok).toBe(true);
      expect(snap.failureReason).toBeUndefined();
      expect(snap.bytes).toBeGreaterThan(0);
      expect(snapshotGets).toBe(1);
      expect(resultPolls).toBeGreaterThan(0);
    } finally {
      if (snap.localPath) {
        try {
          rmSync(snap.localPath);
        } catch {
          /* ignore */
        }
      }
    }
  });

  it("scenePreview sends the ScenePreview op via /api/ops and surfaces confession fields", async () => {
    const b64 = Buffer.from("scene-bytes").toString("base64");
    const sink: { lastBody?: unknown } = {};
    mockFetchCapturing((url, method) => {
      if (method === "POST" && url.includes("/api/ops")) {
        return json({ accepted: true, status: "queued", requestId: "sc1" }, 202);
      }
      if (url.includes("/api/ops/result")) {
        return json({
          requestId: "sc1",
          status: "done",
          result: {
            status: "ok",
            results: [
              {
                op: "ScenePreview",
                ok: true,
                image_base64: b64,
                mime: "image/jpeg",
                width: 20,
                height: 20,
                scene_has_camera: false,
                scene_had_light: true,
                used_synthetic_camera: true,
              },
            ],
          },
          terminalState: "applied",
        });
      }
      return json({}, 404);
    }, sink);

    const snap = await client().scenePreview({ scenePath: "res://main.tscn", framing: "iso" });
    try {
      expect(snap.ok).toBe(true);
      expect(snap.sceneHasCamera).toBe(false);
      expect(snap.sceneHadLight).toBe(true);
      expect(snap.usedSyntheticCamera).toBe(true);
      // op input mirrors the web previewScene shape (scene_path / framing).
      const body = sink.lastBody as { ops?: Array<Record<string, unknown>> };
      expect(body.ops?.[0]).toMatchObject({ op: "ScenePreview", scene_path: "res://main.tscn", framing: "iso" });
    } finally {
      if (snap.localPath) {
        try {
          rmSync(snap.localPath);
        } catch {
          /* ignore */
        }
      }
    }
  });

  it("scenePreview drops sentinel '.' / './' scene paths (renders the open scene)", async () => {
    const b64 = Buffer.from("x").toString("base64");
    const sink: { lastBody?: unknown } = {};
    mockFetchCapturing((url, method) => {
      if (method === "POST" && url.includes("/api/ops")) {
        return json({ accepted: true, status: "queued", requestId: "sc2" }, 202);
      }
      if (url.includes("/api/ops/result")) {
        return json({
          requestId: "sc2",
          status: "done",
          result: { status: "ok", results: [{ op: "ScenePreview", ok: true, image_base64: b64, mime: "image/jpeg" }] },
          terminalState: "applied",
        });
      }
      return json({}, 404);
    }, sink);

    const snap = await client().scenePreview({ scenePath: "." });
    try {
      const body = sink.lastBody as { ops?: Array<Record<string, unknown>> };
      expect(body.ops?.[0]).toEqual({ op: "ScenePreview" });
      expect(body.ops?.[0]).not.toHaveProperty("scene_path");
    } finally {
      if (snap.localPath) {
        try {
          rmSync(snap.localPath);
        } catch {
          /* ignore */
        }
      }
    }
  });

  it("scenePreview sends the wave I fixed-pose and Set-of-Mark params under their wire names and keeps the echoes in metadata", async () => {
    const b64 = Buffer.from("y").toString("base64");
    const sink: { lastBody?: unknown } = {};
    mockFetchCapturing((url, method) => {
      if (method === "POST" && url.includes("/api/ops") && !url.includes("/api/ops/result")) {
        return json({ accepted: true, status: "queued", requestId: "sc3" }, 202);
      }
      if (url.includes("/api/ops/result")) {
        return json({
          requestId: "sc3",
          status: "done",
          result: {
            status: "ok",
            results: [
              {
                op: "ScenePreview",
                ok: true,
                image_base64: b64,
                mime: "image/jpeg",
                framing: "bookmark:hero",
                framing_source: "bookmark",
                bookmark: "hero",
                camera_pose: { position: "Vector3(0, 5, 12)", look_at: "Vector3(0, 1, 0)", fov: 55 },
                marks: [{ id: 1, path: "Ground", class: "MeshInstance3D", screen_rect: { x: 0, y: 0, w: 10, h: 10 } }],
                marks_candidates: 1,
                marks_skipped: 0,
                marks_truncated: false,
                max_marks: 8,
              },
            ],
          },
          terminalState: "applied",
        });
      }
      return json({}, 404);
    }, sink);

    const snap = await client().scenePreview({
      framing: "bookmark:hero",
      fov: 55,
      marks: true,
      maxMarks: 8,
      cameraPosition: "Vector3(0, 5, 12)",
      cameraLookAt: "Vector3(0, 1, 0)",
    });
    try {
      const body = sink.lastBody as { ops?: Array<Record<string, unknown>> };
      expect(body.ops?.[0]).toEqual({
        op: "ScenePreview",
        framing: "bookmark:hero",
        fov: 55,
        marks: true,
        max_marks: 8,
        camera_position: "Vector3(0, 5, 12)",
        camera_look_at: "Vector3(0, 1, 0)",
      });
      expect(snap.framing).toBe("bookmark:hero");
      expect(snap.metadata).toMatchObject({
        framing_source: "bookmark",
        bookmark: "hero",
        camera_pose: { position: "Vector3(0, 5, 12)", look_at: "Vector3(0, 1, 0)", fov: 55 },
        marks: [{ id: 1, path: "Ground" }],
        max_marks: 8,
      });
      expect(snap.metadata).not.toHaveProperty("image_base64");
    } finally {
      if (snap.localPath) {
        try {
          rmSync(snap.localPath);
        } catch {
          /* ignore */
        }
      }
    }
  });

  it("viewportSnapshot flags projectMismatch when the engine's live hash drifts from the bound hash", async () => {
    const b64 = Buffer.from("vp").toString("base64");
    mockFetch((url) => {
      if (url.includes("/api/snapshot/viewport")) {
        return json({ accepted: true, status: "queued", requestId: "v1" }, 202);
      }
      if (url.includes("/api/ops/result")) {
        return json({
          requestId: "v1",
          status: "done",
          result: { status: "ok", results: [{ op: "ViewportSnapshot", ok: true, image_base64: b64, mime: "image/jpeg" }] },
          terminalState: "applied",
        });
      }
      if (url.includes("/api/health")) {
        return json({
          ok: true,
          engine: "summer",
          version: "0.5.43",
          instanceId: "inst-1",
          projectIdHash: "DIFFERENT-hash",
        });
      }
      return json({}, 404);
    });
    const snap = await boundClient().viewportSnapshot();
    try {
      expect(snap.ok).toBe(true);
      expect(snap.projectMismatch).toBe(true);
    } finally {
      if (snap.localPath) {
        try {
          rmSync(snap.localPath);
        } catch {
          /* ignore */
        }
      }
    }
  });

  it("viewportSnapshot does NOT flag mismatch when the live hash matches the bound hash", async () => {
    const b64 = Buffer.from("vp").toString("base64");
    mockFetch((url) => {
      if (url.includes("/api/snapshot/viewport")) {
        return json({ accepted: true, status: "queued", requestId: "v2" }, 202);
      }
      if (url.includes("/api/ops/result")) {
        return json({
          requestId: "v2",
          status: "done",
          result: { status: "ok", results: [{ op: "ViewportSnapshot", ok: true, image_base64: b64, mime: "image/jpeg" }] },
          terminalState: "applied",
        });
      }
      if (url.includes("/api/health")) {
        return json({
          ok: true,
          engine: "summer",
          version: "0.5.43",
          instanceId: "inst-1",
          projectIdHash: "bound-hash",
        });
      }
      return json({}, 404);
    });
    const snap = await boundClient().viewportSnapshot();
    try {
      expect(snap.projectMismatch).toBeFalsy();
    } finally {
      if (snap.localPath) {
        try {
          rmSync(snap.localPath);
        } catch {
          /* ignore */
        }
      }
    }
  });
});

describe("EngineApiClient — events channel (GET /api/events/poll)", () => {
  const scoped = () =>
    new EngineApiClient(6550, "test-token", {
      instanceId: "engine-a",
      projectId: "project-a",
      projectIdHash: "hash-a",
    });

  it("sends since/kinds/wait/limit as query params alongside the bound identity and returns the envelope", async () => {
    const seen: string[] = [];
    let method = "";
    vi.stubGlobal("fetch", (input: unknown, init?: { method?: string }) => {
      seen.push(String(input));
      method = init?.method ?? "GET";
      return Promise.resolve(
        json({ ok: true, events: [{ seq: 42, kind: "play.started", ts: 1, data: {} }], next_seq: 42, last_seq: 42, since: 41, truncated: false, timed_out: false })
      );
    });

    const page = (await scoped().pollEvents({ since: 41, kinds: ["play.started", "script.error"], wait: 25_000, limit: 20 })) as Record<string, unknown>;
    expect(method).toBe("GET");
    const url = new URL(seen[0]!);
    expect(url.pathname).toBe("/api/events/poll");
    expect(url.searchParams.get("since")).toBe("41");
    expect(url.searchParams.get("kinds")).toBe("play.started,script.error");
    expect(url.searchParams.get("wait")).toBe("25000");
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.get("instanceId")).toBe("engine-a");
    expect(url.searchParams.get("projectId")).toBe("project-a");
    expect(url.searchParams.get("projectIdHash")).toBe("hash-a");
    expect(url.searchParams.get("projectIdentityVersion")).toBe("1");
    expect(page.next_seq).toBe(42);
    expect((page.events as unknown[]).length).toBe(1);
  });

  it("omits absent parameters (live-only poll with engine defaults)", async () => {
    const seen: string[] = [];
    mockFetch((url) => {
      seen.push(url);
      return json({ ok: true, events: [], next_seq: 7, timed_out: true });
    });
    await client().pollEvents();
    const url = new URL(seen[0]!);
    expect(url.pathname).toBe("/api/events/poll");
    for (const key of ["since", "kinds", "wait", "limit"]) expect(url.searchParams.has(key), key).toBe(false);
  });

  it("returns a 404 (no channel on this build) as a structured failure instead of throwing", async () => {
    mockFetch(() => new Response("not found", { status: 404 }));
    const failure = (await client().pollEvents({ wait: 0 })) as Record<string, unknown>;
    expect(failure).toMatchObject({ ok: false, http_status: 404 });
    expect(String(failure.error)).toContain("Engine API error 404");
  });

  it("returns a 409 identity_mismatch body structured, keeping the engine's terminalState for classification", async () => {
    mockFetch(() => json({ terminalState: "identity_mismatch", errorClass: "rejected_identity" }, 409));
    const failure = (await client().pollEvents({ since: 1 })) as Record<string, unknown>;
    expect(failure).toEqual({
      ok: false,
      terminalState: "identity_mismatch",
      errorClass: "rejected_identity",
      http_status: 409,
    });
  });

  it("returns a 503 (bus not started) structured and throws on anything else, so a stale token still reconnects", async () => {
    mockFetch(() => json({ error: "event bus not started" }, 503));
    expect(await client().pollEvents()).toMatchObject({ ok: false, http_status: 503, error: "event bus not started" });

    mockFetch(() => new Response("unauthorized", { status: 401 }));
    await expect(client().pollEvents()).rejects.toThrow(/Engine API error 401/);
  });

  it("names the request when a 200 carries a non-JSON body", async () => {
    mockFetch(() => new Response("<html>proxy</html>", { status: 200 }));
    await expect(client().pollEvents()).rejects.toThrow(/non-JSON response for GET \/api\/events\/poll/);
  });
});
