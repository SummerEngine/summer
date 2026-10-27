import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUMMER_MCP_ASSETS_INSTRUCTIONS, SUMMER_MCP_INSTRUCTIONS, createMcpServer } from "./server.js";
import { getSkillRegistry, selectSkillsForBulkInstall } from "../core/skills-registry.js";
import { resolveToolSelection } from "./tool-surface.js";
import { FIRST_GAME_LOOK_RULE, OPS_MCP_ASSETS_INSTRUCTIONS, OPS_MCP_INSTRUCTIONS } from "./ops-surface.js";
import { EDITOR_CHAT_JOB_SENTENCE, editorChatInstructions } from "../core/editor-chat.js";

describe("MCP server instructions (initialize response)", () => {
  it("is one tight paragraph naming the five first-turn habits", () => {
    expect(SUMMER_MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(800);
    expect(SUMMER_MCP_INSTRUCTIONS).not.toContain("\n");
    for (const tool of [
      "summer_get_project_context",
      "summer_search_library",
      "summer_read_library",
      "summer_get_diagnostics",
      "summer_get_console",
      "summer_library_feedback",
    ]) {
      expect(SUMMER_MCP_INSTRUCTIONS).toContain(tool);
    }
    expect(SUMMER_MCP_INSTRUCTIONS).toMatch(/black screenshot/i);
    expect(SUMMER_MCP_INSTRUCTIONS).toMatch(/recapture/i);
  });

  it("reaches a real client through the initialize handshake", async () => {
    const { server } = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "summer-instructions-test", version: "1.0.0" });
    await server.connect(serverTransport);
    try {
      await client.connect(clientTransport);
      expect(client.getInstructions()).toBe(SUMMER_MCP_INSTRUCTIONS);
      expect(client.getServerVersion()?.name).toBe("summer-engine");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("opens the v4 engine instructions with the first-game look rule, inside the first 512 characters", () => {
    // Codex keeps the first 512 characters; Claude Code cuts each server's instructions at 4,096.
    const start = OPS_MCP_INSTRUCTIONS.indexOf(FIRST_GAME_LOOK_RULE);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(start + FIRST_GAME_LOOK_RULE.length).toBeLessThanOrEqual(512);
    expect(OPS_MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(2048);
    expect(OPS_MCP_INSTRUCTIONS).not.toContain("\n");
    expect(OPS_MCP_INSTRUCTIONS).toContain("summer_get_project_context");
  });

  it("tells an agent to script a run of scene edits", () => {
    expect(SUMMER_MCP_INSTRUCTIONS).toMatch(/More than 3 scene edits: one summer_run_script/);
  });

  it("gives the assets profile instructions that name only tools it has", async () => {
    expect(SUMMER_MCP_ASSETS_INSTRUCTIONS.length).toBeLessThanOrEqual(600);
    const { server } = createMcpServer(resolveToolSelection({ profile: "assets" }, {}));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "summer-instructions-test", version: "1.0.0" });
    await server.connect(serverTransport);
    try {
      await client.connect(clientTransport);
      expect(client.getInstructions()).toBe(SUMMER_MCP_ASSETS_INSTRUCTIONS);
      const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
      const named = SUMMER_MCP_ASSETS_INSTRUCTIONS.match(/summer_[a-z0-9_]+/g) ?? [];
      expect(named.filter((name) => !names.has(name))).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("gives the v4 assets profile instructions that name only tools it has", async () => {
    expect(OPS_MCP_ASSETS_INSTRUCTIONS.length).toBeLessThanOrEqual(600);
    const { server } = createMcpServer(resolveToolSelection({ profile: "assets" }, {}), { surface: "v4" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "summer-instructions-test", version: "1.0.0" });
    await server.connect(serverTransport);
    try {
      await client.connect(clientTransport);
      expect(client.getInstructions()).toBe(OPS_MCP_ASSETS_INSTRUCTIONS);
      const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
      const named = OPS_MCP_ASSETS_INSTRUCTIONS.match(/summer_[a-z0-9_]+/g) ?? [];
      expect(named.filter((name) => !names.has(name))).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("gives the assets profile a task plan and playbook that route only through its own tools and skills", async () => {
    const { server } = createMcpServer(resolveToolSelection({ profile: "assets" }, {}));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "summer-instructions-test", version: "1.0.0" });
    await server.connect(serverTransport);
    try {
      await client.connect(clientTransport);
      const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
      const text = async (name: string, args: Record<string, unknown>) =>
        ((await client.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0].text;
      // The hosted tools (summer_tool_*, summer_store_tools) mount after sign-in, not here.
      const missing = (value: unknown) =>
        (JSON.stringify(value).match(/summer_[a-z0-9_]+/g) ?? []).filter(
          (name) => !names.has(name) && !name.startsWith("summer_tool_") && name !== "summer_store_tools"
        );

      for (const goal of ["make a low-poly treasure chest model", "a sword swing sound", "a rigged knight that can run"]) {
        const plan = JSON.parse(await text("summer_start_game_task", { goal, mode: "asset" }));
        expect(plan.profileNote).toMatch(/no Summer Engine tools/);
        expect(missing(plan.mcpToolPlan)).toEqual([]);
        expect(plan.mcpToolPlan.mutate).toEqual([]);
        const assetSkills = new Set(
          selectSkillsForBulkInstall(getSkillRegistry(), { assetsOnly: true }).selected.map((skill) => skill.name)
        );
        for (const skill of plan.recommendedSkills) expect(assetSkills.has(skill.name)).toBe(true);
        expect(plan.recommendedSkills.map((skill: { name: string }) => skill.name)).toContain("summer-assets");
      }

      const playbook = JSON.parse(await text("summer_get_agent_playbook", {}));
      expect(playbook.profile).toBe("assets");
      expect(missing([playbook.contentRouting, playbook.handOff])).toEqual([]);
      expect(playbook.step0_observeFirst).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("MCP server instructions in the Summer editor chat (SUMMER_EDITOR_CHAT=1)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const JOB_WORDS = /jobs\.wait|jobs\.get|summer_check_job|summer_jobs_wait|summer_jobs_get/;
  const variants = [
    ["v4 engine", OPS_MCP_INSTRUCTIONS],
    ["v4 assets", OPS_MCP_ASSETS_INSTRUCTIONS],
    ["v3 engine", SUMMER_MCP_INSTRUCTIONS],
    ["v3 assets", SUMMER_MCP_ASSETS_INSTRUCTIONS],
  ] as const;

  it.each(variants)("%s: the job sentence becomes the editor chat sentence, and no job tool is named", (_label, text) => {
    const editor = editorChatInstructions(text);
    expect(editor.split(EDITOR_CHAT_JOB_SENTENCE)).toHaveLength(2);
    expect(editor).not.toMatch(JOB_WORDS);
    expect(editor).not.toContain("\n");
    expect(editor.length).toBeLessThanOrEqual(2048);
  });

  it("keeps the first-game look rule inside the first 512 characters of the v4 engine variant", () => {
    const editor = editorChatInstructions(OPS_MCP_INSTRUCTIONS);
    expect(editor.indexOf(FIRST_GAME_LOOK_RULE) + FIRST_GAME_LOOK_RULE.length).toBeLessThanOrEqual(512);
    expect(editor).toBe(OPS_MCP_INSTRUCTIONS.replace("Long work answers with a job: jobs.wait.", EDITOR_CHAT_JOB_SENTENCE));
  });

  it.each([
    ["v4", "full", OPS_MCP_INSTRUCTIONS],
    ["v4", "assets", OPS_MCP_ASSETS_INSTRUCTIONS],
    ["v3", "full", SUMMER_MCP_INSTRUCTIONS],
    ["v3", "assets", SUMMER_MCP_ASSETS_INSTRUCTIONS],
  ] as const)("reaches a real client on %s, %s profile", async (surface, profile, text) => {
    vi.stubEnv("SUMMER_EDITOR_CHAT", "1");
    const { server } = createMcpServer(resolveToolSelection({ profile }, {}), { surface });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "summer-instructions-test", version: "1.0.0" });
    await server.connect(serverTransport);
    try {
      await client.connect(clientTransport);
      expect(client.getInstructions()).toBe(editorChatInstructions(text));
      expect(client.getInstructions()).toContain(EDITOR_CHAT_JOB_SENTENCE);
      expect(client.getInstructions()).not.toMatch(JOB_WORDS);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("sends the usual instructions when the variable is not 1", async () => {
    vi.stubEnv("SUMMER_EDITOR_CHAT", "0");
    const { server } = createMcpServer(resolveToolSelection({ profile: "full" }, {}), { surface: "v4" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "summer-instructions-test", version: "1.0.0" });
    await server.connect(serverTransport);
    try {
      await client.connect(clientTransport);
      expect(client.getInstructions()).toBe(OPS_MCP_INSTRUCTIONS);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
