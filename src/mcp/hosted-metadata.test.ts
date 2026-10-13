import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Resource, Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { HostedClient, HostedConnectDependencies } from "../core/hosted-mcp.js";
import { prepareHostedMount } from "./hosted-mount.js";
import { createMcpServer } from "./server.js";

const URI = "ui://summer/game-v1.html";
const oauth = [{ type: "oauth2", scopes: ["openid", "email"] }];

function remote(tools: Tool[], resources: Resource[] = []): HostedClient {
  return {
    listTools: async () => ({ tools }),
    callTool: async () => ({ content: [{ type: "text", text: "game result" }], structuredContent: { board: "ready" } }),
    listPrompts: async () => ({ prompts: [] }),
    getPrompt: async () => ({}),
    listResources: async () => ({ resources }),
    readResource: async ({ uri }) => ({ contents: [{ uri, mimeType: "text/html;profile=mcp-app", text: "<html>Game</html>", _meta: { ui: { csp: { frameDomains: ["https://www.summerengine.com"] } } } }] }),
  };
}

async function mounted(server: McpServer, hosted: HostedClient) {
  const deps: HostedConnectDependencies = { url: () => "https://mcp.example.test/mcp", token: async () => "stored-token", connect: async () => hosted };
  const mount = prepareHostedMount(server, deps);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "metadata-test-host", version: "1.0.0" });
  await client.connect(clientSide);
  await mount.mount();
  return { client, server, mount };
}

describe("hosted metadata through the local MCP SDK", () => {
  it("keeps a mounted game panel, visibility, output schema, resource metadata and structured result", async () => {
    const tools: Tool[] = [
      {
        name: "summer_game", title: "Summer game", description: "Read the game board", inputSchema: { type: "object" },
        outputSchema: { type: "object", properties: { board: { type: "string" } }, required: ["board"] },
        annotations: { readOnlyHint: true },
        _meta: { ui: { resourceUri: URI, visibility: ["model", "app"] }, "openai/outputTemplate": URI, opaque: { flag: 1 }, securitySchemes: oauth },
      },
      {
        name: "summer_make_game", inputSchema: { type: "object" },
        _meta: { ui: { resourceUri: URI, visibility: ["model"] }, securitySchemes: oauth },
      },
    ];
    const resources: Resource[] = [{
      uri: URI, name: "summer-game-panel", title: "Game panel", mimeType: "text/html;profile=mcp-app", size: 17,
      annotations: { audience: ["user"], priority: 0.8 }, icons: [{ src: "https://www.summerengine.com/icon.png" }],
      _meta: { ui: { csp: { resourceDomains: ["https://assets.summerengine.com"] } }, opaque: "resource" },
    }];
    const { client, server } = await mounted(createMcpServer().server, remote(tools, resources));
    try {
      const listed = (await client.listTools()).tools;
      const game = listed.find((tool) => tool.name === "summer_game")!;
      expect(game.title).toBe("Summer game");
      expect(game.outputSchema).toEqual(tools[0].outputSchema);
      expect(game.annotations).toEqual({ readOnlyHint: true });
      expect(game._meta).toMatchObject({ ui: { resourceUri: URI, visibility: ["model", "app"] }, "openai/outputTemplate": URI, opaque: { flag: 1 } });
      expect(game._meta?.securitySchemes).toBeUndefined();
      expect(listed.find((tool) => tool.name === "summer_make_game")?._meta).toMatchObject({ ui: { visibility: ["model"] } });
      expect(listed.find((tool) => tool.name === "summer_make_game")?._meta?.securitySchemes).toBeUndefined();
      expect(listed.find((tool) => tool.name === "summer_generate_image")?._meta?.ui).toEqual({ visibility: ["model"] });

      const listedResource = (await client.listResources()).resources.find((resource) => resource.uri === URI)!;
      expect(listedResource).toEqual(resources[0]);
      const read = await client.readResource({ uri: URI });
      expect(read.contents[0]).toMatchObject({ text: "<html>Game</html>", _meta: { ui: { csp: { frameDomains: ["https://www.summerengine.com"] } } } });
      expect(await client.callTool({ name: "summer_game", arguments: {} })).toMatchObject({ content: [{ type: "text", text: "game result" }], structuredContent: { board: "ready" } });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps real local sound-choice schemas and metadata separate from colliding hosted tools", async () => {
    const hosted = remote(["summer_generate_sfx_choices", "summer_get_choices"].map((name) => ({
      name, inputSchema: { type: "object", properties: { hostedOnly: { type: "string" } } },
      _meta: { ui: { resourceUri: "ui://summer/sound-choices-v1.html", visibility: ["model", "app"] }, securitySchemes: oauth },
    })));
    const { client, server, mount } = await mounted(createMcpServer().server, hosted);
    try {
      expect(mount.state.collisions).toEqual(expect.arrayContaining(["summer_generate_sfx_choices", "summer_get_choices"]));
      const listed = (await client.listTools()).tools;
      const generate = listed.find((tool) => tool.name === "summer_generate_sfx_choices")!;
      expect(generate.inputSchema.properties).toHaveProperty("open");
      expect(generate.inputSchema.properties).not.toHaveProperty("hostedOnly");
      expect(generate._meta).toEqual({ ui: { visibility: ["model"] } });
      expect(listed.find((tool) => tool.name === "summer_get_choices")?._meta).toEqual({ ui: { visibility: ["model"] } });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("preserves an explicitly app-visible local tool and its result on a hosted name collision", async () => {
    const server = new McpServer({ name: "local", version: "1.0.0" });
    server.registerTool("summer_get_choices", {
      inputSchema: { localId: z.string() },
      _meta: { ui: { resourceUri: "ui://local/choices.html", visibility: ["model", "app"] } },
    }, async () => ({ content: [{ type: "text", text: "local choice result" }] }));
    const { client, mount } = await mounted(server, remote([{
      name: "summer_get_choices", inputSchema: { type: "object", properties: { hostedId: { type: "string" } } },
      _meta: { ui: { resourceUri: "ui://hosted/choices.html", visibility: ["model"] } },
    }]));
    try {
      expect(mount.state.collisions).toContain("summer_get_choices");
      const choice = (await client.listTools()).tools.find((tool) => tool.name === "summer_get_choices")!;
      expect(choice.inputSchema.properties).toHaveProperty("localId");
      expect(choice.inputSchema.properties).not.toHaveProperty("hostedId");
      expect(choice._meta?.ui).toEqual({ resourceUri: "ui://local/choices.html", visibility: ["model", "app"] });
      expect((await client.callTool({ name: "summer_get_choices", arguments: { localId: "c1" } })).content).toEqual([{ type: "text", text: "local choice result" }]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
