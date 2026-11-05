import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { setSummerDirForTests } from "../../core/store.js";
import { registerCreatorTools } from "./creator-tools.js";

type Registered = {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (args: any) => Promise<any>;
};

function createFakeServer() {
  const tools: Registered[] = [];
  return {
    tools,
    server: {
      tool(
        name: string,
        description: string,
        schema: Record<string, unknown>,
        handler: (args: any) => Promise<any>
      ) {
        tools.push({ name, description, schema, handler });
        return { name };
      },
    },
  };
}

function getTool(tools: Registered[], name: string): Registered {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return tool;
}

function parseResult(result: any) {
  return JSON.parse(result.content[0].text);
}

let root = "";
const GAME_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-creator-tools-test-"));
  setSummerDirForTests(join(root, ".summer"));
});

afterEach(async () => {
  setSummerDirForTests(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("registerCreatorTools", () => {
  it("validates the sandbox choice on the MCP schema", () => {
    const { server, tools } = createFakeServer();
    registerCreatorTools(server as any);
    const schema = z.object(getTool(tools, "summer_publish_build").schema as z.ZodRawShape);
    expect(schema.parse({ clientVersion: "v1.0.0" }).sandbox).toBe(true);
    expect(schema.parse({ clientVersion: "v1.0.0", sandbox: false }).sandbox).toBe(false);
    expect(schema.safeParse({ clientVersion: "v1.0.0", sandbox: "false" }).success).toBe(false);
  });

  it("returns structured failures from summer_publish_build", async () => {
    const { server, tools } = createFakeServer();
    registerCreatorTools(server as any);
    const result = await getTool(tools, "summer_publish_build").handler({
      gameId: GAME_ID,
      clientVersion: "v1.0.0",
      publish: false,
      confirm: false,
    });
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatchObject({
      ok: false,
      code: "export_required",
      recovery: expect.stringContaining("summer_export_game"),
    });
  });

  it("publishes only to summer.games: the Summercraft creator tools are gone", () => {
    const { server, tools } = createFakeServer();
    registerCreatorTools(server as any);
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("summer_publish_build");
    expect(names.filter((name) => name.startsWith("summer_creator_"))).toEqual([]);
  });
});
