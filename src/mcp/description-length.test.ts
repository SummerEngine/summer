import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMcpServer } from "./server.js";

/**
 * Claude Code cuts every MCP tool description longer than 4096 characters and
 * drops the tail without telling the model ('Tool "summer_batch" description
 * truncated from 5028 to 4096 chars'). This walks the real tools/list output,
 * the surface a host reads, so a description that outgrows the limit fails
 * here instead of silently losing its last sections for Claude Code users.
 */
const CLAUDE_CODE_DESCRIPTION_LIMIT = 4096;

describe("tools/list descriptions fit Claude Code's description limit", () => {
  let client: Client;
  let tools: Tool[];
  let registered: number;

  beforeAll(async () => {
    const { server, getRegisteredToolCount } = createMcpServer();
    registered = getRegisteredToolCount();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    client = new Client({ name: "description-length-guard", version: "1.0.0" });
    await client.connect(clientSide);
    ({ tools } = await client.listTools());
  });

  afterAll(async () => {
    await client.close();
  });

  it("lists every registered tool", () => {
    expect(tools.length).toBe(registered);
  });

  it(`no tool description is longer than ${CLAUDE_CODE_DESCRIPTION_LIMIT} characters`, () => {
    const over = tools
      .filter((tool) => (tool.description ?? "").length > CLAUDE_CODE_DESCRIPTION_LIMIT)
      .map((tool) => `${tool.name} ${tool.description!.length}`);
    expect(over).toEqual([]);
  });
});
