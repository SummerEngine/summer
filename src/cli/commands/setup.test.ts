import { isAbsolute } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupCommand } from "./setup.js";

// `summer setup` always ends with a doctor pass (network + engine probes);
// stub it so the command runs offline. `--print` already keeps the skills
// step in dry-run mode, so nothing else touches the machine.
vi.mock("../../core/capabilities/doctor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/capabilities/doctor.js")>();
  return {
    ...actual,
    runDoctor: vi.fn(async () => ({
      ok: true,
      checks: [],
      summary: { ok: 0, warnings: 0, failures: 0 },
    })),
  };
});

const originalSummerDev = process.env.SUMMER_DEV;

beforeEach(() => {
  delete process.env.SUMMER_DEV;
});

afterEach(() => {
  if (originalSummerDev === undefined) delete process.env.SUMMER_DEV;
  else process.env.SUMMER_DEV = originalSummerDev;
});

async function printedSnippet(args: string[]): Promise<{ command: string; args: string[] }> {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  try {
    // commander keeps parsed option values on the shared command object; reset
    // the flag under test so each case sees only its own argv.
    setupCommand.setOptionValue("localDev", undefined);
    await setupCommand.parseAsync(args, { from: "user" });
  } finally {
    log.mockRestore();
  }
  const snippet = JSON.parse(lines.join("\n")) as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  return snippet.mcpServers["summer-engine"]!;
}

describe("summer setup: preview skills install by default", () => {
  it("--stable-only is the visible opt-out", () => {
    const option = setupCommand.options.find((entry) => entry.long === "--stable-only");
    expect(option).toBeDefined();
    expect(option?.hidden).toBeFalsy();
    expect(setupCommand.helpInformation()).toContain("--stable-only");
  });

  it("--include-preview is still accepted as a hidden no-op alias (one release)", async () => {
    const option = setupCommand.options.find((entry) => entry.long === "--include-preview");
    expect(option).toBeDefined();
    expect(option?.hidden).toBe(true);
    expect(setupCommand.helpInformation()).not.toContain("--include-preview");
    // Old scripts keep parsing; the flag changes nothing.
    const server = await printedSnippet(["claude-code", "--include-preview", "--print"]);
    expect(server.args).toContain("mcp");
  });
});

describe("summer setup --local-dev", () => {
  it("is a visible, documented option", () => {
    const option = setupCommand.options.find((entry) => entry.long === "--local-dev");
    expect(option).toBeDefined();
    expect(option?.hidden).toBeFalsy();
    expect(setupCommand.helpInformation()).toContain("--local-dev");
    expect(setupCommand.helpInformation()).toContain("dist/bin/summer.js");
  });

  it("--print emits node + the absolute path of this checkout's built CLI", async () => {
    const server = await printedSnippet(["claude-code", "--local-dev", "--print"]);
    expect(server.command).toBe("node");
    expect(server.args).toHaveLength(2);
    expect(isAbsolute(server.args[0]!)).toBe(true);
    expect(server.args[0]).toMatch(/[\\/]bin[\\/]summer\.js$/);
    expect(server.args[1]).toBe("mcp");
  });

  it("SUMMER_DEV=1 has the same effect", async () => {
    process.env.SUMMER_DEV = "1";
    const server = await printedSnippet(["claude-code", "--print"]);
    expect(server.command).toBe("node");
    expect(server.args[1]).toBe("mcp");
  });

  it("without the flag the entry is the published package", async () => {
    const server = await printedSnippet(["claude-code", "--print"]);
    expect(server.command).toBe("npx");
    expect(server.args).toEqual(["-y", "summer-engine@latest", "mcp"]);
  });
});
