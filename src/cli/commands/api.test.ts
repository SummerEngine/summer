import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSummerDirForTests } from "../../core/store.js";
import { API_NOT_OPEN, SIGN_IN_GONE_MESSAGE, estimateJob, getJob, jobToolResult, listModels, runJob, SummerApiError } from "../../core/summer-api.js";
import { runApiAction } from "./api.js";
import { runTokenCommand } from "./token.js";
import { OAuthError } from "../../core/oauth.js";

/**
 * The Summer API from this computer against a fake /v1 with the server's
 * shapes: models, an estimate, a job signed in with the OAuth sign-in, its
 * Idempotency-Key and Prefer: wait, following it and saving its files,
 * `summer token`, and the one plain line while Summer has not opened the API.
 */

let root = "";
const originalGateway = process.env.SUMMER_GATEWAY_URL;
const TOKEN = "oauth-access-token";
const signedIn = async () => TOKEN;

type Call = { url: string; method: string; headers: Headers; body: unknown };

function fakeApi(routes: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    return routes(call);
  });
  return { calls, fetch: fetchMock as unknown as typeof fetch };
}

const closed = () => Response.json({ error: { type: "not_found_error", code: "not_found", message: "Nothing is here." } }, { status: 404 });
const noSleep = async () => undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-api-test-"));
  setSummerDirForTests(join(root, ".summer"));
  process.env.SUMMER_GATEWAY_URL = "https://gateway.example";
});

afterEach(async () => {
  setSummerDirForTests(null);
  if (originalGateway === undefined) delete process.env.SUMMER_GATEWAY_URL;
  else process.env.SUMMER_GATEWAY_URL = originalGateway;
  await rm(root, { recursive: true, force: true });
});

describe("the Summer API client", () => {
  it("lists models and estimates without a sign-in", async () => {
    const api = fakeApi((call) =>
      call.url.endsWith("/v1/estimate")
        ? Response.json({ model: "3d/hunyuan-3d", currency: "USD", price: "0.75", atMost: false, breakdown: [], quoteId: "q_1", quoteExpiresAt: null })
        : Response.json({ currency: "USD", models: [{ id: "3d/hunyuan-3d", capability: "3d" }] })
    );
    expect(await listModels({ capability: "3d" }, { fetch: api.fetch })).toMatchObject({ models: [{ id: "3d/hunyuan-3d" }] });
    expect(api.calls[0].url).toBe("https://gateway.example/v1/models?capability=3d");
    expect(api.calls[0].headers.get("authorization")).toBeNull();
    await listModels({ model: "3d/default" }, { fetch: api.fetch });
    expect(api.calls[1].url).toBe("https://gateway.example/v1/models/3d/default");
    expect(await estimateJob("3d/default", { prompt: "a chest" }, { fetch: api.fetch })).toMatchObject({ price: "0.75", quoteId: "q_1" });
    expect(api.calls[2].body).toEqual({ model: "3d/default", input: { prompt: "a chest" } });
  });

  it("runs a job with the sign-in, one idempotency key and Prefer: wait, follows it and saves its files", async () => {
    let reads = 0;
    const api = fakeApi((call) => {
      if (call.url.endsWith("/v1/jobs")) return Response.json({ job: { id: "cj_1", state: "running", model: "3d/hunyuan-3d", estimatedPrice: "0.75", pollAfterSeconds: 5 } }, { status: 202 });
      if (call.url.endsWith("/v1/jobs/cj_1")) {
        reads += 1;
        return Response.json({ job: reads < 2 ? { id: "cj_1", state: "running" } : { id: "cj_1", state: "done", price: "0.75", result: { assets: [{ assetId: "a1", fileUrl: "https://files.example/a1.glb" }] } } });
      }
      return new Response("glb-bytes");
    });
    const job = await runJob("3d/default", { prompt: "a chest" }, { waitSeconds: 30 }, { fetch: api.fetch, token: signedIn });
    expect(api.calls[0].headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(api.calls[0].headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(api.calls[0].headers.get("prefer")).toBe("wait=30");
    const out = join(root, "out");
    const answer = await jobToolResult(job, { out }, { fetch: api.fetch, sleep: noSleep, token: signedIn });
    expect(answer).toMatchObject({ job: { state: "done", price: "0.75" }, files: [join(out, "a1.glb")] });
    expect(await readFile(join(out, "a1.glb"), "utf8")).toBe("glb-bytes");
  });

  it("asks for summer login before a run, and passes the server's billing error through", async () => {
    await expect(runJob("3d/default", {}, {}, { fetch: vi.fn() as never })).rejects.toMatchObject({ code: "not_signed_in", message: expect.stringContaining("summer login") });
    const api = fakeApi(() => Response.json({ error: { code: "over_limit", message: "This app reached its spend limit." } }, { status: 402 }));
    await expect(getJob("cj_1", { fetch: api.fetch, token: signedIn })).rejects.toMatchObject({ code: "over_limit", status: 402, message: "This app reached its spend limit." });
  });

  it("summer token prints only the access token, and says how to sign in without one", async () => {
    const out: string[] = [];
    const err: string[] = [];
    expect(await runTokenCommand({ token: signedIn, print: (line) => out.push(line), printError: (line) => err.push(line) })).toBe(0);
    expect(out).toEqual([TOKEN]);
    const missing = async () => {
      throw new OAuthError("store_login_required", "Not signed in.", "Recovery: run summer login.");
    };
    expect(await runTokenCommand({ token: missing, print: (line) => out.push(line), printError: (line) => err.push(line) })).toBe(1);
    expect(out).toEqual([TOKEN]);
    expect(err[0]).toMatch(/summer login/);
  });
});

describe("after the person revoked this app", () => {
  it("says the sign-in was revoked or expired and to run summer login, not that the API is closed", async () => {
    // Before launch the server answers a refused token with "Nothing is here." like everyone else.
    const api = fakeApi(closed);
    const revoked = async () => {
      throw new OAuthError("oauth_grant_invalid", "The sign-in server refused the token request (invalid_grant).", "Recovery: sign in again.");
    };
    const errors: string[] = [];
    const code = await runApiAction({}, async () => ({ data: await runJob("3d/default", { prompt: "a chest" }, {}, { fetch: api.fetch, token: signedIn, refresh: revoked }), summary: [] }), { isTTY: true, print: () => undefined, printError: (line) => errors.push(line) });
    expect(code).toBe(1);
    expect(errors).toEqual([SIGN_IN_GONE_MESSAGE]);
    expect(SIGN_IN_GONE_MESSAGE).toMatch(/revoked or has expired\. Run "summer login"/);
    expect(api.calls).toHaveLength(1);
  });

  it("retries once with a fresh token when the sign-in still works, and only then says the API is closed", async () => {
    const api = fakeApi(closed);
    await expect(getJob("cj_1", { fetch: api.fetch, token: signedIn, refresh: async () => "fresh-token" })).rejects.toMatchObject({ code: "api_not_open", message: API_NOT_OPEN });
    expect(api.calls.map((call) => call.headers.get("authorization"))).toEqual([`Bearer ${TOKEN}`, "Bearer fresh-token"]);
  });
});

describe("while Summer has not opened the API", () => {
  it("summer api prints one plain line and exits 1, in a terminal and piped", async () => {
    const api = fakeApi(closed);
    for (const isTTY of [true, false]) {
      const lines: string[] = [];
      const errors: string[] = [];
      const code = await runApiAction({}, async () => ({ data: await listModels({}, { fetch: api.fetch }), summary: [] }), { isTTY, print: (line) => lines.push(line), printError: (line) => errors.push(line) });
      expect(code).toBe(1);
      expect(errors).toEqual([API_NOT_OPEN]);
      expect(lines).toEqual([]);
    }
    await expect(listModels({}, { fetch: api.fetch })).rejects.toBeInstanceOf(SummerApiError);
  });
});
