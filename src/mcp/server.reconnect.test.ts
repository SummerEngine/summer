import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Disconnect repro (the MCP/CLI "disconnecting from the project" class):
 *
 * The MCP server is a long-lived stdio process (it lives as long as Claude Code /
 * Cursor / Codex keep it). It caches ONE EngineApiClient that snapshots the
 * engine's api-port + api-token at first connect. But the engine mints a NEW
 * random api-token on EVERY launch (local_api_server.cpp::_generate_api_token)
 * and can bind a different port (tool_net_thread.cpp::start increments 6550..6565
 * when the old socket lingers). So any engine restart / reopen / crash-relaunch
 * invalidates the cached credentials, and the stale client keeps hitting the old
 * port with the old Bearer token -> 401 -> reads as "disconnected".
 *
 * getClient() must detect that the on-disk creds drifted and rebuild the client
 * transparently, so a silent engine restart never surfaces as an error.
 */

const state = { port: 6550, token: "tokenA" };

vi.mock("../core/engine.js", () => ({
  getApiPort: vi.fn(async () => state.port),
  getApiToken: vi.fn(async () => state.token),
  checkEngineHealth: vi.fn(async () => ({
    ok: true,
    engine: "summer",
    version: "1.0.0",
    port: state.port,
    instanceId: "inst-1",
  })),
}));

import { getClient, resetClient } from "./server.js";

beforeEach(() => {
  state.port = 6550;
  state.token = "tokenA";
  resetClient();
});

afterEach(() => {
  resetClient();
  vi.clearAllMocks();
});

describe("getClient — survives an engine restart (api-token rotation)", () => {
  it("reuses the cached client while the on-disk creds are stable", async () => {
    const c1 = await getClient();
    const c2 = await getClient();
    expect(c2).toBe(c1);
  });

  it("rebuilds transparently when the engine rotates its api-token (restart)", async () => {
    const c1 = await getClient();
    expect(c1.getPort()).toBe(6550);

    // Engine relaunches: fresh random api-token, and the old port lingered so it
    // bound the next one.
    state.token = "tokenB";
    state.port = 6551;

    const c2 = await getClient();
    expect(c2).not.toBe(c1); // stale client must NOT be reused
    expect(c2.getPort()).toBe(6551);
  });

  it("rebuilds when only the api-token rotates (same port reused)", async () => {
    const c1 = await getClient();
    state.token = "tokenB"; // same 6550, new token
    const c2 = await getClient();
    expect(c2).not.toBe(c1);
  });

  it("keeps the cached client when creds are briefly unreadable (engine mid-write)", async () => {
    const c1 = await getClient();
    // Token file momentarily empty/locked while the engine rewrites it: must NOT
    // thrash the cache — the live request will fail+retry if it is truly stale.
    state.token = "";
    const c2 = await getClient();
    expect(c2).toBe(c1);
  });
});
