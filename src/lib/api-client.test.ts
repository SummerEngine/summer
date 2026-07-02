import { rmSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EngineApiClient } from "./api-client.js";

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
    expect(sink.lastBody).toEqual({ options: { scene: "res://levels/boss.tscn" } });
  });

  it("play() with no scene sends an empty body (plays the main scene)", async () => {
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
    expect(sink.lastBody).toEqual({});
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
  });
});

describe("EngineApiClient — See-Work Loop P5 capture additions", () => {
  const boundClient = () => new EngineApiClient(6550, "test-token", "bound-hash");

  it("gameSnapshot detects the 409 bridge_required shape and returns it structured (not a truncated throw)", async () => {
    mockFetch((url) => {
      if (url.includes("/api/snapshot/game")) {
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
  });

  it("gameSnapshot falls through to the normal queued path when the engine answers 200/202 (P4.4 forward-compat)", async () => {
    const b64 = Buffer.from("game-bytes").toString("base64");
    mockFetch((url) => {
      // No 409 — the bridge probe sees a 202 and returns null, so the normal
      // queued path runs.
      if (url.includes("/api/snapshot/game")) {
        return json({ accepted: true, status: "queued", requestId: "g1" }, 202);
      }
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
