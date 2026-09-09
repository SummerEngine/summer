import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveCreatorToken } from "../../core/auth.js";
import { setConfigValue } from "../../core/config.js";
import { setSummerDirForTests } from "../../core/store.js";
import { registerCreatorTools } from "./creator-tools.js";

type Registered = {
  name: string;
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
        _description: string,
        schema: Record<string, unknown>,
        handler: (args: any) => Promise<any>
      ) {
        tools.push({ name, schema, handler });
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
let artifact = "";
const GAME_ID = "11111111-1111-4111-8111-111111111111";
const RELEASE_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = `sc_${"c".repeat(43)}`;
const ARTIFACT_BYTES = Buffer.from("Summer MCP PCK".padEnd(2048, "."));
const SHA256 = createHash("sha256").update(ARTIFACT_BYTES).digest("hex");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-creator-tools-test-"));
  artifact = join(root, "release.pck");
  await writeFile(artifact, ARTIFACT_BYTES);
  setSummerDirForTests(join(root, ".summer"));
  await setConfigValue("creator.apiUrl", "http://localhost:3000");
  await setConfigValue("creator.projectId", GAME_ID);
  await saveCreatorToken(TOKEN);
});

afterEach(async () => {
  setSummerDirForTests(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("registerCreatorTools", () => {
  it("extends the existing MCP with three creator tools", () => {
    const { server, tools } = createFakeServer();
    registerCreatorTools(server as any);
    expect(tools.map((tool) => tool.name)).toEqual([
      "summer_creator_publish",
      "summer_creator_releases",
      "summer_creator_config",
    ]);
  });

  it("requires confirmation for config writes but never accepts secrets", async () => {
    const { server, tools } = createFakeServer();
    registerCreatorTools(server as any);
    const config = getTool(tools, "summer_creator_config");

    const refused = await config.handler({
      action: "set",
      key: "creator.projectId",
      value: "project-1",
      confirm: false,
    });
    expect(refused.isError).toBe(true);
    expect(parseResult(refused).message).toContain("confirm=true");

    const written = await config.handler({
      action: "set",
      key: "creator.projectId",
      value: "project-1",
      confirm: true,
    });
    expect(parseResult(written)).toMatchObject({
      ok: true,
      key: "creator.projectId",
      value: "project-1",
    });
    expect(Object.keys(config.schema)).not.toContain("token");
  });

  it("runs confirmed publish through the same real creator client", async () => {
    let call = 0;
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      call += 1;
      if (call === 1) {
        return Response.json({
          contract: "summer.creator.v1",
          operation: "prepare",
          uploadUrl: "http://localhost:4000/upload",
          headers: {
            "content-type": "application/octet-stream",
            "if-none-match": "*",
          },
          method: "PUT",
          finalizeUrl: "/api/creator/v1/publish",
        });
      }
      if (call === 2) {
        expect(init?.method).toBe("PUT");
        return new Response(null, { status: 200 });
      }
      return Response.json(
        {
          contract: "summer.creator.v1",
          operation: "finalize",
          releaseId: RELEASE_ID,
          gameId: GAME_ID,
          version: "1.0.0",
          sha256: SHA256,
          sizeBytes: ARTIFACT_BYTES.byteLength,
          status: "pending_review",
          detail: "Queued for review.",
        },
        { status: 201 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { server, tools } = createFakeServer();
    registerCreatorTools(server as any);
    const result = await getTool(tools, "summer_creator_publish").handler({
      project: root,
      artifact,
      version: "1.0.0",
      confirm: true,
    });
    expect(result.isError).toBeUndefined();
    expect(parseResult(result)).toMatchObject({
      ok: true,
      operation: "publish",
      releaseId: RELEASE_ID,
      status: "pending_review",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns real release history and preserves the opaque cursor", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        contract: "summer.creator.v1",
        gameId: GAME_ID,
        releases: [
          {
            releaseId: RELEASE_ID,
            gameId: GAME_ID,
            version: "1.0.0",
            state: "pending_review",
            gameStatus: "review",
            sha256: "a".repeat(64),
            sizeBytes: 2048,
            changelog: null,
            submittedAt: "2026-07-30T12:00:00.000Z",
            artifactPlane: "r2",
          },
        ],
        nextCursor: "cursor-2",
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { server, tools } = createFakeServer();
    registerCreatorTools(server as any);

    const result = await getTool(tools, "summer_creator_releases").handler({
      limit: 20,
      cursor: "cursor-1",
    });
    expect(parseResult(result)).toMatchObject({
      ok: true,
      operation: "releases",
      nextCursor: "cursor-2",
      releases: [{ releaseId: RELEASE_ID }],
    });
  });
});
