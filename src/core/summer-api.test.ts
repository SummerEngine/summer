import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSummerDirForTests } from "./store.js";
import {
  MAX_POLL_FAILURES,
  batchToolResult,
  createBatch,
  jobToolResult,
  runJob,
  summerApiToolAnswer,
  waitForJob,
  type Batch,
  type Job,
} from "./summer-api.js";

/**
 * A created job is paid for. Whatever fails afterwards, the answer keeps the
 * job (or batch) id, and an unclear create names its Idempotency-Key.
 */

let root = "";
const originalGateway = process.env.SUMMER_GATEWAY_URL;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-api-paid-"));
  setSummerDirForTests(join(root, ".summer"));
  process.env.SUMMER_GATEWAY_URL = "https://gateway.example";
});

afterEach(async () => {
  setSummerDirForTests(null);
  if (originalGateway === undefined) delete process.env.SUMMER_GATEWAY_URL;
  else process.env.SUMMER_GATEWAY_URL = originalGateway;
  await rm(root, { recursive: true, force: true });
});

function deps(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init));
  return { fetch: fetchMock as unknown as typeof fetch, sleep: async () => undefined, token: async () => "token", spy: fetchMock };
}

const running: Job = { id: "cj_paid", state: "running" };
const done: Job = {
  id: "cj_paid",
  state: "done",
  result: {
    assets: [
      { assetId: "a1", fileUrl: "https://files.example/a1.glb" },
      { assetId: "a2", fileUrl: "https://files.example/a2.glb" },
    ],
  },
};

describe("following a paid job", () => {
  it("retries passing status-read failures and finishes", async () => {
    let reads = 0;
    const api = deps(() => {
      reads += 1;
      if (reads === 1) throw new TypeError("fetch failed");
      if (reads === 2) return Response.json({ error: { message: "busy" } }, { status: 503 });
      return Response.json({ job: { id: "cj_paid", state: "done" } });
    });
    expect(await waitForJob(running, {}, api)).toMatchObject({ state: "done" });
    expect(reads).toBe(3);
  });

  it("stops after repeated failures and still answers the job id", async () => {
    const api = deps(() => {
      throw new TypeError("fetch failed");
    });
    const answer = await summerApiToolAnswer(() => jobToolResult(running, { wait: true }, api));
    expect(answer).toMatchObject({
      ok: false,
      job: { id: "cj_paid" },
      error: { code: "request_failed", message: "fetch failed" },
      next: expect.stringContaining("do not run it again"),
    });
    expect(api.spy).toHaveBeenCalledTimes(MAX_POLL_FAILURES);
  });

  it("does not retry a refusal, and keeps the job", async () => {
    const api = deps(() => Response.json({ error: { code: "forbidden", message: "No." } }, { status: 403 }));
    expect(await jobToolResult(running, { wait: true }, api)).toMatchObject({ ok: false, job: { id: "cj_paid" }, error: { code: "forbidden" } });
    expect(api.spy).toHaveBeenCalledTimes(1);
  });

  it("saves the files it can when one download fails", async () => {
    const api = deps((url) => (url.endsWith("a1.glb") ? new Response("nope", { status: 503 }) : new Response("second")));
    const out = join(root, "out");
    expect(await jobToolResult(done, { out }, api)).toMatchObject({
      ok: false,
      job: { id: "cj_paid", state: "done" },
      files: [join(out, "a2.glb")],
      error: { code: "download_failed", message: expect.stringContaining("a1.glb (HTTP 503)") },
    });
    expect(await readFile(join(out, "a2.glb"), "utf8")).toBe("second");
  });

  it("keeps the batch and every other job's files when one download fails", async () => {
    const batch: Batch = {
      id: "b_paid",
      jobs: [
        { id: "cj_1", state: "done", result: { assets: [{ assetId: "bad", fileUrl: "https://files.example/bad.png" }] } },
        { id: "cj_2", state: "done", result: { assets: [{ assetId: "good", fileUrl: "https://files.example/good.png" }] } },
      ],
    };
    const api = deps((url) => {
      if (url.endsWith("bad.png")) throw new TypeError("fetch failed");
      return new Response("png");
    });
    const out = join(root, "out");
    expect(await batchToolResult(batch, { out }, api)).toMatchObject({
      ok: false,
      batch: { id: "b_paid" },
      files: { cj_1: [], cj_2: [join(out, "good.png")] },
      next: expect.stringContaining("batchId b_paid"),
    });
  });
});

describe("an unclear create", () => {
  const sentKey = (api: ReturnType<typeof deps>) => new Headers(api.spy.mock.calls[0]![1]!.headers).get("idempotency-key")!;

  it.each([
    ["no answer", (): Promise<Response> => Promise.reject(new TypeError("fetch failed"))],
    ["a server error", async () => Response.json({ error: { message: "boom" } }, { status: 502 })],
  ])("names the key it sent after %s", async (_label, respond) => {
    const api = deps(respond);
    const error = await runJob("3d/default", {}, {}, api).catch((caught: Error) => caught);
    expect((error as Error).message).toContain(`idempotency key ${sentKey(api)}`);
  });

  it("names the key for a batch too", async () => {
    const api = deps(() => Promise.reject(new TypeError("fetch failed")));
    await expect(createBatch([{ model: "m", input: {} }], { idempotencyKey: "mine" }, api)).rejects.toThrow(/idempotency key mine/);
  });

  it("names the batch id when reading a queued batch fails", async () => {
    const api = deps((_url, init) => (init?.method === "POST" ? Response.json({ batch: { id: "b_queued" } }) : Response.json({}, { status: 500 })));
    await expect(createBatch([{ model: "m", input: {} }], {}, api)).rejects.toThrow(/Batch b_queued is queued/);
  });

  it("claims nothing was accepted when the request never left this computer", async () => {
    process.env.SUMMER_GATEWAY_URL = "not a url";
    const api = deps(() => new Response("unused"));
    const error = (await runJob("3d/default", {}, {}, api).catch((caught: Error) => caught)) as Error;
    expect(error.message).not.toContain("idempotency key");
    expect(api.spy).not.toHaveBeenCalled();
  });

  it("leaves a clear refusal as it was", async () => {
    const api = deps(() => Response.json({ error: { code: "no_credits", message: "Add credits." } }, { status: 402 }));
    await expect(runJob("3d/default", {}, {}, api)).rejects.toMatchObject({ code: "no_credits", message: "Add credits." });
  });
});
