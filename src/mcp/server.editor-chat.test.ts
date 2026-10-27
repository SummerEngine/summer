import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSummerDirForTests } from "../core/store.js";
import { EDITOR_CHAT_REFUSAL } from "../core/editor-chat.js";
import { createMcpServer } from "./server.js";
import { resolveToolSelection } from "./tool-surface.js";
import type { CloudCaller } from "./ops-surface.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-editor-chat-test-"));
  setSummerDirForTests(join(root, ".summer"));
  vi.stubEnv("SUMMER_NO_TELEMETRY", "1");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  setSummerDirForTests(null);
  await rm(root, { recursive: true, force: true });
});

const envelope = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const answerOf = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);

/** A hosted server that would start jobs and answer waits; the editor chat must never reach it for those. */
function fakeCloud(): CloudCaller & { call: ReturnType<typeof vi.fn> } {
  return {
    call: vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "summer_search") return envelope({ ok: true, status: "done", result: { items: [] } });
      if (args.op === "jobs.wait") return envelope({ ok: true, status: "done", result: { job: { id: "gen:1", state: "running" }, finished: false } });
      return envelope({ ok: true, status: "running", job: { id: "gen:5037aff5", state: "queued" } });
    }),
  };
}

async function session(surface: "v3" | "v4", options: { profile?: string; legacy?: boolean } = {}) {
  const cloud = fakeCloud();
  const { server } = createMcpServer(resolveToolSelection({ profile: options.profile ?? "full" }, {}), { surface, cloud, legacy: options.legacy });
  // A hosted direct tool as the hosted mount registers it (hosted-mount.ts): registerTool, after the local tools.
  const hostedHandler = vi.fn(async () => envelope({ ok: true, status: "running", job: { id: "gen:2", state: "queued" } }));
  for (const name of ["summer_jobs_wait", "summer_assets_generate_3d", "summer_tool_bankai_motion", "summer_games_list"]) {
    server.registerTool(name, { description: `hosted ${name}` }, hostedHandler as never);
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "summer-editor-chat", version: "1.0.0" });
  await client.connect(clientSide);
  return { client, cloud, hostedHandler, close: async () => { await client.close(); await server.close(); } };
}

function expectRefusal(result: unknown, op: string) {
  expect((result as { isError?: boolean }).isError).toBe(true);
  expect(answerOf(result)).toEqual({
    ok: false,
    error: { code: "unsupported", message: EDITOR_CHAT_REFUSAL, retry: "no", next: { say: expect.stringContaining("summer_cloud") }, details: { op, reason: "editor_chat" } },
  });
}

describe("the Summer editor chat (SUMMER_EDITOR_CHAT=1) never waits on, checks or starts a generation job", () => {
  it.each([
    ["jobs.wait", { jobId: "gen:5037aff5", timeoutSeconds: 50 }, "jobs.wait"],
    ["jobs.get", { jobId: "gen:5037aff5" }, "jobs.get"],
    ["summer_check_job", { jobId: "gen:5037aff5" }, "jobs.get"],
    ["summer_jobs_wait", { jobId: "gen:5037aff5" }, "jobs.wait"],
    ["assets.generate_3d", { prompt: "a chest" }, "assets.generate_3d"],
    ["assets.generate_image", { prompt: "a chest" }, "assets.generate_image"],
    ["summer_generate_image", { prompt: "a chest" }, "assets.generate_image"],
    ["assets.rig", { assetId: "a1" }, "assets.rig"],
    ["makers.bankai_motion", {}, "makers.bankai_motion"],
  ])("summer_call %s answers at once with the refusal, without Summer's server", async (op, input, resolved) => {
    vi.stubEnv("SUMMER_EDITOR_CHAT", "1");
    const { client, cloud, close } = await session("v4");
    try {
      expectRefusal(await client.callTool({ name: "summer_call", arguments: { op, input } }), resolved);
      // `name` is an alias of op: it is refused the same way.
      expectRefusal(await client.callTool({ name: "summer_call", arguments: { name: op, input } }), resolved);
      expect(cloud.call).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("refuses the hosted direct tools and leaves them out of tools/list", async () => {
    vi.stubEnv("SUMMER_EDITOR_CHAT", "1");
    const { client, hostedHandler, close } = await session("v4");
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      for (const hidden of ["summer_jobs_wait", "summer_assets_generate_3d", "summer_tool_bankai_motion"]) expect(names).not.toContain(hidden);
      expect(names).toEqual(expect.arrayContaining(["summer_call", "summer_search", "summer_games_list"]));
      expectRefusal(await client.callTool({ name: "summer_jobs_wait", arguments: { jobId: "gen:1" } }), "jobs.wait");
      expectRefusal(await client.callTool({ name: "summer_assets_generate_3d", arguments: { prompt: "a chest" } }), "assets.generate_3d");
      expectRefusal(await client.callTool({ name: "summer_tool_bankai_motion", arguments: {} }), "makers.bankai_motion");
      expect(hostedHandler).not.toHaveBeenCalled();
      // Everything else still runs.
      await client.callTool({ name: "summer_games_list", arguments: {} });
      expect(hostedHandler).toHaveBeenCalledTimes(1);
    } finally {
      await close();
    }
  });

  it("refuses the 3.x generation and job tools on the v3 surface and the legacy toolset", async () => {
    vi.stubEnv("SUMMER_EDITOR_CHAT", "1");
    for (const surface of ["v3", "v4"] as const) {
      const { client, close } = await session(surface, { legacy: surface === "v4" });
      try {
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        for (const hidden of ["summer_generate_image", "summer_generate_3d", "summer_check_job"]) expect(names).not.toContain(hidden);
        expectRefusal(await client.callTool({ name: "summer_check_job", arguments: { jobId: "gen:1" } }), "jobs.get");
        expectRefusal(await client.callTool({ name: "summer_generate_3d", arguments: { prompt: "a chest" } }), "assets.generate_3d");
      } finally {
        await close();
      }
    }
  });

  it("summer_search and ops.search do not find those operations", async () => {
    vi.stubEnv("SUMMER_EDITOR_CHAT", "1");
    const { client, close } = await session("v4");
    try {
      for (const query of ["wait for a job", "check a job", "generate a 3D model", "generate an image"]) {
        const direct = answerOf(await client.callTool({ name: "summer_search", arguments: { query, limit: 20 } }));
        const viaCall = answerOf(await client.callTool({ name: "summer_call", arguments: { op: "ops.search", input: { query, limit: 20 } } }));
        for (const answer of [direct, viaCall]) {
          const found = (answer.result.items as Array<{ name: string }>).map((item) => item.name);
          expect(found.filter((name) => /^jobs\.(wait|get)$|^assets\.generate_|^makers\./.test(name))).toEqual([]);
        }
      }
    } finally {
      await close();
    }
  });

  it("outside the editor chat, summer_call forwards jobs.wait and generation, and search finds them, as before", async () => {
    const { client, cloud, close } = await session("v4");
    try {
      const waited = answerOf(await client.callTool({ name: "summer_call", arguments: { op: "jobs.wait", input: { jobId: "gen:1" } } }));
      expect(waited).toMatchObject({ ok: true, status: "done" });
      const started = answerOf(await client.callTool({ name: "summer_call", arguments: { op: "assets.generate_3d", input: { prompt: "a chest" } } }));
      expect(started).toMatchObject({ ok: true, status: "running" });
      expect(cloud.call).toHaveBeenCalledWith("summer_call", expect.objectContaining({ op: "jobs.wait" }));
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("summer_jobs_wait");
      const found = answerOf(await client.callTool({ name: "summer_search", arguments: { query: "wait for a job", limit: 20 } }));
      expect((found.result.items as Array<{ name: string }>).map((item) => item.name)).toContain("jobs.wait");
    } finally {
      await close();
    }
  });
});
