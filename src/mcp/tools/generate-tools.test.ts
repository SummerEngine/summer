import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock auth so handlers don't need a real token on disk.
vi.mock("../../core/auth.js", () => ({
  getAuthToken: vi.fn(async () => "test-token"),
}));

import { registerGenerateTools } from "./generate-tools.js";

// ---------------------------------------------------------------------------
// Fake MCP server: records every server.tool() registration so we can inspect
// names, descriptions, schemas, and invoke handlers directly in tests.
// ---------------------------------------------------------------------------

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
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`Tool not registered: ${name}`);
  return t;
}

function parseResult(result: any) {
  // Handlers return { content: [{ type: "text", text: JSON.stringify(...) }], isError? }
  const text = result?.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;

beforeEach(() => {
  // Reset fetch before each test; individual tests assign their own mock.
  globalThis.fetch = vi.fn() as any;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerGenerateTools — summer_generate_motion", () => {
  it("registers the tool with the correct name and schema fields", () => {
    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);

    const motion = getTool(tools, "summer_generate_motion");
    expect(motion.name).toBe("summer_generate_motion");
    expect(motion.description).toContain("meshy-library");
    expect(motion.description).toContain("rigAssetId");
    // hunyuan-custom is intentionally NOT exposed yet — see header comment in
    // generate-tools.ts. Keep this assertion as a guard against accidental
    // re-enable without testing.
    expect(motion.description).not.toContain("hunyuan-custom");

    // Schema fields exist
    expect(motion.schema.rigAssetId).toBeDefined();
    expect(motion.schema.backend).toBeDefined();
    expect(motion.schema.motionName).toBeDefined();
    expect(motion.schema.wait).toBeDefined();
    expect(motion.schema.options).toBeDefined();
    // prompt + durationSeconds are reserved for hunyuan-custom — not exposed.
    expect(motion.schema.prompt).toBeUndefined();
    expect(motion.schema.durationSeconds).toBeUndefined();
  });

  it("rejects missing motionName client-side (no fetch call)", async () => {
    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);
    const motion = getTool(tools, "summer_generate_motion");

    const result = await motion.handler({
      rigAssetId: "rig_123",
      backend: "meshy-library",
      wait: false,
    });

    expect(result.isError).toBe(true);
    const body = parseResult(result);
    expect(body.message).toMatch(/motionName is required/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("calls /api/mcp/generate/motion with the correct body shape (meshy-library)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ jobId: "job_abc" }),
    }));
    globalThis.fetch = fetchMock as any;

    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);
    const motion = getTool(tools, "summer_generate_motion");

    const result = await motion.handler({
      rigAssetId: "rig_123",
      backend: "meshy-library",
      motionName: "walk",
      wait: false, // skip polling so the test stays focused on the request
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/mcp\/generate\/motion$/);
    expect(init.method).toBe("POST");
    expect((init.headers as any).Authorization).toBe("Bearer test-token");
    expect((init.headers as any)["X-Summer-Client"]).toBe("summer-cli");
    expect((init.headers as any)["X-Summer-Client-Surface"]).toBe("mcp");
    expect((init.headers as any)["X-Summer-MCP-Tool"]).toBe("summer_generate_motion");

    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({
      rigAssetId: "rig_123",
      backend: "meshy-library",
      motionName: "walk",
    });
    // durationSeconds + prompt are NOT exposed (hunyuan-custom not shipped).
    expect(sent.durationSeconds).toBeUndefined();
    expect(sent.prompt).toBeUndefined();

    // wait=false → handler returns the raw response (containing jobId).
    const body = parseResult(result);
    expect(body.jobId).toBe("job_abc");
    expect(result.isError).toBeUndefined();
  });

  it("surfaces 401 errors as isError with a clean message", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ message: "Auth token expired." }),
    }));
    globalThis.fetch = fetchMock as any;

    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);
    const motion = getTool(tools, "summer_generate_motion");

    const result = await motion.handler({
      rigAssetId: "rig_123",
      backend: "meshy-library",
      motionName: "walk",
      wait: false,
    });

    expect(result.isError).toBe(true);
    const body = parseResult(result);
    expect(body.error).toBe(true);
    // Server message is preserved (and the raw response is spread in too).
    expect(body.message).toMatch(/Auth token expired/);
  });

  it("surfaces 402 errors as isError with a clean message", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 402,
      json: async () => ({ message: "Insufficient credits." }),
    }));
    globalThis.fetch = fetchMock as any;

    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);
    const motion = getTool(tools, "summer_generate_motion");

    const result = await motion.handler({
      rigAssetId: "rig_123",
      backend: "meshy-library",
      motionName: "walk",
      wait: false,
    });

    expect(result.isError).toBe(true);
    const body = parseResult(result);
    expect(body.error).toBe(true);
    expect(body.message).toMatch(/Insufficient credits/);
  });
});

describe("registerGenerateTools — summer_generate_3d description", () => {
  it("documents the shared preparation and character package contract", () => {
    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);

    const gen3d = getTool(tools, "summer_generate_3d");
    expect(gen3d.description).toMatch(/options\.rig/);
    expect(gen3d.description).toMatch(/rigAssetId/);
    expect(gen3d.description).toMatch(/summer_generate_motion/);
    expect(gen3d.description).toMatch(/automatically assesses/);
    expect(gen3d.description).toMatch(/up to 10 min/);
    expect(gen3d.schema.referencePreparation).toBeDefined();
    expect(gen3d.schema.assetIntent).toBeDefined();
    expect(gen3d.schema.animationNames).toBeDefined();
    expect(gen3d.schema.actionIds).toBeDefined();
    expect(gen3d.schema.idempotencyKey).toBeDefined();
  });

  it("maps first-class character and preparation fields into the cloud route contract", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ jobId: "job_character_1" }),
    }));
    globalThis.fetch = fetchMock as any;

    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);
    const gen3d = getTool(tools, "summer_generate_3d");
    await gen3d.handler({
      kind: "image-to-3d",
      model: "hunyuan",
      imageUrl: "https://media.summerengine.com/hero.png",
      title: "Hero",
      idempotencyKey: "hero-v1",
      assetIntent: "character",
      referencePreparation: "auto",
      rig: true,
      animationNames: ["Idle", "Walk", "Run"],
      riggingHeightMeters: 1.8,
      wait: false,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      kind: "image-to-3d",
      imageUrl: "https://media.summerengine.com/hero.png",
      title: "Hero",
      idempotencyKey: "hero-v1",
      options: {
        assetIntent: "character",
        referencePreparation: "auto",
        rig: true,
        animationNames: ["Idle", "Walk", "Run"],
        riggingHeightMeters: 1.8,
      },
    });
  });
});

describe("registerGenerateTools — summer_get_studio_workflow", () => {
  it("lists Guided workflows and can request one exact recipe", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          workflow: {
            id: "character-pack",
            supportLevel: "partial",
            requiredTools: ["summer_generate_image"],
          },
        }),
    }));
    globalThis.fetch = fetchMock as any;

    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);
    const workflow = getTool(tools, "summer_get_studio_workflow");

    expect(workflow.description).toContain("Guided");
    expect(workflow.description).toContain("honest limitations");
    expect(workflow.schema.workflowId).toBeDefined();

    const result = await workflow.handler({ workflowId: "character-pack" });
    expect(parseResult(result).workflow.id).toBe("character-pack");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/mcp\/workflows\?id=character-pack$/);
    expect((init.headers as any)["X-Summer-MCP-Tool"]).toBe(
      "summer_get_studio_workflow"
    );
  });
});

describe("registerGenerateTools — summer_slice_asset_sheet", () => {
  it("registers a guided sheet slicer and calls the MCP route with the asset id", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          success: true,
          source: { width: 1024, height: 1024 },
          slices: [{ index: 0, name: "torii_gate", category: "buildings" }],
        }),
    }));
    globalThis.fetch = fetchMock as any;

    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);
    const slicer = getTool(tools, "summer_slice_asset_sheet");

    expect(slicer.description).toContain("asset sheet");
    expect(slicer.description).toContain("summer_generate_image");
    expect(slicer.schema.assetId).toBeDefined();

    const result = await slicer.handler({ assetId: "asset_japan_123" });

    expect(result.isError).toBeUndefined();
    expect(parseResult(result).slices[0].name).toBe("torii_gate");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/mcp\/generate\/slice-asset-sheet$/);
    expect((init.headers as any)["X-Summer-MCP-Tool"]).toBe(
      "summer_slice_asset_sheet"
    );
    expect(JSON.parse(init.body as string)).toEqual({
      assetId: "asset_japan_123",
    });
  });
});

describe("registerGenerateTools — provider validation errors", () => {
  it("formats FastAPI/FAL 422 detail arrays into a model-readable message", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 422,
      text: async () =>
        JSON.stringify({
          detail: [
            {
              loc: ["body", "input", "image_urls"],
              msg: "Field required",
              type: "missing",
            },
          ],
        }),
    }));
    globalThis.fetch = fetchMock as any;

    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);
    const image = getTool(tools, "summer_generate_image");

    const result = await image.handler({
      prompt: "turn this into a sprite",
      referenceImageUrl: "https://example.com/reference.png",
    });

    expect(result.isError).toBe(true);
    const body = parseResult(result);
    expect(body.status).toBe(422);
    expect(body.detail[0].loc).toEqual(["body", "input", "image_urls"]);
    expect(body.message).toBe(
      "Request validation failed (422): body.input.image_urls: Field required"
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as any)["X-Summer-MCP-Tool"]).toBe("summer_generate_image");
    expect((init.headers as any)["X-Summer-Client-Version"]).toMatch(/\d+\.\d+\.\d+/);
  });
});
