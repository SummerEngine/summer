import type { Command } from "commander";
import { cliCommandName, startCliCommand } from "../core/cli-usage.js";
import { noteFirstRun } from "../core/telemetry.js";
import { CLI_AREAS } from "../core/ops/areas.js";
import { knownOp, resolveCliOp } from "../core/ops/catalog.js";
import { opFromCli } from "../core/ops/contract.js";

/**
 * One usage line per command (core/cli-usage.ts): its name, or for
 * `summer <area> <action>` the operation it runs, never its arguments.
 * `summer mcp` reports its own sessions and tool calls (core/telemetry.ts).
 * The first command on a machine, `summer mcp` too, prints the one-time
 * telemetry notice and sends the anonymous first-run line (noteFirstRun).
 */
export function trackCommandUsage(
  program: Command,
  start: typeof startCliCommand = startCliCommand,
  firstRun: (command: string) => Promise<unknown> = noteFirstRun
): void {
  program.hook("preAction", async (_program, actionCommand) => {
    const path: string[] = [];
    for (let command: Command | null = actionCommand; command && command !== program; command = command.parent) path.unshift(command.name());
    // The first command on this machine prints the telemetry notice (stderr) once.
    await firstRun(path.length ? cliCommandName(path.slice(0, 1)) : "summer");
    if (path.length === 0 || path[0] === "mcp") return;
    const area = path.length === 1 && (CLI_AREAS as readonly string[]).includes(path[0]) ? path[0] : null;
    // Only a real operation: the action is typed by the person and may be anything.
    const action = actionCommand.args[0];
    const op = knownOp(area && action ? resolveCliOp(area, action) : area ? opFromCli(area) : path[0] === "whoami" ? "whoami" : null);
    start(cliCommandName(path), op ?? undefined);
  });
}
