import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSummerDirForTests, writeStoreJson } from "../../core/store.js";
import { registerCreatorTools } from "./creator-tools.js";
import { buildZip } from "../../test-helpers/summer-bundle-fixture.js";

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
  it("describes the fields the upload preview actually returns for each format", async () => {
    const file = join(root, "web.zip");
    await writeFile(file, buildZip([{ name: "index.html", data: Buffer.from("<title>Fixture</title>") }]));
    await writeStoreJson("oauth-token", { schemaVersion: 1, accessToken: "fixture-local-only", expiresAt: "2099-01-01T00:00:00Z" });
    vi.stubEnv("SUMMER_GATEWAY_URL", "http://127.0.0.1:17656");
    const fetch = vi.fn(async () => Response.json({ id: GAME_ID, name: "Fixture", supportedPlatforms: ["ios"] }));
    vi.stubGlobal("fetch", fetch);
    try {
      const { server, tools } = createFakeServer();
      registerCreatorTools(server as any);
      const tool = getTool(tools, "summer_publish_build");
      const result = parseResult(await tool.handler({ gameId: GAME_ID, file, platform: "web", clientVersion: "v1.0.0", confirm: false }));
      expect(result).toMatchObject({ status: "confirmation_required", target: { gameId: GAME_ID, file, platform: "web", clientVersion: "v1.0.0" } });
      expect(result.target).not.toHaveProperty("sha256");
      expect(result).not.toHaveProperty("warnings");
      expect(fetch.mock.calls).toHaveLength(1);
      expect(tool.description).toContain("Bundles include a SHA-256 digest");
      expect(tool.description).toContain("Web builds and downloads identify the file, platform, size and version");
      const descriptor = await readFile(new URL("../../../library/tools/publish-build/resource.yaml", import.meta.url), "utf8");
      expect(descriptor).toContain("exact upload target returned by the confirm=false preview");
    } finally {
      vi.unstubAllEnvs();
    }
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
