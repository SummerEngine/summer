import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { resolveGatewayUrl } from "../../core/config.js";
import { createRouterApi } from "../../core/router/api.js";
import {
  characterAdd,
  limitsGet,
  limitsSet,
  logs,
  pull,
  push,
  test,
  type RouterContext,
} from "../../core/router/commands.js";
import { doctor } from "../../core/router/doctor.js";
import { emit, type RouterIo, type RouterOutcome } from "../../core/router/outcome.js";
import { setup } from "../../core/router/setup.js";
import { TEMPLATES } from "../../core/router/templates.js";

/**
 * `summer router`: configure Summer Router (talking characters, speech,
 * transcription and images at runtime) for the game in this folder.
 *
 *   summer router setup --yes
 *   summer router character add guard --template voice-npc --tools open_gate
 *   summer router push [--dry-run]
 *   summer router test guard --say "the password is moon" --expect-tool open_gate
 *
 * Agent mode (--json, piped stdout, or an agent environment): no prompts, one
 * JSON object on stdout, messages on stderr, exit 0 / 1 (failed) / 2 (usage).
 */

interface GlobalOptions {
  json?: boolean;
  game?: string;
  project?: string;
}

export const defaultRouterIo = (): RouterIo => ({
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  isTTY: process.stdout.isTTY === true,
  env: process.env,
});

export function defaultRouterContext(opts: GlobalOptions): RouterContext {
  return {
    cwd: process.cwd(),
    env: process.env,
    api: createRouterApi(),
    gateway: () => resolveGatewayUrl(),
    randomId: () => randomUUID(),
    now: Date.now,
    project: opts.project,
    game: opts.game,
  };
}

/** Tests replace these to run a command against fakes. */
export const routerRuntime = {
  io: defaultRouterIo,
  context: defaultRouterContext,
  exit: (code: number) => {
    process.exitCode = code;
  },
};

function globals(command: Command): GlobalOptions {
  return command.optsWithGlobals() as GlobalOptions;
}

async function run(command: Command, action: (ctx: RouterContext) => Promise<RouterOutcome>): Promise<void> {
  const opts = globals(command);
  const outcome = await action(routerRuntime.context(opts));
  routerRuntime.exit(emit(routerRuntime.io(), outcome, opts.json));
}

const collect = (value: string, previous: string[] = []) => [...previous, value];

export const routerCommand = new Command("router")
  .description("Summer Router: AI characters (text and voice, with tools), speech, transcription and images for your game")
  .option("--json", "Print one JSON object on stdout (the default when stdout is not a terminal)")
  .option("--game <gameId>", "The game on Summer (default: SUMMER_GAME_ID, then gameId in summer.build.json)")
  .option("--project <dir>", "The Summer project folder (default: the nearest folder with project.godot)")
  .action(function (this: Command) {
    this.outputHelp();
  });

routerCommand
  .command("setup")
  .description("Make Claude Code or Codex ready for Summer Router: the summer-engine MCP and the Summer Router skills. Idempotent")
  .option("--yes", "Apply the plan (without it, only print the plan)")
  .option("--agent <agent>", "claude-code or codex (default: every one found on this machine)")
  .action(async function (this: Command, opts: { yes?: boolean; agent?: string }) {
    await run(this, () => setup({ yes: opts.yes, agent: opts.agent }));
  });

const characterCommand = routerCommand
  .command("character")
  .description("Create character files (ai/characters/<id>.json)")
  .action(function (this: Command) {
    this.outputHelp();
  });

characterCommand
  .command("add <id>")
  .description("Write ai/characters/<id>.json from a template")
  .option("--template <template>", `Starting point: ${TEMPLATES.join(", ")}`, "voice-npc")
  .option("--name <name>", "Display name (default: from the id)")
  .option("--voice <description>", 'A voice description, for example "deep, calm, old soldier"')
  .option("--voice-id <id>", "A Summer voice id instead of a description")
  .option("--tools <names>", "Client tools the character may call, comma separated (open_gate,give_key)")
  .option("--force", "Replace an existing file")
  .action(async function (this: Command, id: string, opts: { template?: string; name?: string; voice?: string; voiceId?: string; tools?: string; force?: boolean }) {
    await run(this, (ctx) => characterAdd(ctx, { id, ...opts }));
  });

routerCommand
  .command("push [ids...]")
  .description("Validate characters (schema and GDScript tool handlers), then send them to Summer")
  .option("--dry-run", "Only validate; needs no sign-in")
  .option("--force", "Replace a character that was changed on Summer since the last push or pull")
  .action(async function (this: Command, ids: string[], opts: { dryRun?: boolean; force?: boolean }) {
    await run(this, (ctx) => push(ctx, { ids, ...opts }));
  });

routerCommand
  .command("pull [ids...]")
  .description("Write the characters Summer has (for example after a Studio edit) to ai/characters/")
  .option("--force", "Replace local edits that were never pushed")
  .action(async function (this: Command, ids: string[], opts: { force?: boolean }) {
    await run(this, (ctx) => pull(ctx, { ids, ...opts }));
  });

routerCommand
  .command("test <id>")
  .description("Run one scripted text turn with a pushed character; exits 1 when it errors or skips an expected tool")
  .option("--say <text>", "What the player says")
  .option("--expect-tool <name>", "A tool the character must call (repeat for more)", collect)
  .option("--var <name=value>", "A character variable (repeat for more)", collect)
  .option("--context <text>", "What just happened in the game")
  .action(async function (this: Command, id: string, opts: { say?: string; expectTool?: string[]; var?: string[]; context?: string }) {
    await run(this, (ctx) => test(ctx, { id, say: opts.say, expectTools: opts.expectTool, vars: opts.var, context: opts.context }));
  });

const limitsCommand = routerCommand
  .command("limits")
  .aliases(["caps", "settings"])
  .description("Read or change the game's Summer Router switch and spend caps")
  .action(function (this: Command) {
    this.outputHelp();
  });

limitsCommand
  .command("get")
  .description("The switch, models, caps (US dollars) and how much of each cap is used")
  .action(async function (this: Command) {
    await run(this, (ctx) => limitsGet(ctx));
  });

limitsCommand
  .command("set")
  .description("Change caps (US dollars), the switch or the default models. Only the game's owner can; others get a Studio link")
  .option("--player-day <amount>", "Cap per player per day")
  .option("--game-day <amount>", "Cap per game per day")
  .option("--game-month <amount>", "Cap per game per month")
  .option("--account-month <amount>", "Cap per account per month, across all your games")
  .option("--enabled <on|off>", "Turn Summer Router on or off for this game")
  .option("--text-model <id>", "Default text model id")
  .option("--image-model <id>", "Default image model id")
  .action(async function (this: Command, opts: Record<string, string | undefined>) {
    await run(this, (ctx) => limitsSet(ctx, opts));
  });

routerCommand
  .command("logs")
  .description("Recent Summer Router calls for the game")
  .option("--since <when>", "A duration (10m, 2h, 3d) or a date", "1h")
  .option("--limit <n>", "Most calls to return (1-1000)", "100")
  .option("--character <id>", "Only this character")
  .action(async function (this: Command, opts: { since?: string; limit?: string; character?: string }) {
    await run(this, (ctx) => logs(ctx, opts));
  });

routerCommand
  .command("doctor")
  .description("Check the project, characters, tool handlers, sign-in, the game on Summer and the agent skills")
  .action(async function (this: Command) {
    await run(this, (ctx) => doctor(ctx));
  });
