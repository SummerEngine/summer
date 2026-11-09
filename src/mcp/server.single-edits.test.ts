import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

// A connected engine that applies every op: each client method answers ok.
vi.mock("../core/api-client.js", () => {
  const engine = new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === "then") return undefined;
        if (key === "credentialsChanged") return async () => false;
        return async () => ({ ok: true, results: [{ ok: true }] });
      },
    }
  );
  return { EngineApiClient: { connect: vi.fn(async () => engine) } };
});
vi.mock("../core/telemetry.js", () => ({ recordMcpSession: vi.fn(), recordLocalToolCall: vi.fn() }));

import { createMcpServer } from "./server.js";

const texts = (result: unknown) => (result as { content: Array<{ type: string; text?: string }> }).content.map((part) => part.text ?? "");

describe("single scene edits through the MCP server", () => {
  it("points at summer_run_script on the 4th single edit in a row", async () => {
    const { server } = createMcpServer();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "agent", version: "1.0.0" });
    await client.connect(clientSide);
    try {
      const edit = (value: number) =>
        client.callTool({ name: "summer_set_prop", arguments: { scenePath: "res://main.tscn", path: "Player", key: "speed", value } });
      for (let i = 1; i <= 3; i++) {
        const result = await edit(i);
        expect(result.isError).toBeFalsy();
        expect(texts(result).join("\n")).not.toMatch(/summer_run_script/);
      }
      const fourth = texts(await edit(4));
      expect(fourth.at(-1)).toMatch(/^Tip: 4 single scene edits in a row\. .*summer_run_script/);
      // The engine's answer is still the first block, as compact JSON.
      expect(fourth[0]).not.toContain("\n");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
