import type { Command } from "commander";
import { cliCommandName, startCliCommand } from "../core/cli-usage.js";
import { CLI_AREAS } from "../core/ops/areas.js";
import { knownOp } from "../core/ops/catalog.js";
import { opFromCli } from "../core/ops/contract.js";

/**
 * One usage line per command (core/cli-usage.ts): its name, or for
 * `summer <area> <action>` the operation it runs, never its arguments.
 * `summer mcp` reports its own sessions and tool calls (core/telemetry.ts).
 */
export function trackCommandUsage(program: Command, start: typeof startCliCommand = startCliCommand): void {
  program.hook("preAction", (_program, actionCommand) => {
    const path: string[] = [];
    for (let command: Command | null = actionCommand; command && command !== program; command = command.parent) path.unshift(command.name());
    if (path.length === 0 || path[0] === "mcp") return;
    const area = path.length === 1 && (CLI_AREAS as readonly string[]).includes(path[0]) ? path[0] : null;
    // Only a real operation: the action is typed by the person and may be anything.
    const op = knownOp(area ? opFromCli(area, actionCommand.args[0]) : path[0] === "whoami" ? "whoami" : null);
    start(cliCommandName(path), op ?? undefined);
  });
}
