import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock auth so handlers don't need a real token on disk.
vi.mock("../../lib/auth.js", () => ({
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
    expect(motion.description).toContain("hunyuan-custom");
    expect(motion.description).toContain("rigAssetId");

    // Schema fields exist
    expect(motion.schema.rigAssetId).toBeDefined();
    expect(motion.schema.backend).toBeDefined();
    expect(motion.schema.motionName).toBeDefined();
    expect(motion.schema.prompt).toBeDefined();
    expect(motion.schema.durationSeconds).toBeDefined();
    expect(motion.schema.wait).toBeDefined();
    expect(motion.schema.options).toBeDefined();
  });

  it("rejects meshy-library without motionName client-side (no fetch call)", async () => {
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
    expect(body.message).toMatch(/meshy-library backend requires motionName/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("rejects hunyuan-custom without prompt client-side (no fetch call)", async () => {
    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);
    const motion = getTool(tools, "summer_generate_motion");

    const result = await motion.handler({
      rigAssetId: "rig_123",
      backend: "hunyuan-custom",
      wait: false,
    });

    expect(result.isError).toBe(true);
    const body = parseResult(result);
    expect(body.message).toMatch(/hunyuan-custom backend requires a prompt/);
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
      durationSeconds: 4,
      wait: false, // skip polling so the test stays focused on the request
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/mcp\/generate\/motion$/);
    expect(init.method).toBe("POST");
    expect((init.headers as any).Authorization).toBe("Bearer test-token");

    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({
      rigAssetId: "rig_123",
      backend: "meshy-library",
      motionName: "walk",
      durationSeconds: 4,
    });

    // wait=false → handler returns the raw response (containing jobId).
    const body = parseResult(result);
    expect(body.jobId).toBe("job_abc");
    expect(result.isError).toBeUndefined();
  });

  it("calls /api/mcp/generate/motion with the correct body shape (hunyuan-custom)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ jobId: "job_xyz" }),
    }));
    globalThis.fetch = fetchMock as any;

    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);
    const motion = getTool(tools, "summer_generate_motion");

    await motion.handler({
      rigAssetId: "rig_456",
      backend: "hunyuan-custom",
      prompt: "drops to one knee, draws bow",
      durationSeconds: 6,
      wait: false,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({
      rigAssetId: "rig_456",
      backend: "hunyuan-custom",
      prompt: "drops to one knee, draws bow",
      durationSeconds: 6,
    });
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
  it("documents the optional rig pass via options.rig", () => {
    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);

    const gen3d = getTool(tools, "summer_generate_3d");
    expect(gen3d.description).toMatch(/options\.rig/);
    expect(gen3d.description).toMatch(/rigAssetId/);
    expect(gen3d.description).toMatch(/summer_generate_motion/);
  });
});
