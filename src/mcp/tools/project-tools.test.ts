import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../server.js", () => ({
  getClient: vi.fn(),
  resetClient: vi.fn(),
}));

vi.mock("../../lib/telemetry.js", () => ({
  recordMcpSession: vi.fn(),
}));

import { getClient } from "../server.js";
import { registerProjectTools } from "./project-tools.js";

type RegisteredTool = {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

let tempDirs: string[] = [];

function createFakeServer(): { server: unknown; tools: RegisteredTool[] } {
  const tools: RegisteredTool[] = [];
  const server = {
    tool(
      name: string,
      description: string,
      schema: Record<string, unknown>,
      handler: (args: Record<string, unknown>) => Promise<unknown>
    ) {
      tools.push({ name, description, schema, handler });
      return { name };
    },
  };
  return { server, tools };
}

function getTool(tools: RegisteredTool[], name: string): RegisteredTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return tool;
}

function parseToolResult(result: unknown): Record<string, unknown> {
  const envelope = result as { content?: Array<{ text?: string }> };
  const text = envelope.content?.[0]?.text;
  if (!text) throw new Error("Tool result did not include text content.");
  return JSON.parse(text) as Record<string, unknown>;
}

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "summer-project-context-"));
  tempDirs.push(dir);
  return dir;
}

function write(project: string, path: string, content: string): void {
  const absolutePath = join(project, ...path.split("/"));
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf-8");
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("registerProjectTools", () => {
  it("registers a game-task router for first-principles agent starts", async () => {
    const { server, tools } = createFakeServer();
    registerProjectTools(server as never);

    const startTool = getTool(tools, "summer_start_game_task");
    const body = parseToolResult(
      await startTool.handler({
        goal: "Create a sword model and add it to the level",
        mode: "asset",
        target: "3d",
        assetPolicy: "ask-before-paid-generation",
        verification: "full",
      })
    );

    expect(body.mode).toBe("asset");
    expect(body.target).toBe("3d");
    expect(JSON.stringify(body)).toContain("summer_import_asset_by_id");
    expect(JSON.stringify(body)).toContain("prop-model");
  });

  it("includes project memory in project context using health.project_path fallback", async () => {
    const project = makeProject();
    write(project, ".summer/GameSoul.md", "# Memory Test\n");
    write(
      project,
      ".summer/memory/casting/voices.md",
      `---
id: casting.voice.main-cast
priority: locked
---

# Main Voice Cast

| Character | Provider | Voice ID | Stability |
|---|---|---|---|
| Bob | ElevenLabs | \`voice_bob\` | locked |
`
    );

    vi.mocked(getClient).mockResolvedValue({
      health: vi.fn(async () => ({
        ok: true,
        engine: "Summer Engine",
        version: "test",
        port: 6550,
        project_path: project,
        project_name: "Memory Test",
        scene: "res://main.tscn",
      })),
      getProjectState: vi.fn(async () => ({
        ok: true,
        data: {
          entries: [
            {
              key: "application/run/main_scene",
              value: "res://main.tscn",
            },
          ],
        },
      })),
      getSceneState: vi.fn(async () => ({
        ok: true,
        data: {
          scenePath: "res://main.tscn",
        },
      })),
      rebind: vi.fn(async () => "test-project-hash"),
    } as never);

    const { server, tools } = createFakeServer();
    registerProjectTools(server as never);

    const contextTool = getTool(tools, "summer_get_project_context");
    const body = parseToolResult(await contextTool.handler({}));
    const projectMemory = body.projectMemory as {
      present: boolean;
      canonical: { gameSoul: { title: string } };
      structured: {
        lockedCount: number;
        files: Array<{ path: string; kind: string; locked: boolean }>;
      };
    };

    expect(body.projectPath).toBe(project);
    expect(body.projectName).toBe("Memory Test");
    expect(body.currentScene).toBe("res://main.tscn");
    expect(projectMemory.present).toBe(true);
    expect(projectMemory.canonical.gameSoul.title).toBe("Memory Test");
    expect(projectMemory.structured.lockedCount).toBe(1);
    expect(projectMemory.structured.files[0]).toMatchObject({
      path: ".summer/memory/casting/voices.md",
      kind: "casting",
      locked: true,
    });
  });

  it("trims project settings to curated prefixes and declares the trim", async () => {
    vi.mocked(getClient).mockResolvedValue({
      health: vi.fn(async () => ({ ok: true })),
      getProjectState: vi.fn(async () => ({
        ok: true,
        data: {
          entries: [
            { key: "application/run/main_scene", value: "res://main.tscn" },
            { key: "display/window/size/viewport_width", value: 1920 },
            { key: "audio/buses/default_bus_layout", value: "res://bus.tres" },
            { key: "editor/naming/scene_name_casing", value: 2 },
          ],
        },
      })),
      getSceneState: vi.fn(async () => ({ ok: true, data: {} })),
      rebind: vi.fn(async () => "test-project-hash"),
    } as never);

    const { server, tools } = createFakeServer();
    registerProjectTools(server as never);

    const contextTool = getTool(tools, "summer_get_project_context");
    const body = parseToolResult(await contextTool.handler({}));
    const data = (body.project as { data: Record<string, unknown> }).data;
    const keys = (data.entries as Array<{ key: string }>).map((entry) => entry.key);

    expect(keys).toEqual([
      "application/run/main_scene",
      "display/window/size/viewport_width",
    ]);
    expect(data.settingsTruncated).toBe(true);
    expect(data.totalSettings).toBe(4);
    expect(data.returnedSettings).toBe(2);
    expect(data.settingsHint).toContain("settingsPrefix");
    expect(data.settingsPrefixesIncluded).toContain("application/");
    // Derived context still reads the untrimmed state.
    expect(body.mainScene).toBe("res://main.tscn");
  });

  it("threads settingsPrefix to the engine and filters settings client-side", async () => {
    const getProjectState = vi.fn(async () => ({
      ok: true,
      data: {
        entries: [
          { key: "application/run/main_scene", value: "res://main.tscn" },
          { key: "audio/buses/default_bus_layout", value: "res://bus.tres" },
        ],
      },
    }));
    vi.mocked(getClient).mockResolvedValue({
      health: vi.fn(async () => ({ ok: true })),
      getProjectState,
      getSceneState: vi.fn(async () => ({ ok: true, data: {} })),
      rebind: vi.fn(async () => "test-project-hash"),
    } as never);

    const { server, tools } = createFakeServer();
    registerProjectTools(server as never);

    const contextTool = getTool(tools, "summer_get_project_context");
    const body = parseToolResult(await contextTool.handler({ settingsPrefix: "audio/" }));

    // The prefix rides the query string for forward-compat, but current
    // engines ignore it — so the client-side filter must hold on its own.
    expect(getProjectState).toHaveBeenCalledWith("audio/");
    const data = (body.project as { data: Record<string, unknown> }).data;
    expect(data.entries).toEqual([
      { key: "audio/buses/default_bus_layout", value: "res://bus.tres" },
    ]);
    expect(data.settingsPrefix).toBe("audio/");
    expect(data.settingsTruncated).toBe(true);
    expect(data.totalSettings).toBe(2);
    // Derived context still reads the untrimmed state.
    expect(body.mainScene).toBe("res://main.tscn");
  });

  it("reads the scene tree untargeted when no depth/limit are requested", async () => {
    const getSceneState = vi.fn(async () => ({ ok: true, data: { name: "Root" } }));
    vi.mocked(getClient).mockResolvedValue({ getSceneState } as never);

    const { server, tools } = createFakeServer();
    registerProjectTools(server as never);

    const treeTool = getTool(tools, "summer_get_scene_tree");
    await treeTool.handler({});

    expect(getSceneState).toHaveBeenCalledTimes(1);
    expect(getSceneState.mock.calls[0]).toEqual([undefined]);
  });

  it("resolves the current scene and re-reads targeted when depth/limit are passed", async () => {
    // Engine contract: depth/limit only apply to scene=-targeted reads; the
    // untargeted route serves a default-args snapshot and drops query params.
    const getSceneState = vi.fn(
      async (scenePath?: string, options?: { depth?: number; limit?: number }) => {
        if (!scenePath) {
          return {
            ok: true,
            data: { name: "Root" },
            provenance: { scenePath: "res://main.tscn" },
          };
        }
        return { ok: true, data: { name: "Root", visited: 102 }, requested: { scenePath, options } };
      }
    );
    vi.mocked(getClient).mockResolvedValue({ getSceneState } as never);

    const { server, tools } = createFakeServer();
    registerProjectTools(server as never);

    const treeTool = getTool(tools, "summer_get_scene_tree");
    const body = parseToolResult(await treeTool.handler({ depth: 10, limit: 500 }));

    expect(getSceneState).toHaveBeenCalledTimes(2);
    expect(getSceneState.mock.calls[0]).toEqual([]);
    expect(getSceneState.mock.calls[1]).toEqual([
      "res://main.tscn",
      { depth: 10, limit: 500 },
    ]);
    expect(body.requested).toEqual({
      scenePath: "res://main.tscn",
      options: { depth: 10, limit: 500 },
    });
  });

  it("passes depth/limit directly when scenePath is explicit", async () => {
    const getSceneState = vi.fn(async () => ({ ok: true, data: { name: "Root" } }));
    vi.mocked(getClient).mockResolvedValue({ getSceneState } as never);

    const { server, tools } = createFakeServer();
    registerProjectTools(server as never);

    const treeTool = getTool(tools, "summer_get_scene_tree");
    await treeTool.handler({ scenePath: "res://level.tscn", depth: 6 });

    expect(getSceneState).toHaveBeenCalledTimes(1);
    expect(getSceneState.mock.calls[0]).toEqual(["res://level.tscn", { depth: 6, limit: undefined }]);
  });

  it("reports honestly when depth/limit cannot be applied without a resolvable scene", async () => {
    const getSceneState = vi.fn(async () => ({ ok: true, data: { name: "Root" } }));
    vi.mocked(getClient).mockResolvedValue({ getSceneState } as never);

    const { server, tools } = createFakeServer();
    registerProjectTools(server as never);

    const treeTool = getTool(tools, "summer_get_scene_tree");
    const body = parseToolResult(await treeTool.handler({ depth: 10 }));

    expect(getSceneState).toHaveBeenCalledTimes(1);
    expect(body.depthLimitApplied).toBe(false);
    expect(body.note).toContain("IGNORED");
    expect(body.data).toEqual({ name: "Root" });
  });

  it("teaches agents to read relevant memory before project work", async () => {
    const { server, tools } = createFakeServer();
    registerProjectTools(server as never);

    const playbookTool = getTool(tools, "summer_get_agent_playbook");
    const body = parseToolResult(await playbookTool.handler({}));

    expect(JSON.stringify(body)).toContain("projectMemory");
    expect(JSON.stringify(body)).toContain("priority: locked");
  });
});
