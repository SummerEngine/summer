import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * End-to-end disconnect repro over REAL HTTP.
 *
 * A fake "engine" HTTP server stands in for Summer Engine: /api/health is
 * unauthenticated (matches tool_net_thread.cpp::_validate_auth) and every other
 * route requires `Authorization: Bearer <currentToken>`, returning 401 on a stale
 * token — exactly what the real engine does after it mints a fresh api-token on
 * relaunch. We rotate the token to simulate an engine restart mid-session and
 * assert the MCP client transparently reconnects (no surfaced error).
 *
 * Only the credential-file readers (getApiPort/getApiToken) are stubbed so the
 * test never touches the user's real ~/.summer; checkEngineHealth and the whole
 * EngineApiClient request path run for real.
 */

const engineState = { token: "token-A", port: 0 };

vi.mock("../core/engine.js", async (importActual) => {
  const actual = await importActual<typeof import("../core/engine.js")>();
  return {
    ...actual,
    getApiPort: vi.fn(async () => engineState.port),
    getApiToken: vi.fn(async () => engineState.token),
  };
});

import { getClient, resetClient } from "./server.js";
import { withEngine } from "./tools/with-engine.js";

let server: Server;

beforeAll(async () => {
  server = createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.url?.startsWith("/api/health")) {
      send(200, {
        ok: true,
        engine: "summer",
        version: "1.0.0",
        port: engineState.port,
        instanceId: "inst-current",
      });
      return;
    }

    // Authenticated routes: reject anything but the CURRENT token (a stale token
    // from before the "restart" gets a 401, just like the real engine).
    const auth = req.headers["authorization"];
    if (auth !== `Bearer ${engineState.token}`) {
      send(401, { ok: false, error: "unauthorized" });
      return;
    }
    send(200, { ok: true, scene: "res://main.tscn" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  engineState.port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.close();
});

afterEach(() => {
  resetClient();
});

describe("MCP session — survives a transient engine restart end-to-end", () => {
  it("binds the project, then transparently reconnects after the engine rotates its token", async () => {
    // Session start: bind to the running engine on token-A.
    const first = await withEngine(async (client) => client.getSceneState());
    expect(first.isError).toBeFalsy();
    expect(first.content[0].text).toContain("res://main.tscn");

    // Engine restarts: brand-new random api-token. The cached client still holds
    // token-A and would 401 on its next authenticated call.
    engineState.token = "token-B";

    // Next tool call must just work — getClient detects the credential drift and
    // rebuilds before the request goes out. No "disconnected" error surfaced.
    const afterRestart = await withEngine(async (client) => client.getSceneState());
    expect(afterRestart.isError).toBeFalsy();
    expect(afterRestart.content[0].text).toContain("res://main.tscn");
  });

  it("recovers when the token rotates AFTER the drift check but before the request (mid-call restart)", async () => {
    // Warm the cache on the current token.
    resetClient();
    engineState.token = "token-C";
    await withEngine(async (client) => client.getSceneState());

    // Simulate the restart landing in the window between getClient()'s drift
    // probe and the actual HTTP call: the proactive check sees no drift, the
    // request 401s, and the reset+retry path is what saves the call.
    let rotated = false;
    const res = await withEngine(async (client) => {
      if (!rotated) {
        rotated = true;
        engineState.token = "token-D"; // engine relaunched mid-call
      }
      return client.getSceneState();
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("res://main.tscn");
  });
});
