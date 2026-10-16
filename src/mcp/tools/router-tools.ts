import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ROUTER_OPERATIONS, type RouterToolName } from "../../core/router/operations.js";
import { TEMPLATES } from "../../core/router/templates.js";
import { textJson } from "./text-json.js";

/**
 * The Summer Router local operations (router.setup, router.add_character,
 * router.check, router.push, router.pull, router.doctor): they read and write
 * the game project on this machine (ai/characters/<id>.json and its GDScript).
 * On the v4 surface summer_call runs them by operation name; `summer router
 * <action>` runs the same functions. The cloud Router operations (test turns,
 * settings and caps, usage, the catalog) are on the hosted server.
 */

const project = z.string().optional().describe("The folder with project.godot. Default: the MCP's bound project, then the working directory.");
const gameId = z.string().optional().describe("The game on Summer. Default: SUMMER_GAME_ID, then gameId in summer.build.json.");
const characters = z.array(z.string()).optional().describe("Character ids (file names in ai/characters/). Default: every character file.");

function run(name: RouterToolName) {
  return async (args: Record<string, unknown>) => {
    const answer = await ROUTER_OPERATIONS[name](args);
    return textJson(answer, answer.ok === false);
  };
}

export function registerRouterTools(server: McpServer): void {
  server.tool(
    "summer_router_setup",
    "router.setup: make Claude Code or Codex ready for Summer Router: the summer-engine MCP entry (an existing one is kept) and the summer-router and voice-and-mic-permissions skills. Idempotent. Without yes it only returns the plan. Then: summer login, router.add_character.",
    {
      agent: z.enum(["claude-code", "codex"]).optional().describe("The agent to set up. Default: every Claude Code and Codex found on this machine."),
      yes: z.boolean().optional().describe("Apply the plan. Without it nothing is written."),
    },
    run("summer_router_setup")
  );

  server.tool(
    "summer_router_add_character",
    "router.add_character: write ai/characters/<id>.json, a Summer Router character, from a template (voice-npc, shopkeeper, companion). Returns the document, the client tools with no GDScript handler yet, and the GDScript to add (handler_snippet). Then edit the file, router.check, router.push.",
    {
      id: z.string().describe("Character id: a lowercase letter, then lowercase letters, digits, _ or -, at most 64 (for example guard)."),
      template: z.enum(TEMPLATES).optional().describe("Starting point: voice-npc (default), shopkeeper or companion."),
      name: z.string().optional().describe("Display name. Default: from the id."),
      voice: z.string().optional().describe('A voice description, for example "gruff old soldier". Summer makes a pinned voice from it on push.'),
      voiceId: z.string().optional().describe("A Summer voice id instead of a description."),
      tools: z.array(z.string()).optional().describe("Client tools the character may call (for example open_gate). Each needs a GDScript handler."),
      force: z.boolean().optional().describe("Replace an existing file."),
      project,
    },
    run("summer_router_add_character")
  );

  server.tool(
    "summer_router_check",
    "router.check: check ai/characters/*.json against the Summer Router character schema and check that every client tool has a handler in the project's GDScript (tool_unhandled, with the GDScript to add). Offline, no sign-in. Run it before router.push.",
    { characters, project },
    run("summer_router_check")
  );

  server.tool(
    "summer_router_push",
    "router.push: router.check, then save each character on Summer for the game (unchanged ones are skipped). Never overwrites a change made on Summer since the last push or pull (studio_changed: router.pull, or force). A live game's characters need the owner (owner_action_required with studio_url). Then router.test.",
    { characters, force: z.boolean().optional().describe("Replace a character that changed on Summer since the last push or pull."), gameId, project },
    run("summer_router_push")
  );

  server.tool(
    "summer_router_pull",
    "router.pull: write the characters Summer has for the game (for example after a Studio edit) into ai/characters/. Keeps local edits that were never pushed (local_changes) unless force.",
    { characters, force: z.boolean().optional().describe("Replace local edits that were never pushed."), gameId, project },
    run("summer_router_pull")
  );

  server.tool(
    "summer_router_doctor",
    "router.doctor: every Summer Router check in one list: project, game id, sign-in, registry version, characters, GDScript tool handlers, the game on Summer (is Summer Router on?) and the agent skills. Each failed check has a fix.",
    { gameId, project },
    run("summer_router_doctor")
  );
}
