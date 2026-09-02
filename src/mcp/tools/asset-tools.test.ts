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

  it("registers summer_import_hdri with query/assetId/resolution inputs", () => {
    const { server, tools } = createFakeServer();
    registerAssetTools(server as any);

    const tool = getTool(tools, "summer_import_hdri");
    expect(tool.schema.query).toBeDefined();
    expect(tool.schema.assetId).toBeDefined();
    expect(tool.schema.resolution).toBeDefined();
    expect(tool.description).toContain("CC0");
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

  function polyHavenFetchMock(overrides?: {
    catalog?: Record<string, unknown>;
    files?: Record<string, unknown>;
  }) {
    const catalog = overrides?.catalog ?? {
      kloppenheim_02: {
        name: "Kloppenheim 02",
        tags: ["sky", "clouds", "field"],
        categories: ["outdoor", "sunset"],
      },
      studio_small_08: {
        name: "Studio Small 08",
        tags: ["studio", "artificial light"],
        categories: ["indoor", "studio"],
      },
    };
    const files = overrides?.files ?? {
      hdri: {
        "1k": { hdr: { url: "https://dl.polyhaven.org/hdris/kloppenheim_02_1k.hdr", size: 1 } },
        "2k": { hdr: { url: "https://dl.polyhaven.org/hdris/kloppenheim_02_2k.hdr", size: 2 } },
        "4k": { hdr: { url: "https://dl.polyhaven.org/hdris/kloppenheim_02_4k.hdr", size: 4 } },
      },
    };
    return vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).includes("/assets") ? catalog : files),
    }));
  }

  it("imports a Poly Haven HDRI by search query, directly and unauthenticated", async () => {
    const fetchMock = polyHavenFetchMock();
    globalThis.fetch = fetchMock as any;
    executeOpsMock.mockResolvedValue({ results: [{ ok: true }] });

    const { server, tools } = createFakeServer();
    registerAssetTools(server as any);

    const result = await getTool(tools, "summer_import_hdri").handler({
      query: "sunset field",
      resolution: "2k",
    });

    const [assetsUrl, assetsInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(assetsUrl).toBe("https://api.polyhaven.com/assets?type=hdris");
    expect((assetsInit.headers as any)["User-Agent"]).toBe("summer-engine-cli");
    expect((assetsInit.headers as any).Authorization).toBeUndefined();

    const [filesUrl] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(filesUrl).toBe("https://api.polyhaven.com/files/kloppenheim_02");

    expect(executeOpsMock).toHaveBeenCalledWith([
      {
        op: "ImportFromUrl",
        url: "https://dl.polyhaven.org/hdris/kloppenheim_02_2k.hdr",
        path: "res://sky/kloppenheim_02_2k.hdr",
      },
    ]);

    const parsed = parseResult(result);
    expect(parsed).toMatchObject({
      success: true,
      assetId: "kloppenheim_02",
      resolution: "2k",
      importedTo: "res://sky/kloppenheim_02_2k.hdr",
    });
    expect(parsed.license).toContain("CC0");
    expect(parsed.applyScript).toContain("WorldEnvironment");
    expect(parsed.applyScript).not.toContain("ensure_environment");
    expect(parsed.applyScript).toContain("PanoramaSkyMaterial");
    expect(parsed.applyScript).toContain("res://sky/kloppenheim_02_2k.hdr");
  });

  it("imports by exact assetId and falls back to a lower available resolution", async () => {
    const fetchMock = polyHavenFetchMock({
      files: {
        hdri: {
          "1k": { hdr: { url: "https://dl.polyhaven.org/hdris/night_city_1k.hdr" } },
          "2k": { exr: { url: "https://dl.polyhaven.org/hdris/night_city_2k.exr" } },
        },
      },
    });
    globalThis.fetch = fetchMock as any;
    executeOpsMock.mockResolvedValue({ results: [{ ok: true }] });

    const { server, tools } = createFakeServer();
    registerAssetTools(server as any);

    const result = await getTool(tools, "summer_import_hdri").handler({
      assetId: "night_city",
      resolution: "4k",
    });

    // No catalog fetch on the exact-id path.
    const [firstUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(firstUrl).toBe("https://api.polyhaven.com/files/night_city");

    const parsed = parseResult(result);
    expect(parsed).toMatchObject({
      success: true,
      assetId: "night_city",
      resolution: "2k",
      format: "exr",
      importedTo: "res://sky/night_city_2k.exr",
    });
    expect(parsed.resolutionNote).toContain("4k");
  });

  it("rejects a call with neither query nor assetId", async () => {
    const { server, tools } = createFakeServer();
    registerAssetTools(server as any);

    const result = await getTool(tools, "summer_import_hdri").handler({
      resolution: "2k",
    });

    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toBe("bad_args");
    expect(executeOpsMock).not.toHaveBeenCalled();
  });

  it("treats API responses as data: unsafe ids and foreign download hosts never reach the engine", async () => {
    const { server, tools } = createFakeServer();
    registerAssetTools(server as any);
    const tool = getTool(tools, "summer_import_hdri");

    // An assetId that could break out of the URL/res:// path is refused up front.
    const badId = await tool.handler({ assetId: "../etc/passwd", resolution: "2k" });
    expect(badId.isError).toBe(true);
    expect(parseResult(badId).error).toBe("bad_args");

    // A files response pointing at a non-Poly-Haven host is ignored.
    globalThis.fetch = polyHavenFetchMock({
      files: {
        hdri: { "2k": { hdr: { url: "https://evil.example/payload.hdr" } } },
      },
    }) as any;
    const badHost = await tool.handler({ assetId: "kloppenheim_02", resolution: "2k" });
    expect(badHost.isError).toBe(true);
    expect(parseResult(badHost).error).toBe("no_hdri_file");
    expect(executeOpsMock).not.toHaveBeenCalled();
  });
});
