import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { loadLibraryIndex } from "../core/library-search.js";
import { createMcpServer } from "./server.js";
import {
  ANNOTATION_REFINEMENTS,
  OUTPUT_CAPS,
  PROFILE_TOOL_LIMIT,
  PROFILES,
  SINGLE_EDIT_TOOLS,
  BATCH_EDIT_TOOLS,
  resolveToolSelection,
  selectionIncludes,
  SUPERSEDED_HOSTED_TOOLS,
  toolsetOf,
  type ToolSelection,
} from "./tool-surface.js";

async function listTools(selection?: ToolSelection): Promise<Tool[]> {
  const { server } = createMcpServer(selection);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "surface-test", version: "1.0.0" });
  await client.connect(clientSide);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

const registryTools = new Map(
  loadLibraryIndex()
    .filter((entry) => entry.kind === "tool" && entry.mcp_tool_name)
    .map((entry) => [entry.mcp_tool_name!, entry])
);

describe("tool annotations", () => {
  it("every registered local tool carries all four effect hints", async () => {
    const tools = await listTools();
    expect(tools.length).toBe(registryTools.size);
    const missing = tools.filter((tool) => {
      const hints = tool.annotations ?? {};
      return (["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const).some(
        (key) => typeof hints[key] !== "boolean"
      );
    });
    expect(missing.map((tool) => tool.name)).toEqual([]);
  });

  it("maps the registry authority to the hints", async () => {
    const byName = new Map((await listTools()).map((tool) => [tool.name, tool.annotations!]));
    // Reads: no authority flag.
    expect(byName.get("summer_get_scene_tree")).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(byName.get("summer_search_assets")).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    // Opening a summerengine.com page in the browser reaches outside the machine.
    expect(byName.get("summer_open")).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    // A render for the agent is a read even though it writes an image file.
    expect(byName.get("summer_screenshot")).toMatchObject({ readOnlyHint: true });
    // Adds vs changes.
    expect(byName.get("summer_add_node")).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(byName.get("summer_remove_node")).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.get("summer_set_prop")).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    expect(byName.get("summer_run_script")).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
    // Spending credits and publishing reach Summer's servers.
    expect(byName.get("summer_generate_3d")).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    expect(byName.get("summer_publish_build")).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  });

  it("names only real tools in the refinement and surface tables", () => {
    const named = [...ANNOTATION_REFINEMENTS, ...OUTPUT_CAPS.keys(), ...SINGLE_EDIT_TOOLS, ...BATCH_EDIT_TOOLS];
    expect(named.filter((name) => !registryTools.has(name))).toEqual([]);
  });

  it("never marks a tool with an editor, file or publish authority read-only unless it only renders", async () => {
    const tools = await listTools();
    const renders = new Set(["summer_screenshot", "summer_debug_views", "summer_shot_sheet", "summer_zoom", "summer_scene_audit", "summer_game_probe", "summer_capture_gameplay", "summer_app_screenshot"]);
    const wrong = tools.filter((tool) => {
      const authority = registryTools.get(tool.name)!.authority ?? {};
      const touches = authority.editor_mutation || authority.filesystem || authority.publish;
      return touches && tool.annotations?.readOnlyHint && !renders.has(tool.name);
    });
    expect(wrong.map((tool) => tool.name)).toEqual([]);
  });
});

describe("profiles and toolsets", () => {
  it("defaults to the full profile with every toolset", () => {
    expect(resolveToolSelection({}, {})).toEqual({ profile: "full", toolsets: null, ignored: [] });
    expect(resolveToolSelection({ profile: "full", toolsets: "ui" }, {}).toolsets).toBeNull();
    expect(resolveToolSelection({ toolsets: "all" }, {}).toolsets).toBeNull();
  });

  it("reads flags first, then SUMMER_PROFILE and SUMMER_TOOLSETS, and ignores unknown names", () => {
    const fromEnv = resolveToolSelection({}, { SUMMER_PROFILE: "engine", SUMMER_TOOLSETS: "ui, nope" });
    expect(fromEnv.profile).toBe("engine");
    expect([...fromEnv.toolsets!].sort()).toEqual(["assets", "core", "engine", "ship", "ui"]);
    expect(fromEnv.ignored).toEqual(["nope"]);
    expect(resolveToolSelection({ profile: "assets" }, { SUMMER_PROFILE: "engine" }).profile).toBe("assets");
    expect(resolveToolSelection({ profile: "typo" }, {})).toEqual({ profile: "full", toolsets: null, ignored: ["typo"] });
    const custom = resolveToolSelection({ toolsets: "engine" }, {});
    expect(custom.profile).toBe("custom");
    expect([...custom.toolsets!].sort()).toEqual(["core", "engine"]);
  });

  it("classifies hosted tools by name and keeps local names local", () => {
    expect(toolsetOf("summer_store_submit", false)).toBe("ship");
    expect(toolsetOf("summer_store_version_begin_upload", false)).toBe("uploads");
    expect(toolsetOf("summer_tool_sfx_maker", false)).toBe("tools");
    expect(toolsetOf("summer_grow_prices", false)).toBe("grow");
    expect(toolsetOf("summer_board_read", false)).toBe("board");
    expect(toolsetOf("summer_account", false)).toBe("core");
    expect(toolsetOf("summer_game", false)).toBe("cloud");
    expect(toolsetOf("summer_something_new", false)).toBe("other");
    // A hosted copy of a local tool belongs where the local one does.
    expect(toolsetOf("summer_generate_image", false)).toBe("assets");
    expect(toolsetOf("summer_game_probe", true)).toBe("engine");
    expect(toolsetOf("summer_app_call", true)).toBe("apps");
  });

  it("a limited profile leaves out the hosted status tools summer_go_live supersedes; the full profile keeps them", () => {
    const engine = resolveToolSelection({ profile: "engine" }, {});
    const full = resolveToolSelection({}, {});
    for (const name of SUPERSEDED_HOSTED_TOOLS) {
      expect(selectionIncludes(engine, name, false), name).toBe(false);
      expect(selectionIncludes(full, name, false), name).toBe(true);
    }
    expect(selectionIncludes(engine, "summer_store_get_listing", false)).toBe(true);
    expect(selectionIncludes(engine, "summer_go_live", true)).toBe(true);
  });

  it("engine profile keeps every engine tool registered at start and leaves room for hosted store tools", async () => {
    const tools = await listTools(resolveToolSelection({ profile: "engine" }, {}));
    const names = new Set(tools.map((tool) => tool.name));
    for (const name of ["summer_get_project_context", "summer_set_prop", "summer_run_script", "summer_screenshot", "summer_play", "summer_generate_image", "summer_export_game", "summer_publish_build", "summer_search_library"]) {
      expect(names.has(name), name).toBe(true);
    }
    expect([...names].some((name) => name.startsWith("summer_app_"))).toBe(false);
    expect(names.has("summer_ui_activate")).toBe(false);
    // Hosted store, account and asset tools mount on top: 25 in this profile's
    // toolsets, less the two status tools summer_go_live supersedes here.
    expect(tools.length).toBeLessThanOrEqual(PROFILE_TOOL_LIMIT - 23);
  });

  it("assets profile has no tool that needs a running engine", async () => {
    const tools = await listTools(resolveToolSelection({ profile: "assets" }, {}));
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["summer_generate_audio", "summer_search_assets", "summer_search_library", "summer_read_library", "summer_check_job"]));
    // summer_open opens summerengine.com pages without an engine; editor targets need one.
    const needsEngine = names.filter((name) => registryTools.get(name)?.remote === false && name !== "summer_open");
    expect(needsEngine).toEqual([]);
  });

  it("every profile names known toolsets", () => {
    for (const toolsets of Object.values(PROFILES)) {
      for (const toolset of toolsets) expect(PROFILES.full).toContain(toolset);
    }
  });
});
