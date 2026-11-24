import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setSummerDirForTests } from "../../core/store.js";
import { registerApiTools } from "./api-tools.js";

const capabilities = ["image", "3d", "video", "voice", "dialogue", "sound", "music", "motion"];
const requests: string[] = [];
const http = createServer((request, response) => {
  const path = request.url!;
  requests.push(path);
  expect(request.method).toBe("GET");
  expect(request.headers.authorization).toBeUndefined();
  const capability = new URL(path, "http://localhost").searchParams.get("capability");
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ currency: "USD", models: [{ id: `${capability}/example`, capability }] }));
});
const server = new McpServer({ name: "api-model-capabilities", version: "1" });
const client = new Client({ name: "api-model-capabilities-test", version: "1" });
let root = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-api-model-capabilities-"));
  setSummerDirForTests(root);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("SUMMER_GATEWAY_URL", `http://127.0.0.1:${(http.address() as AddressInfo).port}`);
  registerApiTools(server);
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right);
  await client.connect(left);
});

afterAll(async () => {
  await client.close();
  await server.close();
  await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
  vi.unstubAllEnvs();
  setSummerDirForTests(null);
  await rm(root, { recursive: true, force: true });
});

describe("Summer API model capability filters", () => {
  it("advertises all public asset capabilities through the SDK registration", async () => {
    const tool = (await client.listTools()).tools.find((entry) => entry.name === "summer_api_models");
    expect(tool?.inputSchema.properties?.capability).toMatchObject({ enum: capabilities });
  });

  it.each(capabilities)("forwards %s to the public HTTP model list without sign-in", async (capability) => {
    const before = requests.length;
    const result = await client.callTool({ name: "summer_api_models", arguments: { capability } });
    expect(result.isError).not.toBe(true);
    const text = result.content as Array<{ type: string; text?: string }>;
    expect(JSON.parse(text.find((part) => part.type === "text")!.text!)).toMatchObject({
      models: [{ capability }],
    });
    expect(requests.slice(before)).toEqual([`/v1/models?capability=${capability}`]);
  });

  it("keeps unknown capabilities out of the HTTP caller", async () => {
    const before = requests.length;
    const result = await client.callTool({ name: "summer_api_models", arguments: { capability: "time-travel" } });
    expect(result.isError).toBe(true);
    expect(requests.length).toBe(before);
  });
});
