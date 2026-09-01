import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const executeOpsMock = vi.hoisted(() => vi.fn());
const executeIdentityBoundOpsMock = vi.hoisted(() => vi.fn());

vi.mock("../../core/auth.js", () => ({
  getAuthToken: vi.fn(async () => "test-token"),
}));

vi.mock("../server.js", () => ({
  getClient: vi.fn(async () => ({
    executeOps: executeOpsMock,
    executeIdentityBoundOps: executeIdentityBoundOpsMock,
  })),
}));

import { registerAssetTools } from "./asset-tools.js";

type Registered = {
  name: string;
  description: string;
  schema: Record<string, any>;
  handler: (args: any) => Promise<any>;
};

function createFakeServer() {
  const tools: Registered[] = [];
  const server = {
    tool(
      name: string,
      description: string,
      schema: Record<string, any>,
      handler: (args: any) => Promise<any>
    ) {
      tools.push({ name, description, schema, handler });
      return { name };
    },
  };
  return { server, tools };
}

function getTool(tools: Registered[], name: string): Registered {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return tool;
}

function parseResult(result: any) {
  const text = result?.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn() as any;
  executeOpsMock.mockReset();
  executeIdentityBoundOpsMock.mockReset();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("registerAssetTools", () => {
  it("registers the exact-ID asset tools", () => {
    const { server, tools } = createFakeServer();
    registerAssetTools(server as any);

    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "summer_search_assets",
        "summer_list_my_assets",
        "summer_get_asset",
        "summer_get_asset_download_url",
        "summer_import_asset",
        "summer_import_asset_by_id",
      ])
    );

    expect(getTool(tools, "summer_import_asset_by_id").schema.assetId).toBeDefined();
    expect(getTool(tools, "summer_import_asset").schema.source).toBeDefined();
  });

  it("lists my assets through the MCP search endpoint", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        assets: [{ id: "asset-1", title: "Knight", type: "3d_model" }],
        count: 1,
      }),
    }));
    globalThis.fetch = fetchMock as any;

    const { server, tools } = createFakeServer();
    registerAssetTools(server as any);

    const result = await getTool(tools, "summer_list_my_assets").handler({
      query: "",
      assetType: "all",
      limit: 10,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/mcp/assets?");
    expect(url).toContain("source=my_assets");
    expect((init.headers as any).Authorization).toBe("Bearer test-token");
    expect(parseResult(result).assets[0].id).toBe("asset-1");
  });

  it("fetches one asset by exact id", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        asset: {
          id: "asset-1",
          title: "Knight",
          type: "3d_model",
          fileUrl: "https://cdn.example/knight.glb",
        },
      }),
    }));
    globalThis.fetch = fetchMock as any;

    const { server, tools } = createFakeServer();
    registerAssetTools(server as any);

    const result = await getTool(tools, "summer_get_asset").handler({
      assetId: "asset-1",
    });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/mcp\/assets\/asset-1$/);
    expect(parseResult(result).asset.title).toBe("Knight");
  });

  it("imports a generated asset by id and instantiates 3D models", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        asset: {
          id: "asset-1",
          title: "Iron Sword",
          type: "3d_model",
          fileUrl: "https://cdn.example/iron_sword.glb",
        },
      }),
    }));
    globalThis.fetch = fetchMock as any;
    executeOpsMock.mockResolvedValue({ results: [{ ok: true }] });
    executeIdentityBoundOpsMock.mockResolvedValue({ results: [{ ok: true }, { ok: true }] });

    const { server, tools } = createFakeServer();
    registerAssetTools(server as any);

    const result = await getTool(tools, "summer_import_asset_by_id").handler({
      assetId: "asset-1",
      parent: "./World/Props",
      scenePath: "res://main.tscn",
      name: "HeroSword",
    });

    expect(executeOpsMock).toHaveBeenCalledWith([
      {
        op: "ImportFromUrl",
        url: "https://cdn.example/iron_sword.glb",
        path: "res://assets/models/iron_sword.glb",
      },
    ]);
    expect(executeIdentityBoundOpsMock).toHaveBeenCalledWith(
      [
        {
          op: "InstantiateScene",
          parent: "./World/Props",
          scene: "res://assets/models/iron_sword.glb",
          name: "HeroSword",
        },
        { op: "SaveScene" },
      ],
      { scenePath: "res://main.tscn" },
    );

    expect(parseResult(result)).toMatchObject({
      success: true,
      assetId: "asset-1",
      importedTo: "res://assets/models/iron_sword.glb",
      addedToScene: true,
    });
  });
});
