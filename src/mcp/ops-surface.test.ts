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
import { withV4Surface } from "../core/ops/cloud.js";

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

async function session(profile: string | undefined, surface: "v3" | "v4", cloud = fakeCloud(), legacy = false) {
  const { server } = createMcpServer(resolveToolSelection({ profile }, {}), { surface, cloud, legacy });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "claude-code", version: "2.0.0" });
  await client.connect(clientSide);
  return { client, cloud, close: async () => { await client.close(); await server.close(); } };
}

const answerOf = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);

describe("the surface flag", () => {
  it("defaults to v4 and reads --surface or SUMMER_SURFACE", () => {
    expect(resolveSurface(undefined, {})).toBe("v4");
    expect(resolveSurface("v3", {})).toBe("v3");
    expect(resolveSurface(undefined, { SUMMER_SURFACE: "V3" })).toBe("v3");
    expect(resolveSurface("v4", { SUMMER_SURFACE: "v3" })).toBe("v4");
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
      expect(tools.find((tool) => tool.name === "summer_api_docs")!.title).toBe("Look up an engine class");
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

  it("names a bad input of a docs operation and points at ops.describe", async () => {
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

describe("v4 engine operations", () => {
  it("list each engine tool as its operation: title, a short summary with its guide, hints from its effect", async () => {
    const { client, close } = await session("engine", "v4");
    try {
      const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
      const setProp = tools.get("summer_set_prop")!;
      expect(setProp.title).toBe("Set a node property");
      expect(setProp.description).toContain('Guide: summer_docs_read {"id":"tool/set-prop"}');
      expect(setProp.description).toContain("summer_run_script");
      expect(setProp.annotations).toEqual({ title: "Set a node property", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
      expect(tools.get("summer_get_scene_tree")!.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, openWorldHint: false });
      expect(tools.get("summer_import_from_url")!.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
      for (const [name, tool] of tools) {
        // The executors and the docs aliases keep their own descriptions.
        if (!name.startsWith("summer_") || ["summer_search", "summer_call", "summer_docs_search", "summer_docs_read"].includes(name)) continue;
        const summary = (tool.description ?? "").split("\nGuide: ")[0];
        expect(summary.length, name).toBeLessThanOrEqual(300);
        expect(tool.title, name).toBeTruthy();
      }
    } finally {
      await close();
    }
  });

  it("names only tools this session lists", async () => {
    const { client, close } = await session("engine", "v4");
    try {
      const tools = (await client.listTools()).tools;
      const names = new Set(tools.map((tool) => tool.name));
      const unknown = tools.flatMap((tool) => [...JSON.stringify(tool).matchAll(/summer_[a-z0-9_]+/g)].map((m) => m[0]).filter((name) => !names.has(name)).map((name) => `${tool.name} -> ${name}`));
      expect([...new Set(unknown)], [...new Set(unknown)].join("; ")).toEqual([]);
    } finally {
      await close();
    }
  });

  it("splits the mixed bookmark tool into a read and two changes", async () => {
    const { client, close } = await session("engine", "v4");
    try {
      const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
      expect(tools.has("summer_camera_bookmark")).toBe(false);
      expect(tools.get("summer_engine_list_camera_bookmarks")!.annotations).toMatchObject({ readOnlyHint: true });
      const save = tools.get("summer_engine_save_camera_bookmark")!;
      expect(save.annotations).toMatchObject({ readOnlyHint: false });
      expect(save.inputSchema.required).toEqual(["name"]);
      expect(Object.keys(save.inputSchema.properties ?? {})).toEqual(["name", "position", "look_at", "fov"]);
      expect(tools.get("summer_engine_delete_camera_bookmark")!.inputSchema.required).toEqual(["name"]);
    } finally {
      await close();
    }
  });

  it("cuts long parameter descriptions to whole sentences; the guide keeps them whole", async () => {
    const { client, close } = await session("engine", "v4");
    try {
      const play = (await client.listTools()).tools.find((tool) => tool.name === "summer_play")!;
      for (const property of Object.values(play.inputSchema.properties ?? {}) as Array<{ description?: string }>) {
        expect((property.description ?? "").length).toBeLessThanOrEqual(201);
      }
    } finally {
      await close();
    }
  });

  it("answers engine_not_running with one next step from a direct engine tool", async () => {
    const { client, close } = await session("engine", "v4");
    try {
      const result = await client.callTool({ name: "summer_get_scene_tree", arguments: {} });
      expect(result.isError).toBe(true);
      expect(answerOf(result)).toEqual({
        ok: false,
        error: { code: "engine_not_running", message: "Summer Engine is not running, or no project is open.", next: { say: expect.stringContaining("Open the project in Summer Engine") }, retry: "safe" },
      });
      expect(result.structuredContent).toEqual(answerOf(result));
    } finally {
      await close();
    }
  });

  it("runs a split operation by its 4.0 name and a bad engine input points at the tool's guide", async () => {
    const { client, close } = await session("engine", "v4");
    try {
      const save = answerOf(await client.callTool({ name: "summer_call", arguments: { op: "engine.save_camera_bookmark", input: { name: "hero" } } }));
      expect(save).toMatchObject({ ok: false, error: { code: "engine_not_running" } });
      for (const op of ["summer_engine_save_camera_bookmark", "summer_camera_bookmark"]) {
        const byTool = answerOf(await client.callTool({ name: "summer_call", arguments: { op, input: { action: "save", name: "hero" } } }));
        expect(byTool, op).toMatchObject({ ok: false, error: { code: "engine_not_running" } });
      }
      const bad = answerOf(await client.callTool({ name: "summer_call", arguments: { op: "engine.set_prop", input: { scenePath: "res://main.tscn" } } }));
      expect(bad).toMatchObject({ ok: false, error: { code: "invalid_input", next: { op: "docs.read", input: { id: "tool/set-prop" } } } });
    } finally {
      await close();
    }
  });

  it("runs a split operation as its 3.x tool with the action fixed, and checks its own required fields", async () => {
    const { server } = createMcpServer(resolveToolSelection({ profile: "engine" }, {}), { surface: "v4", cloud: fakeCloud() });
    const registered = (server as unknown as { _registeredTools: Record<string, { handler: unknown }> })._registeredTools;
    const sent: unknown[] = [];
    registered.summer_camera_bookmark.handler = async (args: unknown) => {
      sent.push(args);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, saved: true }) }] };
    };
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "claude-code", version: "2.0.0" });
    await client.connect(clientSide);
    try {
      expect(answerOf(await client.callTool({ name: "summer_engine_save_camera_bookmark", arguments: { name: "hero" } }))).toEqual({ ok: true, status: "done", result: { ok: true, saved: true } });
      expect(answerOf(await client.callTool({ name: "summer_call", arguments: { op: "engine.delete_camera_bookmark", input: { name: "old", action: "save" } } }))).toMatchObject({ ok: true });
      expect(answerOf(await client.callTool({ name: "summer_call", arguments: { op: "summer_camera_bookmark", input: { action: "list" } } }))).toMatchObject({ ok: true });
      expect(sent).toEqual([{ name: "hero", action: "save" }, { name: "old", action: "delete" }, { action: "list" }]);
      const missing = answerOf(await client.callTool({ name: "summer_call", arguments: { op: "engine.save_camera_bookmark", input: {}, dryRun: true } }));
      expect(missing).toMatchObject({ ok: false, error: { code: "invalid_input", message: "name: required.", next: { op: "docs.read", input: { id: "tool/camera-bookmark" } } } });
      expect(sent).toHaveLength(3);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("dry-runs an engine operation without the engine: the input is checked, nothing is sent", async () => {
    const { client, close } = await session("engine", "v4");
    try {
      const answer = answerOf(await client.callTool({ name: "summer_call", arguments: { op: "engine.add_node", input: { scenePath: "res://main.tscn", parent: ".", type: "OmniLight3D", name: "Lamp" }, dryRun: true } }));
      expect(answer).toEqual({ ok: true, status: "dry_run", preview: { summary: "Add a node on res://main.tscn: the input is valid. Nothing was done.", changes: [], approval: "none", estimate: null, valid: true } });
    } finally {
      await close();
    }
  });

  it("describes a local operation here, in the contract's wire form", async () => {
    const { client, cloud, close } = await session("engine", "v4");
    try {
      const answer = answerOf(await client.callTool({ name: "summer_call", arguments: { op: "ops.describe", input: { name: "summer_run_script" } } }));
      expect(answer).toMatchObject({ ok: true, result: { operation: { name: "engine.run_script", mcpName: "summer_run_script", effect: "write", status: "stable", input: { properties: expect.objectContaining({ scenePath: expect.any(Object) }) } } } });
      expect(cloud.call).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("serves at most about half the tokens of the 3.x engine profile", async () => {
    const size = async (surface: "v3" | "v4") => {
      const { client, close } = await session("engine", surface);
      try {
        return JSON.stringify((await client.listTools()).tools).length;
      } finally {
        await close();
      }
    };
    expect(await size("v4")).toBeLessThan((await size("v3")) * 0.55);
  });
});

describe("v4, local operations that need the engine", () => {
  it("say engine_not_running for a non-engine area too (apps.dock)", async () => {
    const { client, close } = await session(undefined, "v4");
    try {
      const answer = answerOf(await client.callTool({ name: "summer_call", arguments: { op: "apps.dock", input: { action: "list" } } }));
      expect(answer).toMatchObject({ ok: false, error: { code: "engine_not_running" } });
    } finally {
      await close();
    }
  });
});

describe("v4, legacy toolset", () => {
  it("lists every local 3.x name again, each saying which operation replaces it", async () => {
    const { client, close } = await session("engine", "v4", fakeCloud(), true);
    try {
      const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
      expect(tools.get("summer_generate_image")!.description).toMatch(/^3\.x name; use assets\.generate_image\. /);
      expect(tools.get("summer_search_library")!.description).toMatch(/^3\.x name; use docs\.search\. /);
      expect(tools.get("summer_camera_bookmark")!.description).toMatch(/^3\.x name; use summer_engine_list_camera_bookmarks, summer_engine_save_camera_bookmark, summer_engine_delete_camera_bookmark\./);
      expect(tools.get("summer_set_prop")!.title).toBe("Set a node property");
    } finally {
      await close();
    }
  });
});

describe("v4, asset generation runs on the hosted server", () => {
  const running = { ok: true, status: "running", job: { id: "gen:4821", op: "assets.generate_3d", state: "queued", pollAfterSeconds: 30 } };

  function hostedJobs(): CloudCaller & { call: ReturnType<typeof vi.fn> } {
    return { call: vi.fn(async () => envelope(running)) };
  }

  it("asks the hosted server for the assets profile's own direct tools", () => {
    expect(withV4Surface("https://mcp.summerengine.com/mcp", "assets")).toBe("https://mcp.summerengine.com/mcp?surface=v4&profile=assets");
    expect(withV4Surface("https://mcp.summerengine.com/mcp", "engine")).toBe("https://mcp.summerengine.com/mcp?surface=v4");
    expect(withV4Surface("https://mcp.summerengine.com/mcp")).toBe("https://mcp.summerengine.com/mcp?surface=v4");
  });

  it("forwards a generator by its 4.0 name and passes the job back unchanged", async () => {
    const { client, cloud, close } = await session("assets", "v4", hostedJobs());
    try {
      const answer = answerOf(await client.callTool({ name: "summer_call", arguments: { op: "assets.generate_3d", input: { prompt: "a chest" } } }));
      expect(cloud.call).toHaveBeenCalledWith("summer_call", { op: "assets.generate_3d", input: { prompt: "a chest" } });
      expect(answer).toEqual(running);
    } finally {
      await close();
    }
  });

  it("runs a 3.x generation name with its local 3.x tool, as in 3.x", async () => {
    const { client, cloud, close } = await session("engine", "v4", hostedJobs());
    try {
      await client.callTool({ name: "summer_call", arguments: { op: "summer_generate_3d", input: { prompt: "a chest" } } });
      expect(cloud.call).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("forwards a dry run, so the estimate comes from the hosted server", async () => {
    const { client, cloud, close } = await session("assets", "v4", hostedJobs());
    try {
      await client.callTool({ name: "summer_call", arguments: { op: "assets.generate_video", input: { prompt: "rain" }, dryRun: true } });
      expect(cloud.call).toHaveBeenCalledWith("summer_call", { op: "assets.generate_video", input: { prompt: "rain" }, dryRun: true });
    } finally {
      await close();
    }
  });
});
