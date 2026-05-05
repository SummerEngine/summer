import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { configureAgentMcp } from "./agent-config.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "summer-agent-config-"));
}

describe("configureAgentMcp", () => {
  it("writes a fresh claude-code config", async () => {
    const dir = tmp();
    const path = join(dir, ".claude.json");
    const result = await configureAgentMcp({
      agent: "claude-code",
      scope: "user",
      env: { SUMMER_CLAUDE_CONFIG_FILE: path } as NodeJS.ProcessEnv,
    });
    expect(result.wrote).toBe(true);
    const written = JSON.parse(readFileSync(path, "utf-8"));
    expect(written.mcpServers["summer-engine"].command).toBe("npx");
    expect(written.mcpServers["summer-engine"].args).toEqual([
      "summer-engine",
      "mcp",
    ]);
  });

  it("preserves unrelated keys when merging claude-code config", async () => {
    const dir = tmp();
    const path = join(dir, ".claude.json");
    writeFileSync(
      path,
      JSON.stringify(
        {
          theme: "dark",
          mcpServers: {
            other: { command: "node", args: ["other.js"] },
          },
        },
        null,
        2
      )
    );

    await configureAgentMcp({
      agent: "claude-code",
      scope: "user",
      env: { SUMMER_CLAUDE_CONFIG_FILE: path } as NodeJS.ProcessEnv,
    });

    const written = JSON.parse(readFileSync(path, "utf-8"));
    expect(written.theme).toBe("dark");
    expect(written.mcpServers.other.command).toBe("node");
    expect(written.mcpServers["summer-engine"].command).toBe("npx");
  });

  it("upserts a codex TOML server table", async () => {
    const dir = tmp();
    const path = join(dir, "config.toml");
    writeFileSync(
      path,
      ['[mcp_servers.other]', 'command = "node"', 'args = ["other.js"]', ''].join("\n")
    );

    const first = await configureAgentMcp({
      agent: "codex",
      scope: "user",
      env: { SUMMER_CODEX_CONFIG_FILE: path } as NodeJS.ProcessEnv,
    });
    expect(first.wrote).toBe(true);
    let content = readFileSync(path, "utf-8");
    expect(content).toContain("[mcp_servers.other]");
    expect(content).toContain("[mcp_servers.summer-engine]");

    const second = await configureAgentMcp({
      agent: "codex",
      scope: "user",
      env: { SUMMER_CODEX_CONFIG_FILE: path } as NodeJS.ProcessEnv,
    });
    expect(second.wrote).toBe(false);
    content = readFileSync(path, "utf-8");
    const occurrences = content.match(/\[mcp_servers\.summer-engine\]/g) ?? [];
    expect(occurrences.length).toBe(1);
  });

  it("dry-run does not write", async () => {
    const dir = tmp();
    const path = join(dir, ".claude.json");
    const result = await configureAgentMcp({
      agent: "claude-code",
      scope: "user",
      dryRun: true,
      env: { SUMMER_CLAUDE_CONFIG_FILE: path } as NodeJS.ProcessEnv,
    });
    expect(result.wrote).toBe(false);
    expect(() => readFileSync(path, "utf-8")).toThrow();
  });
});
