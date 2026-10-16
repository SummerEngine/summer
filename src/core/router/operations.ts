import { resolveGatewayUrl } from "../config.js";
import { engineSelectionFromEnv } from "../engine.js";
import { errorAnswer, type Answer } from "../ops/contract.js";
import { answerOfHosted, callHostedV4 } from "../ops/cloud.js";
import { createRouterApi } from "./api.js";
import { addCharacter, check, pull, push, type RouterContext } from "./commands.js";
import { doctor } from "./doctor.js";
import type { RouterAnswer } from "./result.js";
import { setup } from "./setup.js";

/**
 * The Summer Router local operations, one function each, shared by the MCP
 * tools (src/mcp/tools/router-tools.ts) and `summer tool` / `summer router
 * <action>` (core/capabilities/tool-dispatch.ts). Their names and inputs are
 * the library descriptors library/tools/router-<action>/resource.yaml.
 *
 *   router.setup          summer_router_setup          {agent?, yes?}
 *   router.add_character  summer_router_add_character  {id, template?, name?, voice?, voiceId?, tools?, force?, project?}
 *   router.check          summer_router_check          {characters?, project?}
 *   router.push           summer_router_push           {characters?, force?, gameId?, project?}
 *   router.pull           summer_router_pull           {characters?, force?, gameId?, project?}
 *   router.doctor         summer_router_doctor         {gameId?, project?}
 */

export interface ProjectInput {
  /** The folder with project.godot. Default: the MCP's bound project, then the working directory. */
  project?: string;
  /** The game on Summer. Default: SUMMER_GAME_ID, then gameId in summer.build.json. */
  gameId?: string;
}

/** A cloud operation through the hosted server's summer_call, with the person's sign-in. */
async function hosted(op: string, input: Record<string, unknown>, idempotencyKey: string): Promise<Answer> {
  try {
    return answerOfHosted(await callHostedV4("summer_call", { op, input, idempotencyKey }));
  } catch (error) {
    return errorAnswer("unavailable", error instanceof Error ? error.message : String(error));
  }
}

export function routerContext(input: ProjectInput): RouterContext {
  return {
    cwd: engineSelectionFromEnv()?.projectPath || process.cwd(),
    env: process.env,
    api: createRouterApi(),
    gateway: () => resolveGatewayUrl(),
    hosted,
    project: input.project,
    game: input.gameId,
  };
}

/** A list of ids: an array, or comma-separated text (`--tools open_gate,give_key`); ids never hold a comma. */
const strings = (value: unknown): string[] | undefined => {
  const items = Array.isArray(value) ? value : typeof value === "string" ? [value] : undefined;
  return items?.filter((item): item is string => typeof item === "string").flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean);
};
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);

export const ROUTER_OPERATIONS = {
  summer_router_setup: (args: Record<string, unknown>): Promise<RouterAnswer> => setup({ agent: text(args.agent), yes: args.yes === true }),
  summer_router_add_character: (args: Record<string, unknown>): Promise<RouterAnswer> =>
    addCharacter(routerContext({ project: text(args.project) }), {
      id: String(args.id ?? ""),
      template: text(args.template),
      name: text(args.name),
      voice: text(args.voice),
      voiceId: text(args.voiceId),
      tools: strings(args.tools),
      force: args.force === true,
    }),
  summer_router_check: (args: Record<string, unknown>): Promise<RouterAnswer> =>
    check(routerContext({ project: text(args.project) }), { characters: strings(args.characters) }),
  summer_router_push: (args: Record<string, unknown>): Promise<RouterAnswer> =>
    push(routerContext({ project: text(args.project), gameId: text(args.gameId) }), { characters: strings(args.characters), force: args.force === true }),
  summer_router_pull: (args: Record<string, unknown>): Promise<RouterAnswer> =>
    pull(routerContext({ project: text(args.project), gameId: text(args.gameId) }), { characters: strings(args.characters), force: args.force === true }),
  summer_router_doctor: (args: Record<string, unknown>): Promise<RouterAnswer> => doctor(routerContext({ project: text(args.project), gameId: text(args.gameId) })),
} as const;

export type RouterToolName = keyof typeof ROUTER_OPERATIONS;
