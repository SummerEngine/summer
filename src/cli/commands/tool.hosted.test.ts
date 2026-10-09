import { afterEach, describe, expect, it, vi } from "vitest";
import { formatHostedToolList, hostedCli, toolCommand } from "./tool.js";

async function run(argv: string[]) {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    let thrown: unknown = null;
    await toolCommand.parseAsync(argv, { from: "user" }).catch((error: unknown) => {
      thrown = error;
    });
    return { exitCode: process.exitCode, output: lines.join("\n"), thrown };
  } finally {
    process.exitCode = previousExitCode;
    log.mockRestore();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("summer tool reaches the hosted store and publishing tools", () => {
  it("calls a hosted tool when the name is not a local one", async () => {
    const call = vi.spyOn(hostedCli, "call").mockResolvedValue({
      status: "called",
      tool: "summer_store_list_games",
      result: { content: [{ type: "text", text: JSON.stringify({ games: [{ gameId: "g1" }] }) }] },
    });
    const { exitCode, output } = await run(["summer_store_list_games", "--args", "{}"]);
    expect(call).toHaveBeenCalledWith("summer_store_list_games", {});
    expect(exitCode).toBeUndefined();
    expect(JSON.parse(output)).toEqual({ games: [{ gameId: "g1" }] });
  });

  it("exits 1 when the hosted tool answers with an error", async () => {
    vi.spyOn(hostedCli, "call").mockResolvedValue({
      status: "called",
      tool: "summer_store_list_games",
      result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "not_signed_in", status: 401 }) }] },
    });
    const { exitCode, output } = await run(["store-list-games"]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(output)).toMatchObject({ error: "not_signed_in" });
  });

  it("says how to sign in when an unknown name could be a hosted tool", async () => {
    vi.spyOn(hostedCli, "call").mockResolvedValue({ status: "not_signed_in" });
    const { thrown } = await run(["summer_store_list_games"]);
    expect(String((thrown as Error).message)).toContain("summer login --store");
  });

  it("lists the hosted tools after the local ones, or how to get them", () => {
    expect(formatHostedToolList({ status: "not_signed_in" })).toContain("summer login --store");
    const listed = formatHostedToolList({
      status: "listed",
      tools: [
        { name: "summer_store_submit", description: "Ask the owner to publish. More text.", inputSchema: { type: "object" } },
        // A local tool of the same name stays local and is not listed twice.
        { name: "summer_generate_image", description: "Hosted.", inputSchema: { type: "object" } },
      ],
    });
    expect(listed).toContain("Store and publishing tools (1");
    expect(listed).toContain("summer_store_submit  Ask the owner to publish.");
    expect(listed).not.toContain("summer_generate_image");
  });
});
