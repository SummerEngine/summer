import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setSummerDirForTests } from "../core/store.js";
import { EngineApiClient } from "../core/api-client.js";
import { configureMcpEngineSelection, createMcpServer } from "./server.js";

let root = "";
let projectA = "";
let projectB = "";
let client: Client;
let built: ReturnType<typeof createMcpServer>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-creator-binding-"));
  setSummerDirForTests(join(root, "store"));
  vi.stubEnv("SUMMER_NO_TELEMETRY", "1");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No network in project binding regression"); }));
  [projectA, projectB] = [join(root, "a"), join(root, "b")];
  for (const [project, slug] of [[projectA, "only_a"], [projectB, "only_b"]]) {
    await mkdir(project);
    await writeFile(join(project, "project.godot"), "config_version=5\n");
    await writeFile(join(project, "summer.items.json"), JSON.stringify({
      schema: "summer.items/v1",
      items: [{ slug, name: slug, description: "Local identity control" }],
    }));
  }
  vi.spyOn(process, "cwd").mockReturnValue(projectA);
  configureMcpEngineSelection({ projectPath: projectB });
  built = createMcpServer(undefined, { surface: "v3" });
  client = new Client({ name: "creator-binding-regression", version: "1.0.0" });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(local), built.server.connect(remote)]);
});

afterEach(async () => {
  await client?.close();
  await built?.server.close();
  configureMcpEngineSelection(undefined);
  setSummerDirForTests(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function sync(slug: string, project?: string) {
  const result = await client.callTool({
    name: "summer_sync_items",
    arguments: { gameId: "local-fixture", slugs: [slug], ...(project ? { project } : {}) },
  });
  const text = result.content as Array<{ type: string; text?: string }>;
  return JSON.parse(text.find((part) => part.type === "text")!.text!);
}

it("reads the bound manifest before requesting store access, ahead of cwd and environment", async () => {
  vi.stubEnv("SUMMER_ENGINE_PROJECT", projectA);
  expect(await sync("only_b")).toMatchObject({ code: "store_login_required" });
  expect(await sync("only_a")).toMatchObject({ code: "item_slug_unknown" });
});

it("keeps explicit project input ahead of the binding", async () => {
  expect(await sync("only_a", projectA)).toMatchObject({ code: "store_login_required" });
});

it("refuses an instance without a project directory instead of reading cwd", async () => {
  configureMcpEngineSelection({ instanceId: "selected-without-project" });
  vi.spyOn(EngineApiClient, "connect").mockResolvedValue({ getProjectRoot: () => undefined } as EngineApiClient);
  expect(await sync("only_a")).toMatchObject({
    code: "creator_request_invalid",
    message: expect.stringContaining("Pass project explicitly"),
  });
});

it("resolves a changed binding at call time and retains cwd fallback when unbound", async () => {
  configureMcpEngineSelection({ cwd: projectA });
  expect(await sync("only_a")).toMatchObject({ code: "store_login_required" });
  configureMcpEngineSelection(undefined);
  expect(await sync("only_a")).toMatchObject({ code: "store_login_required" });
});
