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
