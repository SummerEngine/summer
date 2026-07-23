import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock auth so handlers don't need a real token on disk.
vi.mock("../../lib/auth.js", () => ({
  getAuthToken: vi.fn(async () => "test-token"),
}));

const randomUUIDMock = vi.hoisted(() => vi.fn(() => "generated-idempotency-key"));
vi.mock("node:crypto", () => ({
  randomUUID: randomUUIDMock,
}));

import { registerGenerateTools } from "./generate-tools.js";
import mcpCharacterContract from "../../../contracts/mcp-character-v1.json";

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
  randomUUIDMock.mockClear();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
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
    expect(motion.schema.motionNames).toBeDefined();
    expect(motion.schema.actionIds).toBeDefined();
    expect(motion.schema.wait).toBeDefined();
    expect(motion.schema.options).toBeDefined();
    expect(motion.schema.idempotencyKey).toBeDefined();
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
    expect(body.message).toMatch(/Provide motionName, motionNames, or actionIds/);
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
      motionNames: ["walk"],
      idempotencyKey: "generated-idempotency-key",
    });
    expect(sent.motionName).toBeUndefined();
    // durationSeconds + prompt are NOT exposed (hunyuan-custom not shipped).
    expect(sent.durationSeconds).toBeUndefined();
    expect(sent.prompt).toBeUndefined();

    // wait=false → handler returns the raw response (containing jobId).
    const body = parseResult(result);
    expect(body.jobId).toBe("job_abc");
    expect(body.idempotencyKey).toBe("generated-idempotency-key");
    expect(result.isError).toBeUndefined();
  });

  it("forwards motion name batches and resolved action IDs together", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ jobId: "job_batch" }),
    }));
    globalThis.fetch = fetchMock as any;

    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);
    const motion = getTool(tools, "summer_generate_motion");

    await motion.handler({
      rigAssetId: "rig_123",
      backend: "meshy-library",
      motionNames: ["walk", "run"],
      actionIds: [0],
      wait: false,
      idempotencyKey: "motion-batch-key",
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      rigAssetId: "rig_123",
      backend: "meshy-library",
      motionNames: ["walk", "run"],
      actionIds: [0],
      idempotencyKey: "motion-batch-key",
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

describe("registerGenerateTools — typed summer_generate_3d contract", () => {
  it("publishes explicit humanoid fields and text-only continuation guidance", () => {
    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);

    const gen3d = getTool(tools, "summer_generate_3d");
    expect(gen3d.schema.title).toBeDefined();
    expect(gen3d.schema.rig).toBeDefined();
    expect(gen3d.schema.animationNames).toBeDefined();
    expect(gen3d.schema.actionIds).toBeDefined();
    expect(gen3d.schema.targetHeightMeters).toBeDefined();
    expect(gen3d.description).toContain('status="needs_user_input"');
    expect(gen3d.description).toContain("Ask the question in ordinary text");
    expect(gen3d.description).toContain("There is no menu, card");
    expect(gen3d.description).toContain("Legacy options.rig");
    expect(gen3d.description).not.toContain('"texture"');
  });

  it("normalizes a text humanoid batch into the existing web request shape", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ jobId: "character-job" }),
    }));
    globalThis.fetch = fetchMock as any;

    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);
    const result = await getTool(tools, "summer_generate_3d").handler({
      prompt: "a silver-haired mage",
      kind: "text-to-3d",
      model: "meshy",
      title: "Alya",
      rig: true,
      animationNames: ["Idle", "Walk"],
      targetHeightMeters: 1.7,
      wait: false,
      idempotencyKey: "text-character-key",
    });

    expect(result.isError).toBeUndefined();
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent).toEqual({
      prompt: "a silver-haired mage",
      kind: "text-to-3d",
      model: "meshy",
      title: "Alya",
      options: {
        rig: true,
        animationNames: ["Idle", "Walk"],
        riggingHeightMeters: 1.7,
      },
      idempotencyKey: "text-character-key",
    });
  });

  it("normalizes an image humanoid with exact action IDs", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ jobId: "character-job" }),
    }));
    globalThis.fetch = fetchMock as any;

    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);
    await getTool(tools, "summer_generate_3d").handler({
      kind: "image-to-3d",
      model: "meshy",
      imageUrl: "https://example.com/hero.png",
      rig: true,
      actionIds: [0, 1, 15],
      wait: false,
      idempotencyKey: "image-character-key",
    });

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent).toEqual({
      kind: "image-to-3d",
      model: "meshy",
      imageUrl: "https://example.com/hero.png",
      options: {
        rig: true,
        actionIds: [0, 1, 15],
      },
      idempotencyKey: "image-character-key",
    });
  });

  it("keeps a regular default 3D request free of character options", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ jobId: "model-job" }),
    }));
    globalThis.fetch = fetchMock as any;

    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);
    await getTool(tools, "summer_generate_3d").handler({
      prompt: "a treasure chest",
      kind: "text-to-3d",
      model: "hunyuan",
      wait: false,
      idempotencyKey: "model-key",
    });

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent).toEqual({
      prompt: "a treasure chest",
      kind: "text-to-3d",
      model: "hunyuan",
      idempotencyKey: "model-key",
    });
  });

  it("keeps matching legacy options but rejects conflicting explicit fields", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ jobId: "character-job" }),
    }));
    globalThis.fetch = fetchMock as any;

    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);
    const generate3d = getTool(tools, "summer_generate_3d");
    const compatible = await generate3d.handler({
      kind: "image-to-3d",
      model: "meshy",
      imageUrl: "https://example.com/hero.png",
      rig: true,
      animationNames: ["Idle"],
      options: { rig: true, animationNames: ["Idle"], target_polycount: 30000 },
      wait: false,
      idempotencyKey: "legacy-key",
    });

    expect(compatible.isError).toBeUndefined();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).options).toEqual({
      rig: true,
      animationNames: ["Idle"],
      target_polycount: 30000,
    });

    const conflict = await generate3d.handler({
      kind: "image-to-3d",
      model: "meshy",
      imageUrl: "https://example.com/hero.png",
      rig: true,
      options: { rig: false },
      wait: false,
    });

    expect(conflict.isError).toBe(true);
    expect(parseResult(conflict).message).toContain(
      "Conflicting values for rig and options.rig"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects the unimplemented texture kind before calling the web API", async () => {
    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);

    const result = await getTool(tools, "summer_generate_3d").handler({
      kind: "texture",
      model: "meshy",
      imageUrl: "https://example.com/model.png",
      wait: false,
    });

    expect(result.isError).toBe(true);
    expect(parseResult(result).message).toContain("Retexture is not available");
    expect(globalThis.fetch).not.toHaveBeenCalled();
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

describe("registerGenerateTools — paid generation retry receipts", () => {
  const cases = [
    ["summer_generate_image", { prompt: "a sprite" }],
    ["summer_generate_audio", { capability: "music", prompt: "battle theme" }],
    ["summer_generate_3d", { prompt: "a chest", wait: false }],
    ["summer_generate_video", { prompt: "a slow pan" }],
    [
      "summer_generate_motion",
      {
        rigAssetId: "rig_123",
        backend: "meshy-library",
        motionName: "walk",
        wait: false,
      },
    ],
  ] as const;

  it("exposes idempotencyKey on every paid tool schema", () => {
    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);

    for (const [toolName] of cases) {
      expect(getTool(tools, toolName).schema.idempotencyKey).toBeDefined();
    }
  });

  it.each(cases)(
    "%s forwards a supplied key unchanged and returns it",
    async (toolName, args) => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ jobId: "job_1" }),
      }));
      globalThis.fetch = fetchMock as any;

      const { server, tools } = createFakeServer();
      registerGenerateTools(server as any);
      const result = await getTool(tools, toolName).handler({
        ...args,
        idempotencyKey: "caller-key",
      });

      const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(sent.idempotencyKey).toBe("caller-key");
      expect(parseResult(result).idempotencyKey).toBe("caller-key");
      expect(randomUUIDMock).not.toHaveBeenCalled();
    }
  );

  it.each(cases)(
    "%s creates one key when omitted and returns the same key",
    async (toolName, args) => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ jobId: "job_1" }),
      }));
      globalThis.fetch = fetchMock as any;

      const { server, tools } = createFakeServer();
      registerGenerateTools(server as any);
      const result = await getTool(tools, toolName).handler(args);

      const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(sent.idempotencyKey).toBe("generated-idempotency-key");
      expect(parseResult(result).idempotencyKey).toBe(
        "generated-idempotency-key"
      );
      expect(randomUUIDMock).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    [400, { error: "invalid_request", message: "Bad request" }],
    [409, { error: "duplicate_in_progress", message: "Still processing" }],
    [409, { error: "idempotency_conflict", message: "Different intent" }],
    [503, { error: "idempotency_unavailable", message: "Try later" }],
  ])(
    "preserves the original key for HTTP %i responses",
    async (status, responseBody) => {
      globalThis.fetch = vi.fn(async () => ({
        ok: false,
        status,
        text: async () => JSON.stringify(responseBody),
      })) as any;

      const { server, tools } = createFakeServer();
      registerGenerateTools(server as any);
      const result = await getTool(tools, "summer_generate_image").handler({
        prompt: "a sprite",
        idempotencyKey: "caller-key",
      });

      expect(result.isError).toBe(true);
      expect(parseResult(result)).toMatchObject({
        idempotencyKey: "caller-key",
        status,
      });
    }
  );

  it("returns a replayed job with the original key", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          replayed: true,
          jobId: "original-job",
        }),
    })) as any;

    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);
    const result = await getTool(tools, "summer_generate_3d").handler({
      prompt: "a castle",
      idempotencyKey: "replay-key",
      wait: false,
    });

    expect(parseResult(result)).toMatchObject({
      replayed: true,
      jobId: "original-job",
      idempotencyKey: "replay-key",
    });
  });

  it("preserves the original key when the network request times out", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("The operation was aborted due to timeout");
    }) as any;

    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);
    const result = await getTool(tools, "summer_generate_video").handler({
      prompt: "a slow pan",
      idempotencyKey: "caller-key",
    });

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatchObject({
      idempotencyKey: "caller-key",
      status: 0,
    });
  });

  it("returns animation selection as normal structured content and reuses its key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        text: async () =>
          JSON.stringify({
            error: "needs_animation_selection",
            status: "needs_user_input",
            question:
              'Which animation did you mean by "cast a spell"? Reply with a candidate name or number.',
            query: "cast a spell",
            message: "Choose the closest animation.",
            candidates: [
              { actionId: 125, label: "Charged Spell Cast" },
              { actionId: 126, label: "Quick Spell Cast" },
            ],
            resume: {
              request: {
                kind: "image-to-3d",
                imageUrl: "https://example.com/mage.png",
                idempotencyKey: "selection-key",
                options: { rig: true, actionIds: [] },
              },
              appendSelectedActionIdTo: "options.actionIds",
            },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ jobId: "character-job" }),
      });
    globalThis.fetch = fetchMock as any;

    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);
    const generate3d = getTool(tools, "summer_generate_3d");

    const selectionResult = await generate3d.handler({
      kind: "image-to-3d",
      imageUrl: "https://example.com/mage.png",
      options: { rig: true, animationNames: ["cast a spell"] },
      idempotencyKey: "selection-key",
    });
    const selection = parseResult(selectionResult);

    expect(selectionResult.isError ?? false).toBe(
      mcpCharacterContract.continuation.mcpIsError
    );
    for (const field of mcpCharacterContract.continuation.mcpRequiredFields) {
      expect(selection).toHaveProperty(field);
    }
    expect(selection).toMatchObject({
      status: mcpCharacterContract.continuation.mcpStatus,
      code: mcpCharacterContract.continuation.mcpCode,
      question:
        'Which animation did you mean by "cast a spell"? Reply with a candidate name or number.',
      idempotencyKey: "selection-key",
      candidates: [{ actionId: 125 }, { actionId: 126 }],
      resume: {
        request: { idempotencyKey: "selection-key" },
      },
    });

    const resumedRequest = selection.resume.request;
    resumedRequest.options.actionIds.push(125);
    const resumedResult = await generate3d.handler(resumedRequest);
    expect(parseResult(resumedResult)).toMatchObject({
      jobId: "character-job",
      idempotencyKey: "selection-key",
    });

    const firstSent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const resumedSent = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(firstSent.idempotencyKey).toBe("selection-key");
    expect(resumedSent.idempotencyKey).toBe("selection-key");
    expect(resumedSent.options.actionIds).toEqual([125]);
    expect(randomUUIDMock).not.toHaveBeenCalled();
  });
});

describe("registerGenerateTools — long job defaults", () => {
  it("returns an animated-character job immediately unless wait=true", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ jobId: "character-job-1" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ jobId: "character-job-2" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: "completed", result: { assetId: "asset-1" } }),
      });
    globalThis.fetch = fetchMock as any;

    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);
    const generate3d = getTool(tools, "summer_generate_3d");
    const args = {
      kind: "image-to-3d",
      imageUrl: "https://example.com/hero.png",
      options: { rig: true, animationNames: ["Idle", "Walk"] },
      idempotencyKey: "character-key",
    };

    const immediate = await generate3d.handler(args);
    expect(parseResult(immediate)).toMatchObject({
      jobId: "character-job-1",
      idempotencyKey: "character-key",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const waited = await generate3d.handler({ ...args, wait: true });
    expect(parseResult(waited)).toMatchObject({
      jobId: "character-job-2",
      idempotencyKey: "character-key",
      message: "3D generation complete.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns a multi-motion job immediately unless wait=true", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ jobId: "motion-job-1" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ jobId: "motion-job-2" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: "completed", result: { animationAssetId: "anim-1" } }),
      });
    globalThis.fetch = fetchMock as any;

    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);
    const generateMotion = getTool(tools, "summer_generate_motion");
    const args = {
      rigAssetId: "rig-1",
      backend: "meshy-library",
      motionNames: ["Idle", "Walk"],
      idempotencyKey: "motion-key",
    };

    const immediate = await generateMotion.handler(args);
    expect(parseResult(immediate)).toMatchObject({
      jobId: "motion-job-1",
      idempotencyKey: "motion-key",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const waited = await generateMotion.handler({ ...args, wait: true });
    expect(parseResult(waited)).toMatchObject({
      jobId: "motion-job-2",
      idempotencyKey: "motion-key",
      message: "Motion generation complete. animationAssetId is in result.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps the job receipt if explicit polling fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ jobId: "character-job-1" }),
      })
      .mockRejectedValueOnce(new Error("poll timeout"));
    globalThis.fetch = fetchMock as any;

    const { server, tools } = createFakeServer();
    registerGenerateTools(server as any);
    const result = await getTool(tools, "summer_generate_3d").handler({
      kind: "image-to-3d",
      imageUrl: "https://example.com/hero.png",
      options: { rig: true, animationNames: ["Idle", "Walk"] },
      idempotencyKey: "character-key",
      wait: true,
    });

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatchObject({
      jobId: "character-job-1",
      idempotencyKey: "character-key",
    });
    expect(parseResult(result).message).toMatch(/poll timeout/);
  });
});
