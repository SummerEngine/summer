import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const executeOpsMock = vi.hoisted(() => vi.fn());
const characterClientMocks = vi.hoisted(() => ({
  readProjectTextFile: vi.fn(),
  listProjectFiles: vi.fn(),
  importProjectFiles: vi.fn(),
  renameProjectFile: vi.fn(),
  deleteProjectFile: vi.fn(),
  writeProjectTextFile: vi.fn(),
  instantiateProjectScene: vi.fn(),
}));

vi.mock("../../lib/auth.js", () => ({
  getAuthToken: vi.fn(async () => "test-token"),
}));

vi.mock("../server.js", () => ({
  getClient: vi.fn(async () => ({
    executeOps: executeOpsMock,
    ...characterClientMocks,
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
  for (const mock of Object.values(characterClientMocks)) mock.mockReset();
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

    const { server, tools } = createFakeServer();
    registerAssetTools(server as any);

    const result = await getTool(tools, "summer_import_asset_by_id").handler({
      assetId: "asset-1",
      parent: "./World/Props",
      name: "HeroSword",
    });

    expect(executeOpsMock).toHaveBeenCalledWith([
      {
        op: "ImportFromUrl",
        url: "https://cdn.example/iron_sword.glb",
        path: "res://assets/models/iron_sword.glb",
      },
    ]);
    expect(executeOpsMock).toHaveBeenCalledWith([
      {
        op: "InstantiateScene",
        parent: "./World/Props",
        scene: "res://assets/models/iron_sword.glb",
        name: "HeroSword",
      },
    ]);

    expect(parseResult(result)).toMatchObject({
      success: true,
      assetId: "asset-1",
      importedTo: "res://assets/models/iron_sword.glb",
      addedToScene: true,
    });
  });

  it("imports a complete character package by exact id and instantiates its wrapper", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        asset: readyCharacterAsset(),
      }),
    }));
    globalThis.fetch = fetchMock as any;
    characterClientMocks.readProjectTextFile.mockRejectedValue(
      new Error("not found")
    );
    characterClientMocks.listProjectFiles.mockResolvedValue({
      ok: true,
      exists: false,
      files: [],
    });
    characterClientMocks.importProjectFiles.mockImplementation(
      async (imports: Array<{ path: string }>) => ({
        results: [
          {
            ok: true,
            op: "ImportFromUrlBatch",
            meta: {
              paths: imports.map(({ path }) => path),
              imported: imports.map(() => true),
              collisions: imports.map(() => false),
              failed: [],
            },
          },
        ],
      })
    );
    characterClientMocks.renameProjectFile.mockResolvedValue({
      results: [{ ok: true, op: "RenameFile" }],
    });
    characterClientMocks.writeProjectTextFile.mockResolvedValue({
      results: [{ ok: true, op: "WriteFile" }],
    });
    characterClientMocks.instantiateProjectScene.mockResolvedValue({
      results: [{ ok: true, op: "InstantiateScene" }],
    });

    const { server, tools } = createFakeServer();
    registerAssetTools(server as any);
    const result = await getTool(tools, "summer_import_asset_by_id").handler({
      assetId: "character-1",
      parent: "./World/Actors",
      name: "Player",
    });
    const parsed = parseResult(result);

    expect(characterClientMocks.importProjectFiles).toHaveBeenCalledTimes(1);
    expect(executeOpsMock).not.toHaveBeenCalled();
    expect(characterClientMocks.instantiateProjectScene).toHaveBeenCalledWith(
      "./World/Actors",
      "res://characters/hero_character_1/character.tscn",
      "Player"
    );
    expect(parsed).toMatchObject({
      success: true,
      assetId: "character-1",
      primaryPath: "res://characters/hero_character_1/character.tscn",
      manifestPath: "res://characters/hero_character_1/character.json",
      packageRevision: "character-r2",
      importedTo: "res://characters/hero_character_1/character.tscn",
      addedToScene: true,
    });
  });

  it("resolves a search result by exact id before importing its character package", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("/api/mcp/assets?")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            assets: [
              {
                id: "character-1",
                title: "Hero",
                type: "3d_model",
                fileUrl: "https://assets.example.test/source.glb",
              },
            ],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ asset: readyCharacterAsset() }),
      };
    });
    globalThis.fetch = fetchMock as any;
    characterClientMocks.readProjectTextFile.mockRejectedValue(
      new Error("not found")
    );
    characterClientMocks.listProjectFiles.mockResolvedValue({
      ok: true,
      exists: false,
      files: [],
    });
    characterClientMocks.importProjectFiles.mockImplementation(
      async (imports: Array<{ path: string }>) => ({
        results: [
          {
            ok: true,
            op: "ImportFromUrlBatch",
            meta: {
              paths: imports.map(({ path }) => path),
              imported: imports.map(() => true),
              collisions: imports.map(() => false),
              failed: [],
            },
          },
        ],
      })
    );
    characterClientMocks.renameProjectFile.mockResolvedValue({
      results: [{ ok: true, op: "RenameFile" }],
    });
    characterClientMocks.writeProjectTextFile.mockResolvedValue({
      results: [{ ok: true, op: "WriteFile" }],
    });

    const { server, tools } = createFakeServer();
    registerAssetTools(server as any);
    const result = await getTool(tools, "summer_import_asset").handler({
      query: "hero",
      assetType: "3d_model",
      source: "my_assets",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toMatch(
      /\/api\/mcp\/assets\/character-1$/
    );
    expect(parseResult(result)).toMatchObject({
      success: true,
      importedTo: "res://characters/hero_character_1/character.tscn",
    });
    expect(characterClientMocks.importProjectFiles).toHaveBeenCalledTimes(1);
    expect(executeOpsMock).not.toHaveBeenCalled();
  });
});

function readyCharacterAsset() {
  return {
    id: "character-1",
    title: "Hero",
    type: "3d_model",
    fileUrl: "https://assets.example.test/source.glb",
    metadata: {
      characterPackage: {
        version: 2,
        status: "ready",
        packageRevision: "character-r2",
        directoryName: "hero_character_1",
        rig: {
          assetId: "character-1",
          fileUrl: "https://assets.example.test/runtime.glb",
          artifactFingerprint: "sha256:rig",
          path: "rig.glb",
        },
        animations: [
          {
            assetId: "character-1",
            actionId: 0,
            name: "Idle",
            semanticRole: "idle",
            fileUrl: "https://assets.example.test/runtime.glb",
            artifactFingerprint: "sha256:rig",
            path: "rig.glb",
          },
          {
            assetId: "animation-13",
            actionId: 13,
            name: "Jump",
            semanticRole: "jump",
            fileUrl: "https://assets.example.test/jump.glb",
            artifactFingerprint: "sha256:jump",
            path: "animations/jump.glb",
          },
        ],
      },
    },
  };
}
