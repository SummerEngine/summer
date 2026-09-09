import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRootAction } from "./root-action.js";

let errors: string[] = [];
let intro = 0;
const originalExitCode = process.exitCode;

function buildProgram(): Command {
  const program = new Command("summer").exitOverride();
  program.addCommand(new Command("status").action(() => {}));
  program.action((_opts: unknown, command: Command) => {
    runRootAction(command.args, () => {
      intro += 1;
    });
  });
  return program;
}

beforeEach(() => {
  errors = [];
  intro = 0;
  process.exitCode = undefined;
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
});

describe("summer root action", () => {
  it("prints the intro and exits 0 for a true no-args invocation", async () => {
    await buildProgram().parseAsync([], { from: "user" });
    expect(intro).toBe(1);
    expect(process.exitCode).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it("fails with exit code 1 on an unknown command instead of printing the intro", async () => {
    await buildProgram().parseAsync(["bogus"], { from: "user" });
    expect(intro).toBe(0);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("unknown command 'bogus'");
  });
});
