import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { OAuthError } from "../core/oauth.js";
import { HostedUnreachableError } from "../core/hosted-mcp.js";
import { setSummerDirForTests } from "../core/store.js";
import { createMcpServer } from "./server.js";
import { defaultHostedMountDependencies, prepareHostedMount, STORE_TOOLS_STATUS, type HostedMountDependencies } from "./hosted-mount.js";
import { resolveToolSelection, selectionIncludes } from "./tool-surface.js";

const TOKEN = "store-oauth-token";

/** A stand-in for mcp.summerengine.com: stateless Streamable HTTP, bearer required. */
function hostedSummerEngine() {
  const seen: Array<{ tool: string; args: unknown; authorization: string | undefined }> = [];
  const build = (authorization: string | undefined) => {
    const server = new McpServer({ name: "summer-engine", version: "1.0.0" });
    server.registerTool(
      "summer_store_submit",
      { description: "Ask the owner to publish.", inputSchema: { gameId: z.string(), priceUsdCents: z.number().int().optional(), focus: z.tuple([z.number(), z.number()]).optional(), coverUrl: z.string().url().optional() } },
      async (args) => {
        seen.push({ tool: "summer_store_submit", args, authorization });
        return { content: [{ type: "text", text: JSON.stringify({ status: "awaiting_owner_approval", approvalUrl: "https://www.summerengine.com/studio/store/g1/approve/oa_1" }) }] };
      }
    );
    // Same name as a local tool: the local one must stay.
    server.registerTool("summer_generate_image", { description: "HOSTED generate", inputSchema: { prompt: z.string() } }, async () => ({ content: [{ type: "text", text: "hosted" }] }));
    server.registerPrompt("publish-your-game", { description: "How to publish." }, async () => ({ messages: [{ role: "user", content: { type: "text", text: "Publish guide" } }] }));
    server.registerResource("store-art", "summer://skills/store-art", { mimeType: "text/markdown" }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: "# Store art" }] }));
    return server;
  };
  const requestHeaders: Array<{ tool?: string; host?: string; client?: string }> = [];
  const http: Server = createServer(async (req, res) => {
    const authorization = req.headers.authorization;
    requestHeaders.push({
      tool: req.headers["x-summer-mcp-tool"] as string | undefined,
      host: req.headers["x-summer-agent-host"] as string | undefined,
      client: req.headers["x-summer-client"] as string | undefined,
    });
    if (authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_token" }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const server = build(authorization);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  return { http, seen, requestHeaders };
}

let hosted: ReturnType<typeof hostedSummerEngine>;
let url = "";

let summerDir = "";

beforeEach(async () => {
  summerDir = await mkdtemp(join(tmpdir(), "summer-hosted-mount-test-"));
  setSummerDirForTests(summerDir);
  hosted = hostedSummerEngine();
  await new Promise<void>((done) => hosted.http.listen(0, "127.0.0.1", done));
  url = `http://127.0.0.1:${(hosted.http.address() as AddressInfo).port}/mcp`;
});

afterEach(async () => {
  hosted.http.closeAllConnections();
  await new Promise<void>((done) => hosted.http.close(() => done()));
  setSummerDirForTests(null);
  await rm(summerDir, { recursive: true, force: true });
});

async function localSession(deps: HostedMountDependencies) {
  const { server } = createMcpServer();
  const mount = prepareHostedMount(server, deps);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "agent", version: "1.0.0" });
  await client.connect(clientSide);
  return { server, client, mount };
}

const deps = (overrides: Partial<HostedMountDependencies> = {}): HostedMountDependencies => ({
  ...defaultHostedMountDependencies,
  url: () => url,
  token: async () => TOKEN,
  ...overrides,
});

describe("one Summer Engine MCP: hosted tools mounted locally", () => {
  it("mounts the hosted 3.x tools from the hosted 3.x surface, asked for by name", () => {
    expect(new URL(defaultHostedMountDependencies.url()).searchParams.get("surface")).toBe("v3");
  });

  it("call() says why nothing was sent: a refused sign-in keeps an OAuth code, a server that never answered is unreachable", async () => {
    const refused = await localSession(deps({ token: async () => "wrong-token" }));
    try {
      await expect(refused.mount.call("summer_store_list_games", {})).rejects.toMatchObject({ name: "OAuthError", code: "oauth_token_invalid" });
    } finally {
      await refused.client.close();
      await refused.server.close();
    }
    const down = await localSession(deps({ url: () => "http://127.0.0.1:1/mcp" }));
    try {
      await expect(down.mount.call("summer_store_list_games", {})).rejects.toBeInstanceOf(HostedUnreachableError);
    } finally {
      await down.client.close();
      await down.server.close();
    }
  });

  it("lists the hosted publishing tools with their own schema next to the engine tools", async () => {
    const { client, mount, server } = await localSession(deps());
    try {
      const state = await mount.mount();
      expect(state.status).toBe("mounted");
      expect(state.tools).toEqual(["summer_store_submit"]);
      expect(state.collisions).toEqual(["summer_generate_image"]);
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);
      expect(names).toContain("summer_get_project_context");
      const submit = tools.find((tool) => tool.name === "summer_store_submit")!;
      expect(submit.inputSchema.properties).toHaveProperty("gameId");
      expect(submit.inputSchema.required).toEqual(["gameId"]);
      // A hosted tuple leaves in the provider-safe form, like the local tools.
      expect(submit.inputSchema.properties!.focus).toEqual({ type: "array", minItems: 2, maxItems: 2, items: { type: "number" } });
      expect(submit.inputSchema.properties!.coverUrl).toEqual({ type: "string" });
      // The local generate tool stays local.
      expect(tools.find((tool) => tool.name === "summer_generate_image")!.description).not.toBe("HOSTED generate");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("forwards a call to the hosted server with the store sign-in", async () => {
    const { client, mount, server } = await localSession(deps());
    try {
      await mount.mount();
      const result = await client.callTool({ name: "summer_store_submit", arguments: { gameId: "g1", priceUsdCents: 499 } });
      expect(JSON.parse((result.content as Array<{ text: string }>)[0].text).status).toBe("awaiting_owner_approval");
      expect(hosted.seen).toEqual([{ tool: "summer_store_submit", args: { gameId: "g1", priceUsdCents: 499 }, authorization: `Bearer ${TOKEN}` }]);
      // The call names its tool and the agent app (the local client is "agent").
      expect(hosted.requestHeaders).toContainEqual({ tool: "summer_store_submit", host: "other.agent", client: "summer-cli" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("mounts the hosted skills as prompts and resources", async () => {
    const { client, mount, server } = await localSession(deps());
    try {
      await mount.mount();
      expect((await client.listPrompts()).prompts.map((prompt) => prompt.name)).toContain("publish-your-game");
      const read = await client.readResource({ uri: "summer://skills/store-art" });
      expect((read.contents[0] as { text: string }).text).toBe("# Store art");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("without a store sign-in keeps the engine tools and says how to sign in", async () => {
    const { client, mount, server } = await localSession(
      deps({
        token: async () => {
          throw new OAuthError("store_login_required", "This machine is not signed in to the Summer store.", 'Recovery: run "summer login --store" in a terminal and approve access in the browser, then retry.');
        },
      })
    );
    try {
      const state = await mount.mount();
      expect(state.status).toBe("unavailable");
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("summer_get_project_context");
      expect(names).toContain(STORE_TOOLS_STATUS);
      expect(names).not.toContain("summer_store_submit");
      const result = await client.callTool({ name: STORE_TOOLS_STATUS, arguments: {} });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0].text).toContain("summer login --store");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("holds the first tools/list until the mount finishes, so hosts that list once see the store tools", async () => {
    const { server } = createMcpServer();
    const mount = prepareHostedMount(server, deps());
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "agent", version: "1.0.0" });
    await client.connect(clientSide);
    try {
      void mount.mount();
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("summer_store_submit");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("holds a call to a hosted tool that arrives before any tools/list until the mount finishes", async () => {
    const { server } = createMcpServer();
    const slowConnect: HostedMountDependencies["connect"] = (...args) =>
      new Promise((done) => setTimeout(done, 200)).then(() => defaultHostedMountDependencies.connect(...args));
    const mount = prepareHostedMount(server, deps({ connect: slowConnect }));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "agent", version: "1.0.0" });
    await client.connect(clientSide);
    try {
      void mount.mount();
      const result = await client.callTool({ name: "summer_store_submit", arguments: { gameId: "g1" } });
      expect(result.isError).not.toBe(true);
      expect(hosted.seen.map((entry) => entry.tool)).toEqual(["summer_store_submit"]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("answers the first tools/list after the wait cap when the mount is slow", async () => {
    const { server } = createMcpServer();
    const mount = prepareHostedMount(
      server,
      deps({ connect: () => new Promise(() => undefined) }),
      { firstListWaitMs: 50 }
    );
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "agent", version: "1.0.0" });
    await client.connect(clientSide);
    try {
      void mount.mount();
      const started = Date.now();
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(names).toContain("summer_get_project_context");
      expect(names).not.toContain("summer_store_submit");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("mounts only the hosted tools the profile includes", async () => {
    const assets = resolveToolSelection({ profile: "assets" }, {});
    const { server } = createMcpServer(assets);
    const mount = prepareHostedMount(server, deps(), { includeTool: (name) => selectionIncludes(assets, name, false) });
    const state = await mount.mount();
    expect(state.status).toBe("mounted");
    // summer_store_submit is a store tool; the assets profile has no store.
    expect(state.tools).toEqual([]);
    await server.close();

    const engine = resolveToolSelection({ profile: "engine" }, {});
    const second = createMcpServer(engine);
    const engineMount = prepareHostedMount(second.server, deps(), { includeTool: (name) => selectionIncludes(engine, name, false) });
    expect((await engineMount.mount()).tools).toEqual(["summer_store_submit"]);
    await second.server.close();
  });

  it("stops mounting at the tool limit and logs what it left out", async () => {
    const { server, getRegisteredToolCount } = createMcpServer();
    const mount = prepareHostedMount(server, deps(), { maxTools: getRegisteredToolCount() });
    const state = await mount.mount();
    expect(state.tools).toEqual([]);
    expect(state.overLimit).toEqual(["summer_store_submit"]);
    await server.close();
  });

  it("counts only the tools a client lists against the limit (v4 keeps 3.x tools registered, unlisted)", async () => {
    const { server } = createMcpServer(resolveToolSelection({ profile: "full" }, {}), { surface: "v4" });
    const registered = Object.values((server as unknown as { _registeredTools: Record<string, { enabled: boolean }> })._registeredTools);
    const listed = registered.filter((tool) => tool.enabled).length;
    expect(registered.length).toBeGreaterThan(listed);
    const mount = prepareHostedMount(server, deps(), { maxTools: listed + 1 });
    expect((await mount.mount()).tools).toEqual(["summer_store_submit"]);
    await server.close();
  });

  it("gives mounted tools the description a surface asks for and says when it mounted", async () => {
    const { server } = createMcpServer();
    let mounted = 0;
    const mount = prepareHostedMount(server, deps(), { describe: (tool) => `3.x name; ${tool.name}`, onMounted: () => (mounted += 1) });
    await mount.mount();
    expect((server as unknown as { _registeredTools: Record<string, { description?: string }> })._registeredTools.summer_store_submit.description).toBe("3.x name; summer_store_submit");
    expect(mounted).toBe(1);
    await server.close();
  });
});
