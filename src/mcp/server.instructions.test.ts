import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { SUMMER_MCP_INSTRUCTIONS, createMcpServer } from "./server.js";

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
});
