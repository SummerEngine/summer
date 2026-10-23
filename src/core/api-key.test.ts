import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readStoreText, setSummerDirForTests } from "./store.js";
import { apiKeyLoginAnswer, getApiKey, keyClientName } from "./api-key.js";

/**
 * The Summer API key handshake against a fake gateway with the server's
 * contract: start a request, the person allows it, the next poll answers the
 * key once and it is saved to ~/.summer/api-key, never returned.
 */

let root = "";
const originalGateway = process.env.SUMMER_GATEWAY_URL;
const KEY = `sk-summer-v1-${"k".repeat(43)}`;

function gateway(answers: Array<{ status: number; body: Record<string, unknown> }>) {
  const calls: Array<{ url: string; method: string; auth: string | null; body: unknown }> = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), method: init?.method ?? "GET", auth: headers.get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : null });
    if ((init?.method ?? "GET") === "POST") {
      return Response.json(
        { request_id: "akr_1", user_code: "ABCD-EFGH", approve_url: "https://gateway.example/studio/api-keys/akr_1", poll_url: "https://gateway.example/api/api-keys/requests/akr_1", poll_token: "akp_secret", interval: 1, expires_in: 600 },
        { status: 201 }
      );
    }
    const next = answers.shift() ?? { status: 200, body: { status: "pending" } };
    return Response.json(next.body, { status: next.status });
  });
  return { calls, fetch: fetchMock as unknown as typeof fetch };
}

const noSleep = async () => undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-api-key-test-"));
  setSummerDirForTests(join(root, ".summer"));
  process.env.SUMMER_GATEWAY_URL = "https://gateway.example";
  delete process.env.SUMMER_API_KEY;
});

afterEach(async () => {
  setSummerDirForTests(null);
  if (originalGateway === undefined) delete process.env.SUMMER_GATEWAY_URL;
  else process.env.SUMMER_GATEWAY_URL = originalGateway;
  delete process.env.SUMMER_API_KEY;
  await rm(root, { recursive: true, force: true });
});

describe("summer_api_key_login", () => {
  it("asks the person, then saves the key on this computer without showing it", async () => {
    const fake = gateway([{ status: 200, body: { status: "pending" } }]);
    const first = await apiKeyLoginAnswer({ limitUsd: 10 }, { waitMs: 0, sleep: noSleep }, { fetch: fake.fetch });
    expect(first).toMatchObject({ ok: true, status: "needs_approval", approve_url: "https://gateway.example/studio/api-keys/akr_1", user_code: "ABCD-EFGH" });
    expect(fake.calls[0]).toMatchObject({ url: "https://gateway.example/api/api-keys/requests", method: "POST", body: { client: expect.any(String), limitUsd: 10 } });
    expect(fake.calls[1]).toMatchObject({ url: "https://gateway.example/api/api-keys/requests/akr_1", auth: "Bearer akp_secret" });

    // The second call continues the same request (no second POST) and picks up the key.
    const approved = gateway([{ status: 200, body: { status: "approved", key: KEY, key_id: "key-1", limit_usd: 10, expires_at: "2026-11-21T00:00:00.000Z" } }]);
    const second = await apiKeyLoginAnswer({}, { waitMs: 0, sleep: noSleep }, { fetch: approved.fetch });
    expect(approved.calls.map((call) => call.method)).toEqual(["GET"]);
    expect(second).toMatchObject({ ok: true, status: "ready", env: "SUMMER_API_KEY", key_id: "key-1", limit_usd: 10 });
    expect(JSON.stringify(second)).not.toContain(KEY);
    expect(await getApiKey()).toBe(KEY);
    expect((await stat(join(root, ".summer", "api-key"))).mode & 0o777).toBe(0o600);
    expect(await readStoreText("api-key-request.json")).toBeNull();

    // Saved: the next call answers ready without asking the gateway.
    const idle = gateway([]);
    expect(await apiKeyLoginAnswer({}, { waitMs: 0, sleep: noSleep }, { fetch: idle.fetch })).toMatchObject({ status: "ready" });
    expect(idle.calls).toEqual([]);
  });

  it("says so when the person denies, and when the gateway has no keys yet", async () => {
    const denied = gateway([{ status: 200, body: { status: "denied" } }]);
    expect(await apiKeyLoginAnswer({}, { waitMs: 0, sleep: noSleep }, { fetch: denied.fetch })).toMatchObject({ ok: false, status: "denied" });
    expect(await getApiKey()).toBeNull();
    const missing = vi.fn(async () => new Response("Not found", { status: 404 })) as unknown as typeof fetch;
    expect(await apiKeyLoginAnswer({ fresh: true }, { waitMs: 0, sleep: noSleep }, { fetch: missing })).toMatchObject({ ok: false, error: "keys_unavailable" });
  });

  it("prefers SUMMER_API_KEY, and names the agent app on the Allow page", async () => {
    process.env.SUMMER_API_KEY = ` ${KEY} `;
    expect(await getApiKey()).toBe(KEY);
    expect(keyClientName("claude-code")).toBe("Claude Code");
    expect(keyClientName("other.my-agent")).toBe("my-agent");
    expect(keyClientName("unknown")).toBe("Summer CLI");
  });
});
