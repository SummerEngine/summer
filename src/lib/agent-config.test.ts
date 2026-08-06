import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
  configureAgentMcp,
  createSummerMcpServerConfig,
  parseAgent,
  resolveAgentConfigScope,
} from "./agent-config.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "summer-agent-config-"));
}

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

  it("maps current Antigravity client names", () => {
    expect(parseAgent("antigravity")).toBe("antigravity");
    expect(parseAgent("antigravity-ide")).toBe("antigravity");
    expect(parseAgent("antigravity-cli")).toBe("antigravity");
  });
});

describe("resolveAgentConfigScope", () => {
  it("defaults OpenCode with an explicit project to project scope", () => {
    expect(resolveAgentConfigScope("opencode", undefined, ".")).toBe("project");
  });

  it("preserves an explicit OpenCode user scope", () => {
    expect(resolveAgentConfigScope("opencode", "user", ".")).toBe("user");
  });

  it("defaults Antigravity with an explicit project to project scope", () => {
    expect(resolveAgentConfigScope("antigravity", undefined, ".")).toBe(
      "project"
    );
  });

  it("keeps the existing user default for other agents", () => {
    expect(resolveAgentConfigScope("codex", undefined, ".")).toBe("user");
  });
});

describe("createSummerMcpServerConfig", () => {
  it("uses npx -y summer-engine@latest mcp by default", () => {
    const server = createSummerMcpServerConfig(false);
    expect(server.command).toBe("npx");
    expect(server.args).toEqual(NPX_ARGS);
  });

  it("adds an explicit project when requested", () => {
    const project = join(tmp(), "game");
    const server = createSummerMcpServerConfig(false, {
      projectPath: project,
    });
    expect(server.args).toEqual([...NPX_ARGS, "--project", project]);
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

  it("prefers the active LM Studio runtime config directory when present", async () => {
    const home = tmp();
    const runtimeDir = join(home, ".cache", "lm-studio");
    mkdirSync(runtimeDir, { recursive: true });

    const result = await configureAgentMcp({
      agent: "lm-studio",
      scope: "user",
      env: { HOME: home, USERPROFILE: home } as NodeJS.ProcessEnv,
    });

    expect(result.path).toBe(join(runtimeDir, "mcp.json"));
    const written = JSON.parse(readFileSync(result.path, "utf-8"));
    expect(written.mcpServers["summer-engine"].args).toEqual(NPX_ARGS);
  });

  it("binds an LM Studio config entry to an explicit project", async () => {
    const dir = tmp();
    const path = join(dir, "mcp.json");
    const project = join(dir, "project");
    const result = await configureAgentMcp({
      agent: "lm-studio",
      scope: "user",
      projectPath: project,
      env: { SUMMER_LM_STUDIO_CONFIG_FILE: path } as NodeJS.ProcessEnv,
    });

    const written = JSON.parse(readFileSync(path, "utf-8"));
    expect(written.mcpServers["summer-engine"].args).toEqual([
      ...NPX_ARGS,
      "--project",
      project,
    ]);
    expect(result.projectPath).toBe(project);
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
    expect(written.provider).toBeUndefined();
    expect(written.model).toBeUndefined();
  });

  it("writes current Antigravity project MCP config without touching providers", async () => {
    const dir = tmp();
    const project = join(dir, "game");
    mkdirSync(join(project, ".agents"), { recursive: true });
    const path = join(project, ".agents", "mcp_config.json");
    writeFileSync(
      path,
      JSON.stringify({
        theme: "preserve-me",
        mcpServers: { other: { command: "node", args: ["other.js"] } },
      })
    );

    const result = await configureAgentMcp({
      agent: "antigravity",
      scope: "project",
      cwd: dir,
      projectPath: project,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(result.path).toBe(path);
    const written = JSON.parse(readFileSync(path, "utf-8"));
    expect(written.theme).toBe("preserve-me");
    expect(written.mcpServers.other.command).toBe("node");
    expect(written.mcpServers["summer-engine"].args).toEqual([
      ...NPX_ARGS,
      "--project",
      project,
    ]);
    expect(written.provider).toBeUndefined();
    expect(written.model).toBeUndefined();
    expect(result.nextSteps.join("\n")).toContain(
      "normal interactive `agy` session"
    );
    expect(result.nextSteps.join("\n")).toContain("`agy -p`");
  });

  it("writes current Antigravity user MCP config path", async () => {
    const home = tmp();
    const result = await configureAgentMcp({
      agent: "antigravity",
      scope: "user",
      env: { HOME: home, USERPROFILE: home } as NodeJS.ProcessEnv,
    });

    expect(result.path).toBe(
      join(home, ".gemini", "config", "mcp_config.json")
    );
    const written = JSON.parse(readFileSync(result.path, "utf-8"));
    expect(written.mcpServers["summer-engine"].command).toBe("npx");
  });

  it("configures an OpenCode LM Studio provider without changing the MCP surface", async () => {
    const dir = tmp();
    const path = join(dir, "opencode.json");
    const result = await configureAgentMcp({
      agent: "opencode",
      scope: "project",
      cwd: dir,
      projectPath: dir,
      opencodeLmStudio: {
        modelId: "google/gemma-4-26b-a4b-qat",
        vision: true,
      },
      env: { SUMMER_OPENCODE_CONFIG_FILE: path } as NodeJS.ProcessEnv,
    });

    const written = JSON.parse(readFileSync(path, "utf-8"));
    expect(written.model).toBe("lmstudio/google/gemma-4-26b-a4b-qat");
    expect(written.small_model).toBe("lmstudio/google/gemma-4-26b-a4b-qat");
    expect(written.provider.lmstudio.npm).toBe("@ai-sdk/openai-compatible");
    expect(written.provider.lmstudio.options.baseURL).toBe(
      "http://127.0.0.1:1234/v1"
    );
    expect(
      written.provider.lmstudio.models["google/gemma-4-26b-a4b-qat"]
    ).toMatchObject({
      limit: { context: 131072, output: 8192 },
      modalities: { input: ["text", "image"], output: ["text"] },
      options: { reasoningEffort: "none" },
    });
    expect(written.mcp["summer-engine"].command).toEqual([
      "npx",
      ...NPX_ARGS,
      "--project",
      dir,
    ]);
  });

  it("does not advertise image input for a text-only LM Studio setup", async () => {
    const dir = tmp();
    const path = join(dir, "opencode.json");

    await configureAgentMcp({
      agent: "opencode",
      scope: "project",
      cwd: dir,
      projectPath: dir,
      opencodeLmStudio: { modelId: "text-only-model" },
      env: { SUMMER_OPENCODE_CONFIG_FILE: path } as NodeJS.ProcessEnv,
    });

    const written = JSON.parse(readFileSync(path, "utf-8"));
    expect(
      written.provider.lmstudio.models["text-only-model"].modalities
    ).toBeUndefined();
  });

  it("preserves unrelated OpenCode providers and LM Studio model keys", async () => {
    const dir = tmp();
    const path = join(dir, "opencode.json");
    writeFileSync(
      path,
      JSON.stringify({
        provider: {
          other: { npm: "other-provider" },
          lmstudio: {
            options: { apiKey: "local-placeholder" },
            models: {
              existing: { name: "Existing model" },
              "google/gemma-4-26b-a4b-qat": {
                custom: true,
                modalities: { input: ["text", "audio"], custom: true },
              },
            },
          },
        },
      })
    );

    await configureAgentMcp({
      agent: "opencode",
      scope: "user",
      opencodeLmStudio: {
        modelId: "google/gemma-4-26b-a4b-qat",
        vision: true,
      },
      env: { SUMMER_OPENCODE_CONFIG_FILE: path } as NodeJS.ProcessEnv,
    });

    const written = JSON.parse(readFileSync(path, "utf-8"));
    expect(written.provider.other.npm).toBe("other-provider");
    expect(written.provider.lmstudio.options.apiKey).toBe("local-placeholder");
    expect(written.provider.lmstudio.models.existing.name).toBe("Existing model");
    expect(
      written.provider.lmstudio.models["google/gemma-4-26b-a4b-qat"].custom
    ).toBe(true);
    expect(
      written.provider.lmstudio.models["google/gemma-4-26b-a4b-qat"].modalities
    ).toEqual({
      input: ["text", "image"],
      output: ["text"],
      custom: true,
    });
  });
});
