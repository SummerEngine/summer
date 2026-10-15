import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { SUMMER_MCP_ASSETS_INSTRUCTIONS, SUMMER_MCP_INSTRUCTIONS, createMcpServer } from "./server.js";
import { resolveToolSelection } from "./tool-surface.js";

describe("MCP server instructions (initialize response)", () => {
  it("is one tight paragraph naming the five first-turn habits", () => {
    expect(SUMMER_MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(600);
    expect(SUMMER_MCP_INSTRUCTIONS).not.toContain("\n");
    for (const tool of [
      "summer_get_project_context",
      "summer_search_library",
      "summer_read_library",
      "summer_get_diagnostics",
      "summer_get_console",
      "summer_library_feedback",
    ]) {
      expect(SUMMER_MCP_INSTRUCTIONS).toContain(tool);
    }
    expect(SUMMER_MCP_INSTRUCTIONS).toMatch(/black screenshot/i);
    expect(SUMMER_MCP_INSTRUCTIONS).toMatch(/recapture/i);
  });

  it("reaches a real client through the initialize handshake", async () => {
    const { server } = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "summer-instructions-test", version: "1.0.0" });
    await server.connect(serverTransport);
    try {
      await client.connect(clientTransport);
      expect(client.getInstructions()).toBe(SUMMER_MCP_INSTRUCTIONS);
      expect(client.getServerVersion()?.name).toBe("summer-engine");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("tells an agent to script a run of scene edits", () => {
    expect(SUMMER_MCP_INSTRUCTIONS).toMatch(/More than 3 scene edits: one summer_run_script/);
  });

  it("gives the assets profile instructions that name only tools it has", async () => {
    expect(SUMMER_MCP_ASSETS_INSTRUCTIONS.length).toBeLessThanOrEqual(600);
    const { server } = createMcpServer(resolveToolSelection({ profile: "assets" }, {}));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "summer-instructions-test", version: "1.0.0" });
    await server.connect(serverTransport);
    try {
      await client.connect(clientTransport);
      expect(client.getInstructions()).toBe(SUMMER_MCP_ASSETS_INSTRUCTIONS);
      const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
      const named = SUMMER_MCP_ASSETS_INSTRUCTIONS.match(/summer_[a-z0-9_]+/g) ?? [];
      expect(named.filter((name) => !names.has(name))).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
