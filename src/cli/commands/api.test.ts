import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSummerDirForTests, writeStoreText } from "../../core/store.js";
import { API_NOT_OPEN, estimateJob, getJob, jobToolResult, listModels, runJob, SummerApiError } from "../../core/summer-api.js";
import { runApiAction } from "./api.js";
import { runApiKeyLogin } from "./login.js";
import { startApiKeyRequest } from "../../core/api-key.js";

/**
 * The Summer API from this computer against a fake /v1 with the server's
 * shapes: models, an estimate, a keyed job with its Idempotency-Key and
 * Prefer: wait, following it and saving its files, and the one plain line
 * while Summer has not opened the API.
 */

let root = "";
const originalGateway = process.env.SUMMER_GATEWAY_URL;
const KEY = `sk-summer-v1-${"k".repeat(43)}`;

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
  delete process.env.SUMMER_API_KEY;
});

afterEach(async () => {
  setSummerDirForTests(null);
  if (originalGateway === undefined) delete process.env.SUMMER_GATEWAY_URL;
  else process.env.SUMMER_GATEWAY_URL = originalGateway;
  await rm(root, { recursive: true, force: true });
});

describe("the Summer API client", () => {
  it("lists models and estimates without a key", async () => {
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

  it("runs a job with the key, one idempotency key and Prefer: wait, follows it and saves its files", async () => {
    await writeStoreText("api-key", `${KEY}\n`);
    let reads = 0;
    const api = fakeApi((call) => {
      if (call.url.endsWith("/v1/jobs")) return Response.json({ job: { id: "cj_1", state: "running", model: "3d/hunyuan-3d", estimatedPrice: "0.75", pollAfterSeconds: 5 } }, { status: 202 });
      if (call.url.endsWith("/v1/jobs/cj_1")) {
        reads += 1;
        return Response.json({ job: reads < 2 ? { id: "cj_1", state: "running" } : { id: "cj_1", state: "done", price: "0.75", result: { assets: [{ assetId: "a1", fileUrl: "https://files.example/a1.glb" }] } } });
      }
      return new Response("glb-bytes");
    });
    const job = await runJob("3d/default", { prompt: "a chest" }, { waitSeconds: 30 }, { fetch: api.fetch });
    expect(api.calls[0].headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(api.calls[0].headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(api.calls[0].headers.get("prefer")).toBe("wait=30");
    const out = join(root, "out");
    const answer = await jobToolResult(job, { out }, { fetch: api.fetch, sleep: noSleep });
    expect(answer).toMatchObject({ job: { state: "done", price: "0.75" }, files: [join(out, "a1.glb")] });
    expect(await readFile(join(out, "a1.glb"), "utf8")).toBe("glb-bytes");
  });

  it("asks for a key before a run, and passes the server's billing error through", async () => {
    await expect(runJob("3d/default", {}, {}, { fetch: vi.fn() as never })).rejects.toMatchObject({ code: "no_api_key" });
    process.env.SUMMER_API_KEY = KEY;
    const api = fakeApi(() => Response.json({ error: { code: "over_limit", message: "This API key reached its spend limit." } }, { status: 402 }));
    await expect(getJob("cj_1", { fetch: api.fetch })).rejects.toMatchObject({ code: "over_limit", status: 402, message: "This API key reached its spend limit." });
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

  it("summer login --api-key prints the same line", async () => {
    const lines: string[] = [];
    const missing = vi.fn(async () => closed()) as unknown as typeof fetch;
    const code = await runApiKeyLogin({}, {
      hasApiKey: async () => false,
      start: (options) => startApiKeyRequest(options, { fetch: missing }),
      wait: async () => ({ status: "pending" }),
      openUrl: async () => undefined,
      client: () => "Codex",
      isTTY: false,
      print: (line) => lines.push(line),
    });
    expect(code).toBe(1);
    expect(lines).toEqual([API_NOT_OPEN]);
  });
});
