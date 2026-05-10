import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { configureAgentMcp, createSummerMcpServerConfig } from "./agent-config.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "summer-agent-config-"));
}

const NPX_ARGS = ["-y", "summer-engine@latest", "mcp"];

describe("createSummerMcpServerConfig", () => {
  it("uses npx -y summer-engine@latest mcp by default", () => {
    const server = createSummerMcpServerConfig(false);
    expect(server.command).toBe("npx");
    expect(server.args).toEqual(NPX_ARGS);
  });
});

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
    expect(written.mcpServers["summer-engine"].args).toEqual(NPX_ARGS);
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
    expect(written.mcpServers["summer-engine"].args).toEqual(NPX_ARGS);
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
    expect(content).toContain('"-y"');
    expect(content).toContain('"summer-engine@latest"');

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

  it("writes a fresh cline config in mcpServers shape", async () => {
    const dir = tmp();
    const path = join(dir, "cline_mcp_settings.json");
    const result = await configureAgentMcp({
      agent: "cline",
      scope: "user",
      env: { SUMMER_CLINE_CONFIG_FILE: path } as NodeJS.ProcessEnv,
    });
    expect(result.wrote).toBe(true);
    const written = JSON.parse(readFileSync(path, "utf-8"));
    expect(written.mcpServers["summer-engine"].command).toBe("npx");
    expect(written.mcpServers["summer-engine"].args).toEqual(NPX_ARGS);
  });

  it("falls back to user scope for cline when project scope is requested", async () => {
    const dir = tmp();
    const path = join(dir, "cline_mcp_settings.json");
    const result = await configureAgentMcp({
      agent: "cline",
      scope: "project",
      env: { SUMMER_CLINE_CONFIG_FILE: path } as NodeJS.ProcessEnv,
    });
    expect(result.wrote).toBe(true);
    expect(result.warnings.some((w) => w.includes("no project scope"))).toBe(true);
  });

  it("writes a fresh roo-code config in mcpServers shape", async () => {
    const dir = tmp();
    const path = join(dir, "cline_mcp_settings.json");
    const result = await configureAgentMcp({
      agent: "roo-code",
      scope: "user",
      env: { SUMMER_ROO_CODE_CONFIG_FILE: path } as NodeJS.ProcessEnv,
    });
    expect(result.wrote).toBe(true);
    const written = JSON.parse(readFileSync(path, "utf-8"));
    expect(written.mcpServers["summer-engine"].command).toBe("npx");
    expect(written.mcpServers["summer-engine"].args).toEqual(NPX_ARGS);
  });

  it("writes a gemini extension manifest with mcpServers entry", async () => {
    const dir = tmp();
    const path = join(dir, "gemini-extension.json");
    const result = await configureAgentMcp({
      agent: "gemini",
      scope: "user",
      env: { SUMMER_GEMINI_CONFIG_FILE: path } as NodeJS.ProcessEnv,
    });
    expect(result.wrote).toBe(true);
    const written = JSON.parse(readFileSync(path, "utf-8"));
    expect(written.name).toBe("summer");
    expect(written.contextFileName).toBe("GEMINI.md");
    expect(written.mcpServers["summer-engine"].command).toBe("npx");
    expect(written.mcpServers["summer-engine"].args).toEqual(NPX_ARGS);
  });

  it("writes a fresh opencode config with the array-shaped command", async () => {
    const dir = tmp();
    const path = join(dir, "opencode.json");
    const result = await configureAgentMcp({
      agent: "opencode",
      scope: "user",
      env: { SUMMER_OPENCODE_CONFIG_FILE: path } as NodeJS.ProcessEnv,
    });
    expect(result.wrote).toBe(true);
    const written = JSON.parse(readFileSync(path, "utf-8"));
    expect(written.$schema).toBe("https://opencode.ai/config.json");
    expect(written.mcp["summer-engine"].type).toBe("local");
    expect(written.mcp["summer-engine"].command).toEqual([
      "npx",
      "-y",
      "summer-engine@latest",
      "mcp",
    ]);
  });

  it("preserves unrelated keys when merging opencode config", async () => {
    const dir = tmp();
    const path = join(dir, "opencode.json");
    writeFileSync(
      path,
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          theme: "tokyo-night",
          mcp: {
            other: { type: "local", command: ["node", "other.js"] },
          },
        },
        null,
        2
      )
    );

    await configureAgentMcp({
      agent: "opencode",
      scope: "user",
      env: { SUMMER_OPENCODE_CONFIG_FILE: path } as NodeJS.ProcessEnv,
    });

    const written = JSON.parse(readFileSync(path, "utf-8"));
    expect(written.theme).toBe("tokyo-night");
    expect(written.mcp.other.command).toEqual(["node", "other.js"]);
    expect(written.mcp["summer-engine"].command).toEqual([
      "npx",
      "-y",
      "summer-engine@latest",
      "mcp",
    ]);
  });
});
