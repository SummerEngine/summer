import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  discoverEngineConnection,
  listEngineInstances,
  resolveEngineConnection,
  type EngineInstance,
} from "./engine.js";

let testRoot: string | null = null;

async function setupRoot(): Promise<string> {
  testRoot = await mkdtemp(join(tmpdir(), "summer-engine-discovery-"));
  const summerDir = join(testRoot, ".summer");
  await mkdir(join(summerDir, "instances"), { recursive: true });
  return testRoot;
}

function discoveryOptions(): { summerDir: string } {
  if (!testRoot) throw new Error("test root not initialized");
  return { summerDir: join(testRoot, ".summer") };
}

async function createProject(name: string): Promise<string> {
  if (!testRoot) throw new Error("test root not initialized");
  const root = join(testRoot, name);
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(join(root, "project.godot"), `[application]\nconfig/name="${name}"\n`);
  return root;
}

async function registerInstance(
  projectRoot: string,
  overrides: Partial<EngineInstance> = {}
): Promise<EngineInstance> {
  const projectName = basename(projectRoot);
  const instance: EngineInstance = {
    schemaVersion: 1,
    instanceId: overrides.instanceId ?? `instance-${projectName}`,
    pid: overrides.pid ?? process.pid,
    port: overrides.port ?? 6550,
    token: overrides.token ?? `token-${projectName}`,
    projectId: overrides.projectId ?? `project-${projectName}`,
    projectIdHash: overrides.projectIdHash ?? `hash-${projectName}`,
    resourceRoot: projectRoot,
    projectName: overrides.projectName ?? projectName,
    heartbeatAt: overrides.heartbeatAt ?? Math.floor(Date.now() / 1000),
    engineVersion: "0.5.58",
  };
  const instancesDir = join(testRoot!, ".summer", "instances");
  await writeFile(
    join(instancesDir, `${instance.instanceId}.json`),
    JSON.stringify(instance)
  );
  return instance;
}

function mockHealth(instances: EngineInstance[]): void {
  vi.stubGlobal("fetch", async (input: unknown) => {
    const port = Number(new URL(String(input)).port);
    const instance = instances.find((candidate) => candidate.port === port);
    if (!instance) return new Response("", { status: 404 });
    return new Response(
      JSON.stringify({
        ok: true,
        engine: "summer",
        version: instance.engineVersion,
        port: instance.port,
        pid: instance.pid,
        instanceId: instance.instanceId,
        projectId: instance.projectId,
        projectIdHash: instance.projectIdHash,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  if (testRoot) {
    await rm(testRoot, { recursive: true, force: true });
    testRoot = null;
  }
});

describe("per-instance Summer editor discovery", () => {
  it("automatically binds an agent to the editor for its current project", async () => {
    await setupRoot();
    const projectA = await createProject("game-a");
    const projectB = await createProject("game-b");
    const a = await registerInstance(projectA, { port: 6550 });
    const b = await registerInstance(projectB, { port: 6551 });
    mockHealth([a, b]);

    const connection = await resolveEngineConnection(
      { cwd: join(projectB, "scripts") },
      discoveryOptions()
    );

    expect(connection.source).toBe("registry");
    expect(connection.instance?.instanceId).toBe(b.instanceId);
    expect(connection.port).toBe(6551);
    expect(connection.token).toBe(b.token);
  });

  it("supports an explicit instance when two editors show the same project", async () => {
    await setupRoot();
    const project = await createProject("shared-game");
    const a = await registerInstance(project, {
      instanceId: "editor-a",
      port: 6550,
    });
    const b = await registerInstance(project, {
      instanceId: "editor-b",
      port: 6551,
    });
    mockHealth([a, b]);

    const connection = await resolveEngineConnection(
      {
        projectPath: project,
        instanceId: "editor-b",
      },
      discoveryOptions()
    );

    expect(connection.instance?.instanceId).toBe("editor-b");
  });

  it("lets an explicit instance override an unrelated MCP working directory", async () => {
    await setupRoot();
    const projectA = await createProject("game-a");
    const projectB = await createProject("game-b");
    const a = await registerInstance(projectA, { port: 6550 });
    const b = await registerInstance(projectB, {
      instanceId: "editor-b",
      port: 6551,
    });
    mockHealth([a, b]);

    const connection = await resolveEngineConnection(
      {
        instanceId: "editor-b",
        cwd: join(projectA, "scripts"),
      },
      discoveryOptions()
    );

    expect(connection.instance?.instanceId).toBe("editor-b");
  });

  it("fails closed when multiple editors are live and no project can be inferred", async () => {
    const root = await setupRoot();
    const projectA = await createProject("game-a");
    const projectB = await createProject("game-b");
    const a = await registerInstance(projectA, { port: 6550 });
    const b = await registerInstance(projectB, { port: 6551 });
    mockHealth([a, b]);

    await expect(
      resolveEngineConnection({ cwd: root }, discoveryOptions())
    ).rejects.toThrow(/Multiple Summer editors are running/);
  });

  it("ignores stale or dead registry entries", async () => {
    await setupRoot();
    const project = await createProject("stale-game");
    await registerInstance(project, {
      pid: 2_147_483_647,
      heartbeatAt: Math.floor(Date.now() / 1000) - 600,
    });

    await expect(
      listEngineInstances(Date.now(), discoveryOptions().summerDir)
    ).resolves.toEqual([]);
  });

  it("keeps the legacy global pointer fallback for older engine builds", async () => {
    await setupRoot();
    const project = await createProject("legacy-game");
    await writeFile(join(testRoot!, ".summer", "api-port"), "6550\n");
    await writeFile(join(testRoot!, ".summer", "api-token"), "legacy-token\n");
    const legacy: EngineInstance = {
      schemaVersion: 1,
      instanceId: "legacy-editor",
      pid: process.pid,
      port: 6550,
      token: "legacy-token",
      resourceRoot: "/not-published",
      heartbeatAt: Math.floor(Date.now() / 1000),
      engineVersion: "0.5.55",
    };
    mockHealth([legacy]);

    const connection = await resolveEngineConnection(
      { cwd: join(project, "scripts") },
      discoveryOptions()
    );

    expect(connection.source).toBe("legacy");
    expect(connection.port).toBe(6550);
    expect(connection.token).toBe("legacy-token");
  });
});

// The CLI face has no --project flag: EngineApiClient.connect() with no
// selection used to read only the global api-token/api-port pointer, so an
// editor launched --summer-no-publish (registry entry, no pointer) read as
// "not running" on every call (docs/design/TK-VS-FOLD-2026-09-07.md, gap 3).
describe("no-selection discovery (CLI face): pointer first, then the instance registry", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function writePointer(port: number, token: string): Promise<void> {
    await writeFile(join(testRoot!, ".summer", "api-port"), `${port}\n`);
    await writeFile(join(testRoot!, ".summer", "api-token"), `${token}\n`);
  }

  it("uses the global pointer when it names a live engine, even with registry entries present", async () => {
    const root = await setupRoot();
    const projectA = await createProject("game-a");
    const projectB = await createProject("game-b");
    const a = await registerInstance(projectA, { port: 6551 });
    const b = await registerInstance(projectB, { port: 6552 });
    await writePointer(6550, "pointer-token");
    const pointerEngine: EngineInstance = { ...a, instanceId: "pointer-editor", port: 6550, token: "pointer-token" };
    mockHealth([pointerEngine, a, b]);

    const connection = await discoverEngineConnection({ ...discoveryOptions(), cwd: root, env: {} });

    expect(connection.source).toBe("legacy");
    expect(connection.port).toBe(6550);
    expect(connection.token).toBe("pointer-token");
    expect(connection.health.instanceId).toBe("pointer-editor");
  });

  it("falls back to the registry when there is no pointer and exactly one editor is live", async () => {
    const root = await setupRoot();
    const project = await createProject("unpublished-game");
    const only = await registerInstance(project, { port: 6553 });
    mockHealth([only]);

    const connection = await discoverEngineConnection({ ...discoveryOptions(), cwd: root, env: {} });

    expect(connection.source).toBe("registry");
    expect(connection.instance?.instanceId).toBe(only.instanceId);
    expect(connection.port).toBe(6553);
    expect(connection.token).toBe(only.token);
  });

  it("falls back to the registry when the pointer is stale (engine gone) and one editor is live", async () => {
    const root = await setupRoot();
    const project = await createProject("second-game");
    const live = await registerInstance(project, { port: 6553 });
    await writePointer(6550, "dead-token");
    mockHealth([live]); // nothing answers on 6550

    const connection = await discoverEngineConnection({ ...discoveryOptions(), cwd: root, env: {} });

    expect(connection.source).toBe("registry");
    expect(connection.instance?.instanceId).toBe(live.instanceId);
  });

  it("with several live editors and no pointer, prefers the one whose project encloses cwd", async () => {
    await setupRoot();
    const projectA = await createProject("game-a");
    const projectB = await createProject("game-b");
    const a = await registerInstance(projectA, { port: 6551 });
    const b = await registerInstance(projectB, { port: 6552 });
    mockHealth([a, b]);

    const connection = await discoverEngineConnection({
      ...discoveryOptions(),
      cwd: join(projectB, "scripts"),
      env: {},
    });

    expect(connection.source).toBe("registry");
    expect(connection.instance?.instanceId).toBe(b.instanceId);
    expect(connection.port).toBe(6552);
  });

  it("with several live editors and no match for cwd, fails naming every live editor and how to pick one", async () => {
    const root = await setupRoot();
    const projectA = await createProject("game-a");
    const projectB = await createProject("game-b");
    const a = await registerInstance(projectA, { port: 6551 });
    const b = await registerInstance(projectB, { port: 6552 });
    mockHealth([a, b]);

    const attempt = discoverEngineConnection({ ...discoveryOptions(), cwd: root, env: {} });

    await expect(attempt).rejects.toThrow(/Multiple Summer editors are running/);
    const message = await attempt.catch((error: Error) => error.message);
    expect(message).toContain(a.instanceId);
    expect(message).toContain(b.instanceId);
    expect(message).toContain(projectA);
    expect(message).toContain(projectB);
    expect(message).toContain("SUMMER_ENGINE_PROJECT=");
    expect(message).toContain("summer mcp --project <path>");
  });

  it("a registered editor whose /api/health does not answer is not live", async () => {
    const root = await setupRoot();
    const projectA = await createProject("game-a");
    const projectB = await createProject("game-b");
    const a = await registerInstance(projectA, { port: 6551 });
    await registerInstance(projectB, { port: 6552 }); // pid alive, heartbeat fresh, socket gone
    mockHealth([a]);

    const connection = await discoverEngineConnection({ ...discoveryOptions(), cwd: root, env: {} });

    expect(connection.instance?.instanceId).toBe(a.instanceId);
  });

  it("reports not running, still mentioning the api-token, when neither pointer nor registry has a live editor", async () => {
    const root = await setupRoot();
    const project = await createProject("closed-game");
    await registerInstance(project, { port: 6551 });
    mockHealth([]);

    await expect(
      discoverEngineConnection({ ...discoveryOptions(), cwd: root, env: {} })
    ).rejects.toThrow(/not running \(no api-token found/);
  });

  it("SUMMER_ENGINE_PROJECT pins the editor the way `summer mcp --project` does", async () => {
    const root = await setupRoot();
    const projectA = await createProject("game-a");
    const projectB = await createProject("game-b");
    const a = await registerInstance(projectA, { port: 6551 });
    const b = await registerInstance(projectB, { port: 6552 });
    mockHealth([a, b]);

    const connection = await discoverEngineConnection({
      ...discoveryOptions(),
      cwd: root,
      env: { SUMMER_ENGINE_PROJECT: projectA },
    });

    expect(connection.instance?.instanceId).toBe(a.instanceId);
    expect(connection.source).toBe("registry");
    expect(connection.selection?.projectPath).toBe(await realpath(projectA));
  });
});
