import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configCommand } from "./commands/config.js";
import { createCommand } from "./commands/create.js";
import { debugCommand } from "./commands/debug.js";
import { doctorCommand } from "./commands/doctor.js";
import { eventsCommand } from "./commands/events.js";
import { installCommand } from "./commands/install.js";
import { listCommand } from "./commands/list.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { memoryCommand } from "./commands/memory.js";
import { openCommand } from "./commands/open.js";
import { opsCliCommands } from "./commands/ops.js";
import { planCommand } from "./commands/plan.js";
import { previewCommand } from "./commands/preview.js";
import { runCommand } from "./commands/run.js";
import { setupCommand } from "./commands/setup.js";
import { skillsCommand } from "./commands/skills.js";
import { statusCommand } from "./commands/status.js";
import { toolCommand } from "./commands/tool.js";

/** Every command that reads something and prints the answer takes --json. */
const READS = [
  "status",
  "list",
  "memory",
  "memory show",
  "memory path",
  "skills list",
  "skills info",
  "doctor",
  "debug",
  "plan",
  "config",
  "config get",
  "events",
  "open",
  "setup",
  "ops search",
  "ops describe",
];

/** The rest, and why --json is not theirs to add. */
const NOT_READS: Record<string, string> = {
  install: "downloads and installs the engine",
  login: "signs in through the browser",
  logout: "removes stored tokens",
  run: "starts the engine",
  create: "creates a project",
  skills: "prints help",
  "skills install": "copies skills into an agent",
  "config set": "changes one value",
  "config unset": "removes one value",
  tool: "prints JSON already; its --json is the deprecated alias of --args",
  preview: "serves a page until stopped; its --json prints the start line as JSON",
  ops: "prints help",
};

/** whoami and `summer <area> <action>` read --json in the operation runner (runOpFromCli). */
const OPERATION_RUNNER = new Set(
  opsCliCommands()
    .map((command) => command.name())
    .filter((name) => name !== "ops")
);

function cliProgram(): Command {
  const root = new Command("summer");
  const commands = [
    installCommand,
    loginCommand,
    logoutCommand,
    statusCommand,
    runCommand,
    openCommand,
    createCommand,
    listCommand,
    memoryCommand,
    skillsCommand,
    setupCommand,
    doctorCommand,
    debugCommand,
    planCommand,
    configCommand,
    eventsCommand,
    previewCommand,
    toolCommand,
    ...opsCliCommands(),
  ];
  for (const command of commands) root.addCommand(command);
  return root;
}

function commandPaths(command: Command, prefix = ""): string[] {
  return command.commands.flatMap((child) => {
    const path = `${prefix}${child.name()}`;
    return [path, ...commandPaths(child, `${path} `)];
  });
}

function findCommand(root: Command, path: string): Command | undefined {
  let command: Command | undefined = root;
  for (const name of path.split(" ")) command = command?.commands.find((child) => child.name() === name);
  return command;
}

afterEach(() => vi.restoreAllMocks());

describe("--json on the CLI", () => {
  it("every read command takes --json, and every command is sorted into reads or not", () => {
    const root = cliProgram();
    const paths = commandPaths(root).filter((path) => !OPERATION_RUNNER.has(path.split(" ")[0]));
    expect(paths.filter((path) => !READS.includes(path) && !(path in NOT_READS))).toEqual([]);
    const withoutJson = READS.filter((path) => !findCommand(root, path)?.options.some((option) => option.long === "--json"));
    expect(withoutJson).toEqual([]);
  });

  it("summer ops describe <op> --json parses and prints one JSON answer (4.0.0 said unknown option)", async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });
    await cliProgram().exitOverride().parseAsync(["ops", "describe", "summer_set_prop", "--json"], { from: "user" });
    expect(JSON.parse(out.join(""))).toMatchObject({
      ok: true,
      status: "done",
      result: { operation: { name: "engine.set_prop" } },
    });
  });
});
