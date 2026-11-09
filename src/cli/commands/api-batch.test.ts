import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSummerDirForTests } from "../../core/store.js";
import { batchToolResult, getBatch, MAX_BATCH_JOBS, parseBatchLines } from "../../core/summer-api.js";
import { runApiAction, runBatch } from "./api.js";

/**
 * `summer api run --batch` and summer_api_batch against a fake /v1 with the
 * server's shapes (PSE POST /v1/batches, GET /v1/batches/{id}): a JSONL file,
 * one batch Idempotency-Key, all or none (402 says how many fit), following
 * every job and saving its files, and the JSON summary when piped.
 */

let root = "";
const originalGateway = process.env.SUMMER_GATEWAY_URL;
const signedIn = async () => "oauth-access-token";
const noSleep = async () => undefined;

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

const queued = { batch: { id: "b_12345678", estimatedPrice: "1.05", jobs: [{ id: "q:1", state: "queued", model: "3d/hunyuan-3d", estimatedPrice: "0.525" }, { id: "q:2", state: "queued", model: "3d/hunyuan-3d", estimatedPrice: "0.525" }] } };
const doneJob = (id: string, asset: string) => ({ id, state: "done", model: "3d/hunyuan-3d", price: "0.525", result: { assets: [{ assetId: asset, fileUrl: `https://files.example/${asset}.glb` }] } });

/** POST queues the batch; the first read has one job running, the next has both done; files download. */
function batchServer() {
  let reads = 0;
  return fakeApi((call) => {
    if (call.method === "POST" && call.url.endsWith("/v1/batches")) return Response.json(queued, { status: 202 });
    if (call.url.endsWith("/v1/batches/b_12345678")) {
      reads += 1;
      const jobs = reads < 2 ? [{ id: "cj_1", state: "running" }, { id: "q:2", state: "queued" }] : [doneJob("cj_1", "a1"), doneJob("cj_2", "a2")];
      return Response.json({ batch: { id: "b_12345678", estimatedPrice: "1.05", counts: reads < 2 ? { running: 1, queued: 1 } : { done: 2 }, jobs } });
    }
    return new Response(`bytes of ${call.url.split("/").pop()}`);
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-api-batch-test-"));
  setSummerDirForTests(join(root, ".summer"));
  process.env.SUMMER_GATEWAY_URL = "https://gateway.example";
});

afterEach(async () => {
  setSummerDirForTests(null);
  if (originalGateway === undefined) delete process.env.SUMMER_GATEWAY_URL;
  else process.env.SUMMER_GATEWAY_URL = originalGateway;
  await rm(root, { recursive: true, force: true });
});

describe("a batch file", () => {
  it("reads one job per line, skips blank lines, and says which line is wrong", () => {
    const text = '{"model": "3d/default", "input": {"prompt": "a chest"}}\n\n{"model": "sound/default", "input": {"prompt": "a coin"}, "idempotencyKey": "coin-1"}\n';
    expect(parseBatchLines(text)).toEqual([
      { model: "3d/default", input: { prompt: "a chest" } },
      { model: "sound/default", input: { prompt: "a coin" }, idempotencyKey: "coin-1" },
    ]);
    expect(() => parseBatchLines('{"model": "3d/default"}\nnot json')).toThrow(/Line 2 is not JSON/);
    expect(() => parseBatchLines('{"input": {}}')).toThrow(/Line 1: needs "model"/);
    expect(() => parseBatchLines('{"model": "3d/default", "input": []}')).toThrow(/"input" must be a JSON object/);
    expect(() => parseBatchLines("\n\n")).toThrow(/no jobs/);
    expect(() => parseBatchLines(Array.from({ length: MAX_BATCH_JOBS + 1 }, () => '{"model": "image/default"}').join("\n"))).toThrow(/at most 500/);
  });
});

describe("summer api run --batch", () => {
  it("queues the file as one batch with one Idempotency-Key, follows every job, saves the files and prints JSON when piped", async () => {
    const file = join(root, "jobs.jsonl");
    await writeFile(file, '{"model": "3d/default", "input": {"prompt": "a chest"}}\n{"model": "3d/default", "input": {"prompt": "a barrel"}, "idempotencyKey": "barrel-1"}\n');
    const api = batchServer();
    const out = join(root, "assets");
    const lines: string[] = [];
    const code = await runApiAction({}, () => runBatch(file, { download: out }, { fetch: api.fetch, sleep: noSleep, token: signedIn }), { isTTY: false, print: (line) => lines.push(line), printError: () => undefined });
    expect(code).toBe(0);
    const post = api.calls[0];
    expect(post).toMatchObject({ method: "POST", url: "https://gateway.example/v1/batches" });
    expect(post.headers.get("authorization")).toBe("Bearer oauth-access-token");
    expect(post.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(post.body).toEqual({ jobs: [{ model: "3d/default", input: { prompt: "a chest" } }, { model: "3d/default", input: { prompt: "a barrel" }, idempotencyKey: "barrel-1" }] });
    const summary = JSON.parse(lines.join("\n"));
    expect(summary).toMatchObject({ batch: { id: "b_12345678", counts: { done: 2 } }, files: { cj_1: [join(out, "a1.glb")], cj_2: [join(out, "a2.glb")] } });
    expect(await readFile(join(out, "a2.glb"), "utf8")).toBe("bytes of a2.glb");
  });

  it("runs nothing when the credits do not cover every job, and the JSON error says how many fit", async () => {
    const file = join(root, "jobs.jsonl");
    await writeFile(file, '{"model": "3d/default", "input": {}}\n'.repeat(3));
    const details = { fits: 1, jobs: 3, totalUsd: 1.575, shortUsd: 1.05 };
    const api = fakeApi(() => Response.json({ error: { code: "no_credits", message: "Your paid credits cover 1 of 3; add $1.05 or more to run them all.", details } }, { status: 402 }));
    const lines: string[] = [];
    const errors: string[] = [];
    const io = { print: (line: string) => lines.push(line), printError: (line: string) => errors.push(line) };
    expect(await runApiAction({}, () => runBatch(file, { wait: true }, { fetch: api.fetch, sleep: noSleep, token: signedIn }), { isTTY: false, ...io })).toBe(1);
    expect(JSON.parse(lines[0])).toEqual({ ok: false, error: { code: "no_credits", message: "Your paid credits cover 1 of 3; add $1.05 or more to run them all.", details } });
    expect(await runApiAction({}, () => runBatch(file, {}, { fetch: api.fetch, token: signedIn }), { isTTY: true, ...io })).toBe(1);
    expect(errors).toEqual(["Your paid credits cover 1 of 3; add $1.05 or more to run them all."]);
    expect(api.calls.every((call) => call.method === "POST")).toBe(true);
  });

  it("says when it cannot read the batch file, before calling the API", async () => {
    const api = fakeApi(() => Response.json({}));
    await expect(runBatch(join(root, "missing.jsonl"), {}, { fetch: api.fetch, token: signedIn })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("missing.jsonl") });
    expect(api.calls).toEqual([]);
  });
});

describe("summer_api_batch", () => {
  it("reads a batch by id, follows it within one call and says how to keep following", async () => {
    const api = batchServer();
    const first = await getBatch("b_12345678", { fetch: api.fetch, token: signedIn });
    expect(await batchToolResult(first, {}, { fetch: api.fetch, token: signedIn })).toMatchObject({ batch: { counts: { running: 1, queued: 1 } }, next: expect.stringContaining("batchId b_12345678") });
    const followed = await batchToolResult(first, { wait: true }, { fetch: api.fetch, sleep: noSleep, token: signedIn });
    expect(followed).toMatchObject({ batch: { counts: { done: 2 } } });
    expect(followed).not.toHaveProperty("next");
  });
});
