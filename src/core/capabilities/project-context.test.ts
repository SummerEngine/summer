import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECT_CONTEXT_SETTINGS_EXCLUDED,
  DEFAULT_PROJECT_CONTEXT_SETTINGS_PREFIXES,
  buildProjectContext,
  projectContextInputSchema,
  resolveSettingsSelection,
  trimProjectSettings,
  type ProjectContextClient,
} from "./project-context.js";
import { dispatchTool } from "./tool-dispatch.js";

const ENTRIES = [
  { key: "application/config/name", value: "Memory Test" },
  { key: "application/run/main_scene", value: "res://main.tscn" },
  { key: "display/window/size/viewport_width", value: 1920 },
  { key: "display/mouse_cursor/custom_image", value: "" },
  { key: "input/jump", value: { deadzone: 0.5, events: ["InputEventKey: keycode=32 (Space)"] } },
  { key: "input/ui_accept", value: { deadzone: 0.5, events: ["InputEventKey: keycode=4194309 (Enter)"] } },
  { key: "physics/3d/default_gravity", value: 9.8 },
  { key: "physics/3d/sleep_threshold_linear", value: 0.1 },
  { key: "rendering/renderer/rendering_method", value: "forward_plus" },
  { key: "rendering/textures/canvas_textures/default_texture_filter", value: 1 },
  { key: "rendering/anti_aliasing/quality/msaa_3d", value: 0 },
  { key: "audio/buses/default_bus_layout", value: "res://bus.tres" },
  { key: "layer_names/2d_physics/layer_1", value: "world" },
  { key: "editor/naming/scene_name_casing", value: 2 },
];

function fakeClient(overrides: Partial<ProjectContextClient> = {}): ProjectContextClient & {
  prefixes: Array<string | undefined>;
} {
  const prefixes: Array<string | undefined> = [];
  return {
    prefixes,
    health: async () => ({ ok: true, version: "0.5.65", project_path: null }),
    getProjectState: async (prefix?: string) => {
      prefixes.push(prefix);
      return { ok: true, data: { entries: ENTRIES } };
    },
    getSceneState: async () => ({ ok: true, provenance: { scenePath: "res://main.tscn" }, data: {} }),
    rebind: async () => "hash-1",
    ...overrides,
  };
}

let tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "summer-context-"));
  tempDirs.push(dir);
  return dir;
}

describe("settings selection", () => {
  it("defaults to the curated groups with the ui_* exclusion; explicit prefixes replace both", () => {
    expect(resolveSettingsSelection({})).toEqual({
      prefixes: DEFAULT_PROJECT_CONTEXT_SETTINGS_PREFIXES,
      excluded: DEFAULT_PROJECT_CONTEXT_SETTINGS_EXCLUDED,
      explicit: false,
    });
    expect(resolveSettingsSelection({ settingsPrefix: "audio/", settingsPrefixes: ["layer_names/", "audio/", " "] })).toEqual({
      prefixes: ["audio/", "layer_names/"],
      excluded: [],
      explicit: true,
      settingsPrefix: "audio/",
    });
    expect(resolveSettingsSelection({ settingsPrefixes: ["audio/"] })).not.toHaveProperty("settingsPrefix");
    // Blank strings are "not given", not "match everything".
    expect(resolveSettingsSelection({ settingsPrefix: "", settingsPrefixes: [""] }).explicit).toBe(false);
  });

  it("the default trim keeps what an agent acts on, drops Godot's ui_* actions, and declares every part of the trim", () => {
    const trimmed = trimProjectSettings({ ok: true, data: { entries: ENTRIES } }, resolveSettingsSelection({})) as {
      data: Record<string, unknown> & { entries: Array<{ key: string }> };
    };
    expect(trimmed.data.entries.map((entry) => entry.key)).toEqual([
      "application/config/name",
      "application/run/main_scene",
      "display/window/size/viewport_width",
      "input/jump",
      "physics/3d/default_gravity",
      "rendering/renderer/rendering_method",
      "rendering/textures/canvas_textures/default_texture_filter",
    ]);
    expect(trimmed.data).toMatchObject({
      settingsTruncated: true,
      totalSettings: ENTRIES.length,
      returnedSettings: 7,
      settingsPrefixesIncluded: [...DEFAULT_PROJECT_CONTEXT_SETTINGS_PREFIXES],
      settingsPrefixesExcluded: ["input/ui_"],
    });
    expect(String(trimmed.data.settingsHint)).toContain("settingsPrefixes");
    expect(String(trimmed.data.settingsHint)).toContain(String(ENTRIES.length));
  });

  it("explicit prefixes are honoured verbatim (no exclusion) and echoed", () => {
    const trimmed = trimProjectSettings(
      { ok: true, data: { entries: ENTRIES } },
      resolveSettingsSelection({ settingsPrefixes: ["input/ui_", "layer_names/"] })
    ) as { data: Record<string, unknown> & { entries: Array<{ key: string }> } };
    expect(trimmed.data.entries.map((entry) => entry.key)).toEqual(["input/ui_accept", "layer_names/2d_physics/layer_1"]);
    expect(trimmed.data.settingsPrefixesIncluded).toEqual(["input/ui_", "layer_names/"]);
    expect(trimmed.data).not.toHaveProperty("settingsPrefixesExcluded");
    expect(trimmed.data.settingsTruncated).toBe(true);
  });

  it("leaves a state without data.entries untouched", () => {
    const odd = { ok: false, error: "no project" };
    expect(trimProjectSettings(odd, resolveSettingsSelection({}))).toBe(odd);
  });

  it("schema: both arguments optional, strict, array of strings", () => {
    expect(projectContextInputSchema.safeParse({}).success).toBe(true);
    expect(projectContextInputSchema.safeParse({ settingsPrefixes: ["audio/"] }).success).toBe(true);
    expect(projectContextInputSchema.safeParse({ settingsPrefixes: "audio/" }).success).toBe(false);
    expect(projectContextInputSchema.safeParse({ prefix: "audio/" }).success).toBe(false);
  });
});

describe("buildProjectContext", () => {
  it("derives mainScene/projectName from the UNtrimmed state even under a narrow prefix", async () => {
    const client = fakeClient();
    const payload = await buildProjectContext(client, { settingsPrefix: "audio/" });
    expect(payload.mainScene).toBe("res://main.tscn");
    expect(payload.projectName).toBe("Memory Test");
    expect(payload.currentScene).toBe("res://main.tscn");
    expect(payload.boundProjectIdHash).toBe("hash-1");
    const data = (payload.project as { data: { entries: Array<{ key: string }>; settingsPrefix: string } }).data;
    expect(data.entries.map((entry) => entry.key)).toEqual(["audio/buses/default_bus_layout"]);
    expect(data.settingsPrefix).toBe("audio/");
    // The single prefix still rides the engine query for forward-compat.
    expect(client.prefixes).toEqual(["audio/"]);
    expect(payload.guidance).toContain("summer_open_scene");
    expect(payload.summerUpdateNotice).toBeNull();
  });

  it("surfaces the template pin from .summer/project.json inside projectMemory", async () => {
    const project = makeProject();
    mkdirSync(join(project, ".summer"), { recursive: true });
    writeFileSync(
      join(project, ".summer", "project.json"),
      JSON.stringify({
        template: {
          id: "template/2d-platformer",
          version: "1.0.0",
          repo: "https://github.com/SummerEngine/template-2d-platformer",
          commit: "66fc71b8edcd1c7023b890c7c0ef7cc55d80748e",
          tree_digest: "76ac4aee9a8a9d4d9ced0a3bc7b0cab76a4fc6eefd04403df967890c05a34c6c",
        },
        toolkit_version: "2.8.2",
        created_at: "2026-09-03T16:45:18.505Z",
      })
    );
    const client = fakeClient({
      health: async () => ({ ok: true, version: "0.5.65", project_path: project }),
    });
    const payload = await buildProjectContext(client, {});
    expect(payload.projectPath).toBe(project);
    expect(payload.projectMemory.present).toBe(true);
    expect(payload.projectMemory.pin).toEqual({
      path: ".summer/project.json",
      template: expect.objectContaining({ id: "template/2d-platformer", version: "1.0.0", commit: "66fc71b8edcd1c7023b890c7c0ef7cc55d80748e" }),
      toolkit_version: "2.8.2",
      engine_version: null,
      created_at: "2026-09-03T16:45:18.505Z",
    });
  });

  it("passes the MCP-only extras through and reports capability skew via the callback only", async () => {
    const warnings: string[] = [];
    const client = fakeClient({
      health: async () => ({
        ok: true,
        version: "0.5.65",
        capabilities: { protocolVersion: 1, opKinds: ["AddNode"] },
      }),
    });
    const payload = await buildProjectContext(client, {}, {
      summerUpdateNotice: "update available",
      onCapabilitySkew: (warning) => warnings.push(warning),
    });
    expect(payload.summerUpdateNotice).toBe("update available");
    expect(typeof payload.capabilitySkewWarning).toBe("string");
    expect(warnings).toEqual([payload.capabilitySkewWarning]);
  });

  it("reports trajectory_eval_mode only while SUMMER_TRAJECTORY_DIR + SUMMER_TRAJECTORY_EVAL=1 are set (one flag, both faces)", async () => {
    const saved = { dir: process.env.SUMMER_TRAJECTORY_DIR, eval: process.env.SUMMER_TRAJECTORY_EVAL };
    try {
      delete process.env.SUMMER_TRAJECTORY_DIR;
      delete process.env.SUMMER_TRAJECTORY_EVAL;
      expect(await buildProjectContext(fakeClient())).not.toHaveProperty("trajectory_eval_mode");
      process.env.SUMMER_TRAJECTORY_DIR = makeProject();
      expect(await buildProjectContext(fakeClient())).not.toHaveProperty("trajectory_eval_mode");
      process.env.SUMMER_TRAJECTORY_EVAL = "1";
      expect((await buildProjectContext(fakeClient())).trajectory_eval_mode).toBe(true);
    } finally {
      if (saved.dir === undefined) delete process.env.SUMMER_TRAJECTORY_DIR; else process.env.SUMMER_TRAJECTORY_DIR = saved.dir;
      if (saved.eval === undefined) delete process.env.SUMMER_TRAJECTORY_EVAL; else process.env.SUMMER_TRAJECTORY_EVAL = saved.eval;
    }
  });

  it("the CLI face returns exactly the builder's payload (one behavior, two faces)", async () => {
    const client = fakeClient();
    const viaBuilder = await buildProjectContext(client, {}, { summerUpdateNotice: null });
    const viaCli = await dispatchTool("get-project-context", {}, { engine: async () => client as never });
    expect(viaCli).toEqual(viaBuilder);
    for (const key of ["guidance", "fileEditingGuidance", "projectMemory", "summerUpdateNotice", "mainScene"]) {
      expect(viaCli).toHaveProperty(key);
    }
    const data = (viaCli as { project: { data: Record<string, unknown> } }).project.data;
    expect(data.settingsTruncated).toBe(true);
    expect(data.totalSettings).toBe(ENTRIES.length);
  });

  it("the CLI face validates settingsPrefixes with the same schema", async () => {
    const client = fakeClient();
    await expect(
      dispatchTool("get-project-context", { settingsPrefixes: "audio/" }, { engine: async () => client as never })
    ).rejects.toThrow(/Invalid arguments for get-project-context/);
    const payload = (await dispatchTool(
      "get-project-context",
      { settingsPrefixes: ["audio/", "layer_names/"] },
      { engine: async () => client as never }
    )) as { project: { data: { entries: Array<{ key: string }> } } };
    expect(payload.project.data.entries.map((entry) => entry.key)).toEqual([
      "audio/buses/default_bus_layout",
      "layer_names/2d_physics/layer_1",
    ]);
  });
});
