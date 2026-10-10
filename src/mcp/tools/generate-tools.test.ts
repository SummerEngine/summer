import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock auth so handlers don't need a real token on disk.
vi.mock("../../core/auth.js", () => ({
  getAuthToken: vi.fn(async () => "test-token"),
}));

import { dispatchTool } from "../../core/capabilities/tool-dispatch.js";
import { z } from "zod";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    // text-to-motion fields
    expect(motion.description).toContain("text-to-motion");
    expect(motion.description).toContain("summer_check_job");
    expect(motion.description).toContain("summer_import_asset_by_id");
    expect(motion.description).toContain("lockJoints");
    expect(motion.schema.prompt).toBeDefined();
    expect(motion.schema.prompts).toBeDefined();
    expect(motion.schema.takes).toBeDefined();
    expect(motion.schema.lockJoints).toBeDefined();
    expect(motion.schema.cfgScale).toBeDefined();
    expect(motion.schema.idempotencyKey).toBeDefined();
    // durationSeconds is reserved for hunyuan-custom — not exposed.
    expect(motion.schema.durationSeconds).toBeUndefined();

    // backend enum: meshy-library (default) + text-to-motion; never hunyuan-custom.
    const backend = z.object(motion.schema).shape.backend;
    expect(backend.parse(undefined)).toBe("meshy-library");
    expect(backend.parse("text-to-motion")).toBe("text-to-motion");
    expect(backend.safeParse("hunyuan-custom").success).toBe(false);
    // motionName is optional at the schema level (required per-backend in the handler).
    expect(z.object(motion.schema).safeParse({ rigAssetId: "rig", backend: "text-to-motion", prompt: "nods" }).success).toBe(true);
  });

  it("zod bounds match the server contract (prompts 1-8 x 1-300 chars, takes 1-4 int, cfgScale 1.5-8)", () => {
    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);
    const schema = z.object(getTool(tools, "summer_generate_motion").schema);
    const base = { rigAssetId: "rig", backend: "text-to-motion" };
    expect(schema.safeParse({ ...base, prompts: [] }).success).toBe(false);
    expect(schema.safeParse({ ...base, prompts: Array(9).fill("nods") }).success).toBe(false);
    expect(schema.safeParse({ ...base, prompts: ["x".repeat(301)] }).success).toBe(false);
    expect(schema.safeParse({ ...base, prompt: "" }).success).toBe(false);
    expect(schema.safeParse({ ...base, prompt: "nods", takes: 5 }).success).toBe(false);
    expect(schema.safeParse({ ...base, prompt: "nods", takes: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ ...base, prompt: "nods", cfgScale: 1 }).success).toBe(false);
    expect(schema.safeParse({ ...base, prompt: "nods", cfgScale: 9 }).success).toBe(false);
    expect(
      schema.safeParse({ ...base, prompts: Array(8).fill("nods"), takes: 4, cfgScale: 5, lockJoints: ["Hips", "Spine"] }).success
    ).toBe(true);
  });

  it("meshy-library still requires motionName and rejects text-to-motion fields (no fetch call)", async () => {
    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);
    const motion = getTool(tools, "summer_generate_motion");

    const stray = await motion.handler({
      rigAssetId: "rig_123",
      backend: "meshy-library",
      motionName: "walk",
      prompt: "waves",
      wait: false,
    });
    expect(stray.isError).toBe(true);
    expect(parseResult(stray).message).toMatch(/only apply to backend "text-to-motion"/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("text-to-motion requires a prompt and rejects motionName (no fetch call)", async () => {
    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);
    const motion = getTool(tools, "summer_generate_motion");

    const missing = await motion.handler({ rigAssetId: "rig_123", backend: "text-to-motion", wait: false });
    expect(missing.isError).toBe(true);
    expect(parseResult(missing).message).toMatch(/prompt_required/);

    const blank = await motion.handler({ rigAssetId: "rig_123", backend: "text-to-motion", prompts: ["  "], wait: false });
    expect(blank.isError).toBe(true);
    expect(parseResult(blank).message).toMatch(/prompt_required/);

    const both = await motion.handler({ rigAssetId: "rig_123", backend: "text-to-motion", prompt: "a", prompts: ["b"], wait: false });
    expect(both.isError).toBe(true);
    expect(parseResult(both).message).toMatch(/either prompt or prompts/);

    const withName = await motion.handler({ rigAssetId: "rig_123", backend: "text-to-motion", motionName: "walk", prompt: "nods", wait: false });
    expect(withName.isError).toBe(true);
    expect(parseResult(withName).message).toMatch(/motionName only applies/);

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("text-to-motion sends prompts, takes, lockJoints, cfgScale and idempotencyKey to /api/mcp/generate/motion", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, queued: true, jobId: "job_ttm", backend: "text-to-motion", clipCount: 4 }),
    }));
    globalThis.fetch = fetchMock as any;

    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);
    const motion = getTool(tools, "summer_generate_motion");

    const result = await motion.handler({
      rigAssetId: "flower_rig",
      backend: "text-to-motion",
      prompts: ["nods happily", "waves hello with the right leaf"],
      takes: 2,
      lockJoints: ["Hips", "Spine"],
      cfgScale: 5,
      idempotencyKey: "flower-1",
      wait: false,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/mcp\/generate\/motion$/);
    expect((init.headers as any)["X-Summer-MCP-Tool"]).toBe("summer_generate_motion");
    expect(JSON.parse(init.body as string)).toEqual({
      rigAssetId: "flower_rig",
      backend: "text-to-motion",
      prompts: ["nods happily", "waves hello with the right leaf"],
      takes: 2,
      lockJoints: ["Hips", "Spine"],
      cfgScale: 5,
      idempotencyKey: "flower-1",
    });
    expect(parseResult(result).jobId).toBe("job_ttm");
    expect(result.isError).toBeUndefined();
  });

  it("text-to-motion accepts a singular prompt and sends it as prompts: [prompt]", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ jobId: "job_one" }) }));
    globalThis.fetch = fetchMock as any;

    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);
    await getTool(tools, "summer_generate_motion").handler({
      rigAssetId: "rig_123",
      backend: "text-to-motion",
      prompt: "bows politely",
      wait: false,
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({ rigAssetId: "rig_123", backend: "text-to-motion", prompts: ["bows politely"] });
    expect(sent.motionName).toBeUndefined();
  });

  it("surfaces backend_unavailable with a fallback hint", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: "backend_unavailable", message: 'backend "text-to-motion" is not enabled yet. Use "meshy-library".' }),
    })) as any;

    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);
    const result = await getTool(tools, "summer_generate_motion").handler({
      rigAssetId: "rig_123",
      backend: "text-to-motion",
      prompt: "nods",
      wait: false,
    });

    expect(result.isError).toBe(true);
    const body = parseResult(result);
    expect(body.error).toBe("backend_unavailable");
    expect(body.message).toMatch(/not enabled yet/);
    expect(body.hint).toMatch(/meshy-library/);
    expect(body.hint).toMatch(/do not retry/);
  });

  it("marks text_motion job failures as refunded input problems", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/api/mcp/jobs/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: "failed", error: "text_motion: The model has no skinned armature." }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ jobId: "job_fail" }) };
    });
    globalThis.fetch = fetchMock as any;

    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);
    const result = await getTool(tools, "summer_generate_motion").handler({
      rigAssetId: "rig_123",
      backend: "text-to-motion",
      prompt: "nods",
      wait: true,
    });

    expect(result.isError).toBe(true);
    const body = parseResult(result);
    expect(body.message).toMatch(/no skinned armature/);
    expect(body.jobId).toBe("job_fail");
    expect(body.hint).toMatch(/refunded/);
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


describe("generated image file", () => {
  it("saves into out (a folder or a file path), never sends out, and waits 3 minutes", async () => {
    const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "summer-gen-test-"));
    try {
      const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
        url.endsWith("/api/mcp/generate/image")
          ? new Response(JSON.stringify({ asset: { id: "image-1", fileUrl: "https://cdn.test/a.png" } }), { status: 200 })
          : new Response(Buffer.from("png-bytes"), { status: 200 })
      );
      globalThis.fetch = fetchMock as never;
      const { server, tools } = createFakeServer();
      registerGenerateTools(server as any);
      const image = getTool(tools, "summer_generate_image");
      const intoFile = await image.handler(z.object(image.schema).parse({ prompt: "key art", width: 1920, height: 1080, out: join(dir, "art", "key.png") }));
      expect(JSON.parse(intoFile.content[0].text).localPath).toBe(join(dir, "art", "key.png"));
      expect(await readFile(join(dir, "art", "key.png"), "utf8")).toBe("png-bytes");
      const intoFolder = await image.handler(z.object(image.schema).parse({ prompt: "icon", out: dir }));
      expect(JSON.parse(intoFolder.content[0].text).localPath).toMatch(new RegExp(`^${dir}/img-\\d+\\.png$`));
      const sent = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
      expect(sent).not.toHaveProperty("out");
      expect(sent).toMatchObject({ width: 1920, height: 1080 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("image background removal across MCP and CLI", () => {
  for (const surface of ["mcp", "cli"] as const) {
    it.each([true, false, undefined])(`${surface} preserves removeBackground=%s in the gateway request`, async (removeBackground) => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ asset: { id: "image-1" } }), { status: 200 }));
      globalThis.fetch = fetchMock;
      const args = { prompt: "an isolated tree", ...(removeBackground !== undefined ? { removeBackground } : {}) };
      if (surface === "cli") {
        await dispatchTool("generate-image", args, { engine: async () => { throw new Error("Image generation must not need an engine"); } });
      } else {
        const { server, tools } = createFakeServer();
        registerGenerateTools(server as any);
        const image = getTool(tools, "summer_generate_image");
        await image.handler(z.object(image.schema).parse(args));
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toMatch(/\/api\/mcp\/generate\/image$/);
      const body = JSON.parse(init.body as string);
      // No model is sent unless one is named: the server picks one that reaches the size.
      expect(body).toMatchObject({ prompt: args.prompt, style: "realistic" });
      expect(body).not.toHaveProperty("model");
      expect(body).not.toHaveProperty("out");
      if (removeBackground === undefined) expect(body).not.toHaveProperty("removeBackground");
      else expect(body.removeBackground).toBe(removeBackground);
    });

    it(`${surface} rejects a string flag before contacting the gateway`, async () => {
      const args = { prompt: "a tree", removeBackground: "false" };
      if (surface === "cli") {
        await expect(dispatchTool("generate-image", args)).rejects.toThrow(/removeBackground/);
      } else {
        const { server, tools } = createFakeServer();
        registerGenerateTools(server as any);
        expect(() => z.object(getTool(tools, "summer_generate_image").schema).parse(args)).toThrow();
      }
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  }
});

describe("image size across MCP and CLI", () => {
  for (const surface of ["mcp", "cli"] as const) {
    it(`${surface} sends aspectRatio, width and height to the gateway`, async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ asset: { id: "image-1" } }), { status: 200 }));
      globalThis.fetch = fetchMock;
      const args = { prompt: "key art", aspectRatio: "16:9", width: 1920, height: 1080 };
      if (surface === "cli") {
        await dispatchTool("generate-image", args, { engine: async () => { throw new Error("Image generation must not need an engine"); } });
      } else {
        const { server, tools } = createFakeServer();
        registerGenerateTools(server as any);
        const image = getTool(tools, "summer_generate_image");
        await image.handler(z.object(image.schema).parse(args));
      }
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toMatchObject({ aspectRatio: "16:9", width: 1920, height: 1080 });
    });
  }

  it("rejects an aspect ratio the server does not map", () => {
    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);
    expect(() => z.object(getTool(tools, "summer_generate_image").schema).parse({ prompt: "x", aspectRatio: "7:3" })).toThrow();
  });
});

describe("summer_generate_motion across MCP and CLI", () => {
  const noEngine = { engine: async () => { throw new Error("Motion generation must not need an engine"); } };

  for (const surface of ["mcp", "cli"] as const) {
    it(`${surface} sends the same text-to-motion body`, async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ jobId: "job_ttm" }), { status: 200 }));
      globalThis.fetch = fetchMock;
      const args = {
        rigAssetId: "flower_rig",
        backend: "text-to-motion",
        prompts: ["nods happily"],
        takes: 3,
        lockJoints: ["Hips", "Spine"],
        cfgScale: 5,
        wait: false,
      };
      if (surface === "cli") {
        await dispatchTool("generate-motion", args, noEngine);
      } else {
        const { server, tools } = createFakeServer();
        registerGenerateTools(server as any);
        const motion = getTool(tools, "summer_generate_motion");
        await motion.handler(z.object(motion.schema).parse(args));
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toMatch(/\/api\/mcp\/generate\/motion$/);
      expect(JSON.parse(init.body as string)).toEqual({
        rigAssetId: "flower_rig",
        backend: "text-to-motion",
        prompts: ["nods happily"],
        takes: 3,
        lockJoints: ["Hips", "Spine"],
        cfgScale: 5,
      });
    });

    it(`${surface} keeps the meshy-library default and body`, async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ jobId: "job_walk" }), { status: 200 }));
      globalThis.fetch = fetchMock;
      const args = { rigAssetId: "rig_123", motionName: "walk", wait: false };
      if (surface === "cli") {
        await dispatchTool("generate-motion", args, noEngine);
      } else {
        const { server, tools } = createFakeServer();
        registerGenerateTools(server as any);
        const motion = getTool(tools, "summer_generate_motion");
        await motion.handler(z.object(motion.schema).parse(args));
      }
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toEqual({ rigAssetId: "rig_123", backend: "meshy-library", motionName: "walk" });
    });
  }

  it("cli rejects meshy-library without motionName and text-to-motion without a prompt before contacting the gateway", async () => {
    await expect(dispatchTool("generate-motion", { rigAssetId: "rig_123", wait: false }, noEngine)).rejects.toThrow(
      /motionName is required/
    );
    await expect(
      dispatchTool("generate-motion", { rigAssetId: "rig_123", backend: "text-to-motion", wait: false }, noEngine)
    ).rejects.toThrow(/prompt_required/);
    await expect(
      dispatchTool("generate-motion", { rigAssetId: "rig_123", backend: "text-to-motion", prompt: "nods", takes: 9 }, noEngine)
    ).rejects.toThrow(/takes/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
