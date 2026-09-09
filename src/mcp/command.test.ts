import { describe, expect, it } from "vitest";
import { mcpCommand } from "./command.js";

describe("summer mcp setup (deprecated alias)", () => {
  const setup = mcpCommand.commands.find((command) => command.name() === "setup");

  it("hides the contributor-only --local-dev flag from the public surface", () => {
    expect(setup).toBeDefined();
    const localDev = setup!.options.find((option) => option.long === "--local-dev");
    expect(localDev).toBeDefined();
    expect(localDev!.hidden).toBe(true);
    expect(setup!.helpInformation()).not.toContain("--local-dev");
  });

  it("says it is an alias of summer setup", () => {
    expect(setup!.description()).toMatch(/deprecated alias of `summer setup <agent>`/i);
  });
});
