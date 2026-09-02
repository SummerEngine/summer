import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GEMINI_EXTENSION_DIR_NAME,
  configureAgentMcp,
  createSummerMcpServerConfig,
  parseAgent,
  resolvePackageRoot,
} from "./agent-config.js";

const tmpDirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "summer-agent-config-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const NPX_ARGS = ["-y", "summer-engine@latest", "mcp"];

describe("parseAgent", () => {
  it("maps devin to windsurf", () => {
    expect(parseAgent("devin")).toBe("windsurf");
  });

  it("maps devin-desktop to windsurf", () => {
    expect(parseAgent("devin-desktop")).toBe("windsurf");
  });

  it("maps devindesktop to windsurf", () => {
    expect(parseAgent("devindesktop")).toBe("windsurf");
  });

  it("keeps windsurf as windsurf", () => {
    expect(parseAgent("windsurf")).toBe("windsurf");
  });
});

describe("createSummerMcpServerConfig", () => {
  it("uses npx -y summer-engine@latest mcp by default", () => {
    const server = createSummerMcpServerConfig(false);
    expect(server.command).toBe("npx");
    expect(server.args).toEqual(NPX_ARGS);
  });

  it("routes npx through cmd.exe on Windows (spawn does no PATHEXT resolution)", () => {
    const server = createSummerMcpServerConfig(false, "win32");
    expect(server.command).toBe("cmd.exe");
    expect(server.args).toEqual(["/c", "npx", ...NPX_ARGS]);
  });

  it("keeps plain npx on non-Windows platforms", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const server = createSummerMcpServerConfig(false, platform);
      expect(server.command).toBe("npx");
      expect(server.args).toEqual(NPX_ARGS);
    }
  });

  it("keeps node (a real executable) for localDev on every platform", () => {
    expect(createSummerMcpServerConfig(true, "win32").command).toBe("node");
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

  it("writes a fresh kilo-code config in mcpServers shape", async () => {
    const dir = tmp();
    const path = join(dir, "mcp_settings.json");
    const result = await configureAgentMcp({
      agent: "kilo-code",
      scope: "user",
      env: { SUMMER_KILO_CODE_CONFIG_FILE: path } as NodeJS.ProcessEnv,
    });
    expect(result.wrote).toBe(true);
    const written = JSON.parse(readFileSync(path, "utf-8"));
    expect(written.mcpServers["summer-engine"].command).toBe("npx");
    expect(written.mcpServers["summer-engine"].args).toEqual(NPX_ARGS);
  });

  it("writes kilo-code project config to .kilocode/mcp.json", async () => {
    const dir = tmp();
    const result = await configureAgentMcp({
      agent: "kilo-code",
      scope: "project",
      cwd: dir,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result.wrote).toBe(true);
    expect(result.path).toBe(join(dir, ".kilocode", "mcp.json"));
    const written = JSON.parse(readFileSync(result.path, "utf-8"));
    expect(written.mcpServers["summer-engine"].command).toBe("npx");
  });

  it("writes a fresh lm-studio config in mcpServers shape", async () => {
    const dir = tmp();
    const path = join(dir, "mcp.json");
    const result = await configureAgentMcp({
      agent: "lm-studio",
      scope: "user",
      env: { SUMMER_LM_STUDIO_CONFIG_FILE: path } as NodeJS.ProcessEnv,
    });
    expect(result.wrote).toBe(true);
    const written = JSON.parse(readFileSync(path, "utf-8"));
    expect(written.mcpServers["summer-engine"].command).toBe("npx");
    expect(written.mcpServers["summer-engine"].args).toEqual(NPX_ARGS);
  });

  it("falls back to user scope for lm-studio when project scope is requested", async () => {
    const dir = tmp();
    const path = join(dir, "mcp.json");
    const result = await configureAgentMcp({
      agent: "lm-studio",
      scope: "project",
      env: { SUMMER_LM_STUDIO_CONFIG_FILE: path } as NodeJS.ProcessEnv,
    });
    expect(result.wrote).toBe(true);
    expect(result.warnings.some((w) => w.includes("no project scope"))).toBe(true);
  });

  it("writes the generated gemini manifest (renamed to the extension dir) plus GEMINI.md/AGENTS.md", async () => {
    const dir = tmp();
    const path = join(dir, "gemini-extension.json");
    const result = await configureAgentMcp({
      agent: "gemini",
      scope: "user",
      env: { SUMMER_GEMINI_CONFIG_FILE: path } as NodeJS.ProcessEnv,
    });
    expect(result.wrote).toBe(true);
    const written = JSON.parse(readFileSync(path, "utf-8"));
    const bundled = JSON.parse(readFileSync(join(resolvePackageRoot(), "gemini-extension.json"), "utf-8"));
    // Gemini requires manifest name == extension directory name.
    expect(written.name).toBe(GEMINI_EXTENSION_DIR_NAME);
    expect(written.contextFileName).toBe("GEMINI.md");
    // Carried over from the generated package manifest, never hand-rolled.
    expect(written.version).toBe(bundled.version);
    expect(written.description).toBe(bundled.description);
    expect(written.settings).toEqual(bundled.settings);
    // Install-time overrides / drops.
    expect(written._generated).toBeUndefined();
    expect(written.skills).toBeUndefined();
    expect(written.mcpServers["summer-engine"].command).toBe("npx");
    expect(written.mcpServers["summer-engine"].args).toEqual(NPX_ARGS);
    expect(written.mcpServers["summer-engine"].cwd).toBeUndefined();
    // Context files land next to the manifest.
    expect(readFileSync(join(dir, "GEMINI.md"), "utf-8")).toBe(
      readFileSync(join(resolvePackageRoot(), "GEMINI.md"), "utf-8")
    );
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
  });

  it("reports gemini as unchanged on a second run", async () => {
    const dir = tmp();
    const path = join(dir, "gemini-extension.json");
    const env = { SUMMER_GEMINI_CONFIG_FILE: path } as NodeJS.ProcessEnv;
    await configureAgentMcp({ agent: "gemini", scope: "user", env });
    const second = await configureAgentMcp({ agent: "gemini", scope: "user", env });
    expect(second.changed).toBe(false);
    expect(second.wrote).toBe(false);
  });

  it("writes a GitHub Copilot CLI config with tools enabled", async () => {
    const dir = tmp();
    const path = join(dir, "mcp-config.json");
    const result = await configureAgentMcp({
      agent: "github-copilot",
      scope: "user",
      env: { SUMMER_GITHUB_COPILOT_CONFIG_FILE: path } as NodeJS.ProcessEnv,
    });
    expect(result.wrote).toBe(true);
    const written = JSON.parse(readFileSync(path, "utf-8"));
    expect(written.mcpServers["summer-engine"].type).toBe("local");
    expect(written.mcpServers["summer-engine"].command).toBe("npx");
    expect(written.mcpServers["summer-engine"].args).toEqual(NPX_ARGS);
    expect(written.mcpServers["summer-engine"].tools).toEqual(["*"]);
  });

  it("writes a VS Code Copilot mcp.json with servers shape", async () => {
    const dir = tmp();
    const path = join(dir, "mcp.json");
    const result = await configureAgentMcp({
      agent: "vscode-copilot",
      scope: "user",
      env: { SUMMER_VSCODE_COPILOT_CONFIG_FILE: path } as NodeJS.ProcessEnv,
    });
    expect(result.wrote).toBe(true);
    const written = JSON.parse(readFileSync(path, "utf-8"));
    expect(written.servers["summer-engine"].type).toBe("stdio");
    expect(written.servers["summer-engine"].command).toBe("npx");
    expect(written.servers["summer-engine"].args).toEqual(NPX_ARGS);
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
