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
import { setSummerDirForTests } from "../core/store.js";
import { createMcpServer } from "./server.js";
import { defaultHostedMountDependencies, prepareHostedMount, STORE_TOOLS_STATUS, type HostedMountDependencies } from "./hosted-mount.js";

const TOKEN = "store-oauth-token";

/** A stand-in for mcp.summerengine.com: stateless Streamable HTTP, bearer required. */
function hostedSummerEngine() {
  const seen: Array<{ tool: string; args: unknown; authorization: string | undefined }> = [];
  const build = (authorization: string | undefined) => {
    const server = new McpServer({ name: "summer-engine", version: "1.0.0" });
    server.registerTool(
      "summer_store_submit",
      { description: "Ask the owner to publish.", inputSchema: { gameId: z.string(), priceUsdCents: z.number().int().optional() } },
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
  const http: Server = createServer(async (req, res) => {
    const authorization = req.headers.authorization;
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
  return { http, seen };
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
});
