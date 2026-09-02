import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../server.js", () => ({
  getClient: vi.fn(),
  resetClient: vi.fn(),
}));

vi.mock("../../core/telemetry.js", () => ({
  recordMcpSession: vi.fn(),
}));

import { getClient } from "../server.js";
import {
  buildAgentPlaybook,
  registerPlaybookPrompt,
  registerProjectTools,
} from "./project-tools.js";

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

  it("structures the playbook on the observe-first / routing / invariants skeleton", () => {
    const playbook = buildAgentPlaybook();
    const text = JSON.stringify(playbook);

    // Observe-first step 0 + before/after screenshots.
    expect(playbook.step0_observeFirst).toBeDefined();
    expect(JSON.stringify(playbook.step0_observeFirst)).toContain("summer_world_snapshot");
    expect(JSON.stringify(playbook.visualVerification)).toContain("BEFORE");
    expect(JSON.stringify(playbook.visualVerification)).toContain("AFTER");

    // Priority-ordered content routing with scripting as the explicit last resort.
    const routing = playbook.contentRouting as Record<string, unknown>;
    expect(routing.priorityOrder).toEqual([
      "1_reuseProjectAssets",
      "2_assetLibraryImport",
      "3_generation",
      "4_scripting_LAST_RESORT",
    ]);
    // Per-route anti-patterns.
    expect(text).toContain("Never generate the whole scene in one script");
    expect(text).toContain("Never generate the whole scene in one shot");
    expect(text).toContain("Don't hand-model organic shapes");

    // Physical invariants, cost rules, closing ritual, trajectory feedback.
    expect(JSON.stringify(playbook.physicalInvariants)).toContain("AABB");
    expect(JSON.stringify(playbook.costRules)).toContain("Duplicate is cheaper than regenerate");
    expect(JSON.stringify(playbook.verificationRitual)).toContain("summer_snapshot_diff");
    expect(JSON.stringify(playbook.libraryFeedback)).toContain("summer_library_feedback");
    expect(text).not.toContain("summer_record_feedback");

    // The kept sections survived the restructure.
    for (const kept of ["honestyRules", "projectBinding", "recovery", "verificationLadder", "rawOpsViaBatch", "scripting", "safeDefaults"]) {
      expect(playbook[kept], kept).toBeDefined();
    }
    expect(text).toContain("target_size");
  });

  it("registers the playbook as an MCP prompt with the same content", async () => {
    const prompts: Array<{
      name: string;
      config: { title?: string; description?: string };
      handler: () => Promise<{ messages: Array<{ role: string; content: { type: string; text: string } }> }>;
    }> = [];
    registerPlaybookPrompt({
      registerPrompt(name: string, config: never, handler: never) {
        prompts.push({ name, config, handler });
        return { name };
      },
    } as never);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.name).toBe("summer_agent_playbook");
    expect(prompts[0]!.config.description).toContain("observe-first");

    const result = await prompts[0]!.handler();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.content.type).toBe("text");
    expect(result.messages[0]!.content.text).toContain("step0_observeFirst");
    expect(result.messages[0]!.content.text).toContain("4_scripting_LAST_RESORT");
  });

  it("surfaces a one-line capability skew warning in project context when the engine advertises fewer ops", async () => {
    vi.mocked(getClient).mockResolvedValue({
      health: vi.fn(async () => ({
        ok: true,
        capabilities: { protocolVersion: 1, opKinds: ["AddNode", "SetProp"] },
      })),
      getProjectState: vi.fn(async () => ({ ok: true, data: { entries: [] } })),
      getSceneState: vi.fn(async () => ({ ok: true, data: {} })),
      rebind: vi.fn(async () => "test-project-hash"),
    } as never);

    const { server, tools } = createFakeServer();
    registerProjectTools(server as never);
    const contextTool = getTool(tools, "summer_get_project_context");
    const body = parseToolResult(await contextTool.handler({}));

    expect(body.capabilitySkewWarning).toBeDefined();
    expect(String(body.capabilitySkewWarning)).toContain("GetWorldSnapshot");
    expect(String(body.capabilitySkewWarning)).toContain("Non-fatal");
  });

  it("stays silent about capabilities on engines that do not advertise them", async () => {
    vi.mocked(getClient).mockResolvedValue({
      health: vi.fn(async () => ({ ok: true })),
      getProjectState: vi.fn(async () => ({ ok: true, data: { entries: [] } })),
      getSceneState: vi.fn(async () => ({ ok: true, data: {} })),
      rebind: vi.fn(async () => "test-project-hash"),
    } as never);

    const { server, tools } = createFakeServer();
    registerProjectTools(server as never);
    const contextTool = getTool(tools, "summer_get_project_context");
    const body = parseToolResult(await contextTool.handler({}));

    expect(body.capabilitySkewWarning).toBeUndefined();
  });
});

describe("playbook step 0 survives engines without the perception ops", () => {
  it("makes summer_world_snapshot conditional on the GetWorldSnapshot advert and names the fallback", () => {
    const step0 = JSON.stringify(buildAgentPlaybook().step0_observeFirst);
    expect(step0).toContain("GetWorldSnapshot");
    expect(step0).toContain("summer_get_scene_tree");
    expect(step0).toContain("engine_lacks_op");
    // Not an unconditional "call it before and after every batch".
    expect(step0).not.toMatch(/Then call summer_world_snapshot/);
  });

  it("names only real summer_search_assets sources (library | my_assets | all)", () => {
    const text = JSON.stringify(buildAgentPlaybook());
    expect(text).not.toContain("community");
    expect(text).toContain("library | my_assets | all");
  });
});
