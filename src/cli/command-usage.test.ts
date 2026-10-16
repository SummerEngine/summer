import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { trackCommandUsage } from "./command-usage.js";

function program(start: (command: string, op?: string) => void): Command {
  const root = new Command("summer").exitOverride();
  const skills = new Command("skills");
  skills.command("install [name]").action(() => undefined);
  root.addCommand(skills);
  root.addCommand(new Command("engine").argument("<action>").allowUnknownOption(true).allowExcessArguments(true).action(() => undefined));
  root.addCommand(new Command("whoami").action(() => undefined));
  root.addCommand(new Command("mcp").action(() => undefined));
  trackCommandUsage(root, start);
  return root;
}

describe("trackCommandUsage", () => {
  it("names the command, or the operation of an area command, and never its arguments", async () => {
    const start = vi.fn();
    await program(start).parseAsync(["skills", "install", "my-private-skill"], { from: "user" });
    await program(start).parseAsync(["engine", "set-prop", "--scene", "res://secret.tscn"], { from: "user" });
    await program(start).parseAsync(["whoami"], { from: "user" });
    expect(start.mock.calls).toEqual([["skills_install", undefined], ["engine", "engine.set_prop"], ["whoami", "whoami"]]);
  });

  it("never sends a typed word as an operation: an action that is no operation reports the area alone", async () => {
    const start = vi.fn();
    await program(start).parseAsync(["engine", "my-secret-game-jane-doe", "--json"], { from: "user" });
    expect(start.mock.calls).toEqual([["engine", undefined]]);
  });

  it("leaves summer mcp to its own session and tool-call lines", async () => {
    const start = vi.fn();
    await program(start).parseAsync(["mcp"], { from: "user" });
    expect(start).not.toHaveBeenCalled();
  });
});
