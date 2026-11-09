import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAuthToken,
  getUserInfo,
} from "../../core/auth.js";
import { setSummerDirForTests } from "../../core/store.js";
import { Command } from "commander";
import { STORE_STEP_TIMEOUT_MS, runLogin, runLoginCommand } from "./login.js";

let root = "";
const originalGateway = process.env.SUMMER_GATEWAY_URL;

/** A fresh JWT whose exp embeds the current second — so build it ONCE per test
 *  and share it between the poll mock and the assertion, or the two calls can
 *  straddle a second boundary under full-suite load and the strings differ. */
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
    const token = cliToken();
    const openUrl = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: "complete",
          token,
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
    expect(await getAuthToken()).toBe(token);
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
    const token = cliToken();
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls < 3) return new Response("unavailable", { status: 503 });
      return new Response(
        JSON.stringify({
          status: "complete",
          token,
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
    expect(await getAuthToken()).toBe(token);
    const heartbeats = logs.filter((line) => line.startsWith("Still waiting"));
    expect(heartbeats.length).toBeGreaterThan(0);
    expect(heartbeats.at(-1)).toContain("last error: The login service is unavailable");
  });
});

describe("summer login: one browser for the account and the store", () => {
  function fakes(state: { token: boolean; store: boolean; storeFails?: boolean }) {
    const calls: string[] = [];
    const lines: string[] = [];
    return {
      calls,
      lines,
      deps: {
        hasAuthToken: async () => state.token,
        hasStoreSignIn: async () => state.store,
        login: async () => {
          calls.push("login");
          state.token = true;
        },
        storeLogin: async (options: { newClient: boolean; timeoutMs?: number }) => {
          calls.push(`store:${options.newClient ? "new-client" : "reuse"}:${options.timeoutMs ?? "default"}`);
          if (state.storeFails) throw new Error("Sign-in did not finish within 3 minutes.");
          state.store = true;
        },
        log: (line: string) => lines.push(line),
      },
    };
  }

  it("signs in to the account, then the store, in one command", async () => {
    const { calls, lines, deps } = fakes({ token: false, store: false });
    await runLoginCommand({}, deps);
    expect(calls).toEqual(["login", `store:reuse:${STORE_STEP_TIMEOUT_MS}`]);
    expect(lines.join("\n")).toMatch(/One sign-in covers every Summer tool/);
    expect(lines.join("\n")).toMatch(/SUMMER_NO_TELEMETRY=1/);
  });

  it("adds only the store when the account is already signed in", async () => {
    const { calls, deps } = fakes({ token: true, store: false });
    await runLoginCommand({}, deps);
    expect(calls).toEqual([`store:reuse:${STORE_STEP_TIMEOUT_MS}`]);
  });

  it("does nothing when both are signed in, and redoes both with --force", async () => {
    const both = fakes({ token: true, store: true });
    await runLoginCommand({}, both.deps);
    expect(both.calls).toEqual([]);
    expect(both.lines).toEqual(["Already logged in. Use --force to re-authenticate."]);

    const forced = fakes({ token: true, store: true });
    await runLoginCommand({ force: true }, forced.deps);
    expect(forced.calls).toEqual(["login", `store:reuse:${STORE_STEP_TIMEOUT_MS}`]);
  });

  it("keeps the account sign-in when the store step fails, and says how to finish", async () => {
    const { calls, lines, deps } = fakes({ token: false, store: false, storeFails: true });
    await expect(runLoginCommand({}, deps)).resolves.toBeUndefined();
    expect(calls[0]).toBe("login");
    expect(lines.join("\n")).toMatch(/Your Summer login is saved\. .*summer login --store/);
  });

  it("--store is the store step alone (new client with --force); --no-store skips it", async () => {
    const store = fakes({ token: false, store: false });
    await runLoginCommand({ store: true }, store.deps);
    expect(store.calls).toEqual(["store:reuse:default"]);

    const storeForce = fakes({ token: true, store: true });
    await runLoginCommand({ store: true, force: true }, storeForce.deps);
    expect(storeForce.calls).toEqual(["store:new-client:default"]);

    const noStore = fakes({ token: false, store: false });
    await runLoginCommand({ store: false }, noStore.deps);
    expect(noStore.calls).toEqual(["login"]);
  });

  it("signs in again when the stored store token is dead (the server refused it), never \"Already signed in\"", async () => {
    // hasStoreSignIn is the server check (core/oauth.ts storeSignInWorks): false for a revoked app.
    const store = fakes({ token: true, store: false });
    await runLoginCommand({ store: true }, store.deps);
    expect(store.calls).toEqual(["store:reuse:default"]);
    expect(store.lines.join("\n")).not.toMatch(/Already signed in/);

    const plain = fakes({ token: true, store: false });
    await runLoginCommand({}, plain.deps);
    expect(plain.calls).toEqual([`store:reuse:${STORE_STEP_TIMEOUT_MS}`]);
  });

  it("parses --store and --no-store into true, false, or unset", async () => {
    const parse = (argv: string[]) => {
      const command = new Command("login").option("--store").option("--no-store").exitOverride();
      command.parse(argv, { from: "user" });
      return command.opts().store as boolean | undefined;
    };
    expect(parse([])).toBeUndefined();
    expect(parse(["--store"])).toBe(true);
    expect(parse(["--no-store"])).toBe(false);
  });
});
