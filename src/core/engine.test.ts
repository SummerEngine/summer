import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
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
