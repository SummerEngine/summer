import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAuthToken,
  getCreatorToken,
  getUserInfo,
} from "../../core/auth.js";
import { setConfigValue } from "../../core/config.js";
import { setSummerDirForTests } from "../../core/store.js";
import { runCreatorLogin, runLogin } from "./login.js";

let root = "";
const originalGateway = process.env.SUMMER_GATEWAY_URL;

function cliToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: "user-1",
      type: "cli",
      aud: "summer-cli",
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
  ).toString("base64url");
  return `${header}.${payload}.signature`;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-login-test-"));
  setSummerDirForTests(join(root, ".summer"));
  process.env.SUMMER_GATEWAY_URL = "https://gateway.example";
});

afterEach(async () => {
  setSummerDirForTests(null);
  if (originalGateway === undefined) delete process.env.SUMMER_GATEWAY_URL;
  else process.env.SUMMER_GATEWAY_URL = originalGateway;
  await rm(root, { recursive: true, force: true });
});

describe("runLogin", () => {
  it("uses the current browser/poll contract and persists one validated session", async () => {
    const logs: string[] = [];
    const openUrl = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: "complete",
          token: cliToken(),
          user: {
            id: "user-1",
            email: "maker@example.com",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    await runLogin({
      randomId: () => "session-123",
      openUrl,
      fetch: fetchMock as typeof fetch,
      sleep: async () => undefined,
      now: () => 1,
      log: (message) => logs.push(message),
    });

    expect(openUrl).toHaveBeenCalledWith(
      "https://gateway.example/login?cli_session=session-123"
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gateway.example/api/auth/cli-login?session=session-123",
      expect.any(Object)
    );
    expect(await getAuthToken()).toBe(cliToken());
    expect(await getUserInfo()).toMatchObject({
      id: "user-1",
      email: "maker@example.com",
    });
    expect(logs.at(-1)).toContain("maker@example.com");
  });
});

describe("runLogin failure handling", () => {
  /** Clock that advances 1s per read, so a runaway poll loop ends in ~900
   *  iterations instead of hanging the suite — and the fetch count exposes it. */
  function ticking() {
    let t = 0;
    return () => (t += 1000);
  }

  it("fails immediately when the completed session fails validation (no 15-minute poll)", async () => {
    const mismatched = cliToken(); // sub user-1
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: "complete",
          token: mismatched,
          user: { id: "someone-else", email: "other@example.com" },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    await expect(
      runLogin({
        randomId: () => "s",
        openUrl: async () => undefined,
        fetch: fetchMock as typeof fetch,
        sleep: async () => undefined,
        now: ticking(),
        log: () => undefined,
      })
    ).rejects.toThrow(/mismatched identity.*summer login --force/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await getAuthToken()).toBeNull();
  });

  it("aborts on a terminal 4xx instead of polling it for 15 minutes", async () => {
    const fetchMock = vi.fn(async () => new Response("not found", { status: 404 }));

    await expect(
      runLogin({
        randomId: () => "s",
        openUrl: async () => undefined,
        fetch: fetchMock as typeof fetch,
        sleep: async () => undefined,
        now: ticking(),
        log: () => undefined,
      })
    ).rejects.toThrow(/rejected \(404\).*gateway\.example/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 503 and reports the last error in the heartbeat", async () => {
    const logs: string[] = [];
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls < 3) return new Response("unavailable", { status: 503 });
      return new Response(
        JSON.stringify({
          status: "complete",
          token: cliToken(),
          user: { id: "user-1", email: "maker@example.com" },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    // 20s per read: the heartbeat (30s) fires between the failed polls.
    let t = 0;
    await runLogin({
      randomId: () => "s",
      openUrl: async () => undefined,
      fetch: fetchMock as typeof fetch,
      sleep: async () => undefined,
      now: () => (t += 20000),
      log: (message) => logs.push(message),
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await getAuthToken()).toBe(cliToken());
    const heartbeats = logs.filter((line) => line.startsWith("Still waiting"));
    expect(heartbeats.length).toBeGreaterThan(0);
    expect(heartbeats.at(-1)).toContain("last error: The login service is unavailable");
  });
});

describe("runCreatorLogin", () => {
  it("opens scoped token settings and stores creator auth separately", async () => {
    const logs: string[] = [];
    const openUrl = vi.fn(async () => undefined);
    const creatorToken = `sc_${"b".repeat(43)}`;
    await setConfigValue("creator.apiUrl", "https://creator.example");

    await runCreatorLogin({
      openUrl,
      readSecret: async () => creatorToken,
      log: (message) => logs.push(message),
    });

    expect(openUrl).toHaveBeenCalledWith(
      "https://creator.example/creator/settings/tokens"
    );
    expect(await getCreatorToken()).toBe(creatorToken);
    expect(await getAuthToken()).toBeNull();
    expect(logs.at(-1)).toContain("core Summer login token was not changed");
  });
});
