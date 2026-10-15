import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSummerDirForTests } from "../core/store.js";
import { createMcpServer, resolveSurface } from "./server.js";
import { resolveToolSelection } from "./tool-surface.js";
import type { CloudCaller } from "./ops-surface.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-ops-surface-test-"));
  setSummerDirForTests(join(root, ".summer"));
  process.env.SUMMER_NO_TELEMETRY = "1";
});

afterEach(async () => {
  setSummerDirForTests(null);
  delete process.env.SUMMER_NO_TELEMETRY;
  await rm(root, { recursive: true, force: true });
});

const envelope = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

function fakeCloud(): CloudCaller & { call: ReturnType<typeof vi.fn> } {
  return {
    call: vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "summer_search") {
        return envelope({ ok: true, status: "done", result: { items: [{ name: "pricing.set_base", title: "Set the base price", summary: "Ask the owner to change a game's base price.", effect: "player_facing", approval: "owner", provider: "cloud", status: "preview", available: true, input: { type: "object" } }] } });
      }
      return envelope({ ok: true, status: "done", result: { echo: args } });
    }),
  };
}

async function session(profile: string | undefined, surface: "v3" | "v4", cloud = fakeCloud()) {
  const { server } = createMcpServer(resolveToolSelection({ profile }, {}), { surface, cloud });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "claude-code", version: "2.0.0" });
  await client.connect(clientSide);
  return { client, cloud, close: async () => { await client.close(); await server.close(); } };
}

const answerOf = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);

describe("the surface flag", () => {
  it("defaults to v3 and reads --surface or SUMMER_SURFACE", () => {
    expect(resolveSurface(undefined, {})).toBe("v3");
    expect(resolveSurface("v4", {})).toBe("v4");
    expect(resolveSurface(undefined, { SUMMER_SURFACE: "V4" })).toBe("v4");
  });

  it("leaves the 3.x surface exactly as it was", async () => {
    const { client, close } = await session("engine", "v3");
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("summer_generate_image");
      expect(names).toContain("summer_search_library");
      expect(names).not.toContain("summer_call");
    } finally {
      await close();
    }
  });
});

describe("v4, engine profile", () => {
  it("lists the engine tools by their 3.x names, docs, summer_search and summer_call, and nothing else local", async () => {
    const { client, close } = await session("engine", "v4");
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(["summer_set_prop", "summer_add_node", "summer_run_script", "summer_docs_search", "summer_docs_read", "summer_search", "summer_call"]));
      for (const hidden of ["summer_generate_image", "summer_search_library", "summer_check_job", "summer_open"]) expect(names).not.toContain(hidden);
    } finally {
      await close();
    }
  });

  it("runs a local operation by its 4.0 name and by its 3.x name, with the one answer shape", async () => {
    const { client, close } = await session("engine", "v4");
    try {
      const byOp = answerOf(await client.callTool({ name: "summer_call", arguments: { op: "docs.search", input: { query: "multiplayer lobby" } } }));
      expect(byOp).toMatchObject({ ok: true, status: "done", result: expect.objectContaining({ results: expect.any(Array) }) });
      const byOld = answerOf(await client.callTool({ name: "summer_call", arguments: { op: "summer_search_library", input: { query: "multiplayer lobby" } } }));
      expect(byOld.ok).toBe(true);
    } finally {
      await close();
    }
  });

  it("lists the offline engine class reference, and ends library reads with the v4 feedback footer", async () => {
    const { client, close } = await session("engine", "v4");
    try {
      const tools = (await client.listTools()).tools;
      const names = tools.map((tool) => tool.name);
      expect(names).toContain("summer_api_docs");
      expect(tools.find((tool) => tool.name === "summer_api_docs")!.description!.length).toBeLessThanOrEqual(300);
      const read = await client.callTool({ name: "summer_docs_read", arguments: { id: "skill/multiplayer" } });
      const text = (read as { content: Array<{ text: string }> }).content.map((part) => part.text).join("\n");
      expect(text).toContain('report via summer_call {"op":"docs.feedback"}.');
      expect(text).not.toContain("summer_library_feedback");
      const viaCall = answerOf(await client.callTool({ name: "summer_call", arguments: { op: "docs.read", input: { id: "skill/multiplayer" } } }));
      expect(JSON.stringify(viaCall)).toContain("docs.feedback");
    } finally {
      await close();
    }
  });

  it("names a bad input and points at ops.describe", async () => {
    const { client, close } = await session("engine", "v4");
    try {
      const answer = answerOf(await client.callTool({ name: "summer_call", arguments: { op: "docs.read", input: { id: 42 } } }));
      expect(answer).toMatchObject({ ok: false, error: { code: "invalid_input", next: { op: "ops.describe", input: { name: "docs.read" } } } });
    } finally {
      await close();
    }
  });

  it("says the engine is not running instead of failing silently", async () => {
    const { client, close } = await session("engine", "v4");
    try {
      const answer = answerOf(await client.callTool({ name: "summer_call", arguments: { op: "engine.get_scene_tree", input: {} } }));
      expect(answer).toMatchObject({ ok: false, error: { code: "engine_not_running", retry: "safe" } });
    } finally {
      await close();
    }
  });

  it("runs a 3.x name this server registers with its local tool, even when its operation is cloud", async () => {
    const { client, cloud, close } = await session("engine", "v4");
    try {
      const answer = answerOf(await client.callTool({ name: "summer_call", arguments: { op: "summer_list_my_assets", input: {} } }));
      expect(cloud.call).not.toHaveBeenCalled();
      expect(answer.ok).toBe(false);
    } finally {
      await close();
    }
  });

  it("forwards cloud operations to the hosted summer_call unchanged", async () => {
    const { client, cloud, close } = await session("engine", "v4");
    try {
      const answer = answerOf(await client.callTool({ name: "summer_call", arguments: { op: "games.list", input: { limit: 3 }, idempotencyKey: "k" } }));
      expect(cloud.call).toHaveBeenCalledWith("summer_call", { op: "games.list", input: { limit: 3 }, idempotencyKey: "k" });
      expect(answer).toEqual({ ok: true, status: "done", result: { echo: { op: "games.list", input: { limit: 3 }, idempotencyKey: "k" } } });
    } finally {
      await close();
    }
  });

  it("searches local and cloud operations in one list, each with its input", async () => {
    const { client, close } = await session("engine", "v4");
    try {
      const local = answerOf(await client.callTool({ name: "summer_search", arguments: { query: "set a property on a node" } }));
      const setProp = local.result.items.find((item: { name: string }) => item.name === "engine.set_prop");
      expect(setProp).toMatchObject({ mcpTool: "summer_set_prop", input: { type: "object", properties: expect.objectContaining({ scenePath: expect.any(Object) }) } });
      const cloud = answerOf(await client.callTool({ name: "summer_search", arguments: { query: "set the base price" } }));
      expect(cloud.result.items.map((item: { name: string }) => item.name)).toContain("pricing.set_base");
    } finally {
      await close();
    }
  });

  it("still searches the local operations when the hosted server is not reachable", async () => {
    const offline: CloudCaller & { call: ReturnType<typeof vi.fn> } = { call: vi.fn(async () => { throw new Error("not signed in"); }) };
    const { client, close } = await session("engine", "v4", offline);
    try {
      const answer = answerOf(await client.callTool({ name: "summer_search", arguments: { query: "add a node" } }));
      expect(answer.result.items[0].name).toBe("engine.add_node");
      expect(answer.warnings[0]).toContain("not signed in");
      const call = answerOf(await client.callTool({ name: "summer_call", arguments: { op: "games.list" } }));
      expect(call).toMatchObject({ ok: false, error: { code: "not_signed_in" } });
    } finally {
      await close();
    }
  });
});

describe("v4, assets profile", () => {
  it("lists no engine tools", async () => {
    const { client, close } = await session("assets", "v4");
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(["summer_docs_search", "summer_search", "summer_call"]));
      expect(names).not.toContain("summer_set_prop");
      expect(names).not.toContain("summer_api_docs");
    } finally {
      await close();
    }
  });
});
