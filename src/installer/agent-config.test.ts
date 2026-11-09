import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { allAgentSpecs } from "./agent-table.js";
import {
  GEMINI_EXTENSION_DIR_NAME,
  configureAgentMcp,
  configureSummerGamesMcp,
  createSummerMcpServerConfig,
  normalizeChannel,
  parseAgent,
  resolveAgentSelection,
  resolveBundledRuntime,
  resolvePackageRoot,
  topLevelKey,
} from "./agent-config.js";
import { readRecordedMcpServer } from "./version-check.js";
import { SetupError } from "./setup-error.js";
import { chmodSync } from "fs";

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

  it("--channel next writes summer-engine@next on every platform", () => {
    expect(createSummerMcpServerConfig(false, "darwin", "next").args).toEqual(["-y", "summer-engine@next", "mcp"]);
    expect(createSummerMcpServerConfig(false, "win32", "next").args).toEqual(["/c", "npx", "-y", "summer-engine@next", "mcp"]);
  });

  it("blank channel means latest; exact versions pin; partial versions, paths and shouting are refused", () => {
    expect(normalizeChannel(undefined)).toBe("latest");
    expect(normalizeChannel("  ")).toBe("latest");
    expect(normalizeChannel("beta")).toBe("beta");
    expect(normalizeChannel("3.9.1")).toBe("3.9.1");
    expect(normalizeChannel("3.9.1-rc.1")).toBe("3.9.1-rc.1");
    expect(createSummerMcpServerConfig(false, "darwin", "3.9.1").args).toEqual(["-y", "summer-engine@3.9.1", "mcp"]);
    for (const bad of ["3.0", "v3", "v3.0.0", "Next", "../x", "next mcp", "@next", "3.0.0 mcp"]) {
      expect(() => normalizeChannel(bad)).toThrow(/Invalid channel/);
    }
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

  it("writes a fresh cline (VS Code) config in mcpServers shape", async () => {
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
    expect(result.warnings.some((w) => w.includes("user scope"))).toBe(true);
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

  it("writes a fresh kilo-code config in Kilo's mcp shape (array command, enabled) without OpenCode's $schema", async () => {
    const dir = tmp();
    const path = join(dir, "kilo.json");
    const result = await configureAgentMcp({
      agent: "kilo-code",
      scope: "user",
      env: { SUMMER_KILO_CODE_CONFIG_FILE: path } as NodeJS.ProcessEnv,
    });
    expect(result.wrote).toBe(true);
    const written = JSON.parse(readFileSync(path, "utf-8"));
    expect(written.$schema).toBeUndefined();
    expect(written.mcp["summer-engine"]).toEqual({
      type: "local",
      command: ["npx", ...NPX_ARGS],
      enabled: true,
    });
  });

  it("writes kilo-code project config to ./kilo.json", async () => {
    const dir = tmp();
    const result = await configureAgentMcp({
      agent: "kilo-code",
      scope: "project",
      cwd: dir,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result.wrote).toBe(true);
    expect(result.path).toBe(join(dir, "kilo.json"));
    const written = JSON.parse(readFileSync(result.path, "utf-8"));
    expect(written.mcp["summer-engine"].command[0]).toBe("npx");
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
    expect(result.warnings.some((w) => w.includes("user scope"))).toBe(true);
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
    // VS Code Copilot takes at most 128 tools per request: the engine profile fits.
    expect(written.servers["summer-engine"].env).toEqual({ SUMMER_PROFILE: "engine" });
    expect(result.profile).toBe("engine");
  });

  it("writes the profile into the entry's env, and nothing for the full profile", async () => {
    const dir = tmp();
    const vscode = join(dir, "mcp.json");
    const full = await configureAgentMcp({
      agent: "vscode-copilot",
      scope: "user",
      profile: "full",
      env: { SUMMER_VSCODE_COPILOT_CONFIG_FILE: vscode } as NodeJS.ProcessEnv,
    });
    expect(full.profile).toBe("full");
    expect(JSON.parse(readFileSync(vscode, "utf-8")).servers["summer-engine"]).not.toHaveProperty("env");

    const claude = join(dir, ".claude.json");
    await configureAgentMcp({
      agent: "claude-code",
      scope: "user",
      env: { SUMMER_CLAUDE_CONFIG_FILE: claude } as NodeJS.ProcessEnv,
    });
    expect(JSON.parse(readFileSync(claude, "utf-8")).mcpServers["summer-engine"]).not.toHaveProperty("env");

    const assets = await configureAgentMcp({
      agent: "claude-code",
      scope: "user",
      profile: "assets",
      env: { SUMMER_CLAUDE_CONFIG_FILE: claude } as NodeJS.ProcessEnv,
    });
    expect(assets.changed).toBe(true);
    expect(JSON.parse(readFileSync(claude, "utf-8")).mcpServers["summer-engine"].env).toEqual({ SUMMER_PROFILE: "assets" });
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

describe("configureSummerGamesMcp", () => {
  const GAMES_URL = "https://mcp.summer.games/mcp";

  it("adds summer-games as a remote http server next to summer-engine in Claude Code", async () => {
    const path = join(tmp(), ".claude.json");
    writeFileSync(path, JSON.stringify({ theme: "dark", mcpServers: { other: { command: "node", args: [] } } }));
    const env = { SUMMER_CLAUDE_CONFIG_FILE: path } as NodeJS.ProcessEnv;
    await configureAgentMcp({ agent: "claude-code", scope: "user", env });

    const first = await configureSummerGamesMcp({ agent: "claude-code", scope: "user", env });
    expect(first?.wrote).toBe(true);
    const written = JSON.parse(readFileSync(path, "utf-8"));
    expect(written.mcpServers["summer-games"]).toEqual({ type: "http", url: GAMES_URL });
    expect(written.mcpServers["summer-engine"].args).toEqual(NPX_ARGS);
    expect(written.mcpServers.other.command).toBe("node");
    expect(written.theme).toBe("dark");

    const second = await configureSummerGamesMcp({ agent: "claude-code", scope: "user", env });
    expect(second?.changed).toBe(false);
  });

  it("adds a url entry for Cursor", async () => {
    const path = join(tmp(), "mcp.json");
    await configureSummerGamesMcp({ agent: "cursor", scope: "user", env: { SUMMER_CURSOR_MCP_CONFIG_FILE: path } as NodeJS.ProcessEnv });
    expect(JSON.parse(readFileSync(path, "utf-8")).mcpServers["summer-games"]).toEqual({ url: GAMES_URL });
  });

  // Every agent with a remoteMcp entry: written once in its own shape, found
  // again by URL on the next run, next to summer-engine and its other servers.
  const remoteAgents = allAgentSpecs().filter((spec) => spec.remoteMcp);
  it.each(remoteAgents.map((spec) => [spec.id, spec] as const))("%s: written once, next to summer-engine", async (_id, spec) => {
    const path = join(tmp(), spec.format.startsWith("toml") ? "config.toml" : spec.format.startsWith("yaml") ? "config.yaml" : "config.json");
    const env = { [spec.envOverride]: path } as NodeJS.ProcessEnv;
    await configureAgentMcp({ agent: spec.id, scope: "user", env });
    const first = await configureSummerGamesMcp({ agent: spec.id, scope: "user", env });
    expect(first).toMatchObject({ serverName: "summer-games", wrote: true });
    const afterFirst = readFileSync(path, "utf-8");
    const second = await configureSummerGamesMcp({ agent: spec.id, scope: "user", env });
    expect(second).toMatchObject({ serverName: "summer-games", changed: false });
    await configureAgentMcp({ agent: spec.id, scope: "user", env });
    const text = readFileSync(path, "utf-8");
    expect(text).toBe(afterFirst);

    const entry = spec.remoteMcp!.entry(GAMES_URL);
    if (spec.format === "toml") {
      expect(text).toContain(`[mcp_servers.summer-games]\nurl = "${GAMES_URL}"`);
      expect(text.match(/\[mcp_servers\.summer-engine\]/g)).toHaveLength(1);
    } else if (spec.format === "toml-array") {
      expect(text.match(/\[\[mcp_servers\]\]/g)).toHaveLength(2);
      expect(text).toContain(`name = "summer-games"\ntransport = "streamable-http"\nurl = "${GAMES_URL}"\nauth = { type = "oauth", scopes = [] }`);
    } else {
      const parsed = (spec.format.startsWith("yaml") ? parseYaml(text) : JSON.parse(text)) as Record<string, Record<string, unknown>>;
      const servers = parsed[topLevelKey(spec.format)];
      expect(servers["summer-games"]).toEqual(entry);
      expect(servers["summer-engine"]).toBeDefined();
    }
  });

  it("only agents whose sign-in api.summer.games accepts get an entry", () => {
    expect(remoteAgents.map((spec) => spec.id).sort()).toEqual(
      [
        "amp", "antigravity", "claude-code", "cline", "cline-cli", "codex", "copilot-jetbrains", "crush", "cursor",
        "factory", "github-copilot", "goose", "grok-build", "hermes", "junie", "kilo-code", "kimi-code", "kiro",
        "mistral-vibe", "opencode", "qwen-code", "trae", "vscode-copilot", "warp", "windsurf", "zed",
      ].sort()
    );
  });

  it("finds a hand-added entry under the agent's own address field (Windsurf serverUrl, Goose uri)", async () => {
    const windsurf = join(tmp(), "mcp_config.json");
    writeFileSync(windsurf, JSON.stringify({ mcpServers: { summer: { serverUrl: GAMES_URL } } }));
    const ws = await configureSummerGamesMcp({ agent: "windsurf", scope: "user", env: { SUMMER_WINDSURF_MCP_CONFIG_FILE: windsurf } as NodeJS.ProcessEnv });
    expect(ws).toMatchObject({ existingName: "summer", changed: false });

    const goose = join(tmp(), "config.yaml");
    const seed = "extensions:\n  summer:\n    type: streamable_http\n    name: summer\n    uri: https://mcp.summer.games/mcp\n";
    writeFileSync(goose, seed);
    const gs = await configureSummerGamesMcp({ agent: "goose", scope: "user", env: { SUMMER_GOOSE_CONFIG_FILE: goose } as NodeJS.ProcessEnv });
    expect(gs).toMatchObject({ existingName: "summer", changed: false });
    expect(readFileSync(goose, "utf-8")).toBe(seed);
  });

  it("finds a hand-added Mistral Vibe block by its url", async () => {
    const path = join(tmp(), "config.toml");
    const seed = '[[mcp_servers]]\nname = "summer"\ntransport = "streamable-http"\nurl = "https://mcp.summer.games/mcp"\n';
    writeFileSync(path, seed);
    const result = await configureSummerGamesMcp({ agent: "mistral-vibe", scope: "user", env: { SUMMER_MISTRAL_VIBE_CONFIG_FILE: path } as NodeJS.ProcessEnv });
    expect(result).toMatchObject({ existingName: "summer", changed: false });
    expect(readFileSync(path, "utf-8")).toBe(seed);
  });

  it("adds no second Claude Code entry when the URL is already listed under another name", async () => {
    const path = join(tmp(), ".claude.json");
    const seed = { mcpServers: { summer: { type: "http", url: `${GAMES_URL}/` } } };
    writeFileSync(path, JSON.stringify(seed));
    const result = await configureSummerGamesMcp({
      agent: "claude-code",
      scope: "user",
      env: { SUMMER_CLAUDE_CONFIG_FILE: path } as NodeJS.ProcessEnv,
    });
    expect(result).toMatchObject({ serverName: "summer", existingName: "summer", changed: false, wrote: false });
    expect(result?.signIn).toContain("choose summer and");
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual(seed);
  });

  it("counts a project-local Claude Code entry (claude mcp add without --scope user)", async () => {
    const path = join(tmp(), ".claude.json");
    const seed = { projects: { "/work/game": { mcpServers: { summer: { type: "http", url: GAMES_URL } } } } };
    writeFileSync(path, JSON.stringify(seed));
    const result = await configureSummerGamesMcp({
      agent: "claude-code",
      scope: "user",
      env: { SUMMER_CLAUDE_CONFIG_FILE: path } as NodeJS.ProcessEnv,
    });
    expect(result?.existingName).toBe("summer");
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual(seed);
  });

  it("leaves an existing summer-games entry with extra fields as it is", async () => {
    const path = join(tmp(), ".claude.json");
    const seed = { mcpServers: { "summer-games": { type: "http", url: GAMES_URL, headers: { "X-Test": "1" } } } };
    writeFileSync(path, JSON.stringify(seed));
    const result = await configureSummerGamesMcp({
      agent: "claude-code",
      scope: "user",
      env: { SUMMER_CLAUDE_CONFIG_FILE: path } as NodeJS.ProcessEnv,
    });
    expect(result).toMatchObject({ serverName: "summer-games", changed: false });
    expect(result?.existingName).toBeUndefined();
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual(seed);
  });

  it("adds no second Codex table when the URL is already listed under another name", async () => {
    const path = join(tmp(), "config.toml");
    const seed = '[mcp_servers."summer"]\nurl = "https://MCP.summer.games/mcp"\n\n[mcp_servers.summer.env]\nX = "1"\n';
    writeFileSync(path, seed);
    const result = await configureSummerGamesMcp({
      agent: "codex",
      scope: "user",
      env: { SUMMER_CODEX_CONFIG_FILE: path } as NodeJS.ProcessEnv,
    });
    expect(result).toMatchObject({ serverName: "summer", existingName: "summer", changed: false });
    expect(result?.signIn).toContain("/mcp login summer");
    expect(readFileSync(path, "utf-8")).toBe(seed);
  });

  it("adds a [mcp_servers.summer-games] url table for Codex without touching summer-engine", async () => {
    const path = join(tmp(), "config.toml");
    const env = { SUMMER_CODEX_CONFIG_FILE: path } as NodeJS.ProcessEnv;
    await configureAgentMcp({ agent: "codex", scope: "user", env });
    const engineOnly = readFileSync(path, "utf-8");

    await configureSummerGamesMcp({ agent: "codex", scope: "user", env });
    await configureSummerGamesMcp({ agent: "codex", scope: "user", env });
    await configureAgentMcp({ agent: "codex", scope: "user", env });

    const content = readFileSync(path, "utf-8");
    expect(content.startsWith(engineOnly)).toBe(true);
    expect(content.match(/\[mcp_servers\.summer-games\]/g)).toHaveLength(1);
    expect(content.match(/\[mcp_servers\.summer-engine\]/g)).toHaveLength(1);
    expect(content).toContain(`[mcp_servers.summer-games]\nurl = "${GAMES_URL}"`);
  });

  it("dry-run writes nothing", async () => {
    const path = join(tmp(), ".claude.json");
    const result = await configureSummerGamesMcp({
      agent: "claude-code",
      scope: "user",
      dryRun: true,
      env: { SUMMER_CLAUDE_CONFIG_FILE: path } as NodeJS.ProcessEnv,
    });
    expect(result?.changed).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("skips agents without a remote server entry", async () => {
    const path = join(tmp(), "claude_desktop_config.json");
    const result = await configureSummerGamesMcp({
      agent: "claude-desktop",
      scope: "user",
      env: { SUMMER_CLAUDE_DESKTOP_CONFIG_FILE: path } as NodeJS.ProcessEnv,
    });
    expect(result).toBeNull();
    expect(existsSync(path)).toBe(false);
  });
});

describe("resolveAgentSelection", () => {
  it("names an unknown agent instead of only asking for one", () => {
    expect(() => resolveAgentSelection("notanagent", undefined)).toThrow(/^Unknown agent "notanagent"\. Supported: .*claude-code/);
    expect(() => resolveAgentSelection(undefined, undefined)).toThrow(/^Specify an agent: /);
    expect(resolveAgentSelection("claude", undefined)).toBe("claude-code");
  });
});

describe("Devin Desktop moved its MCP config to ~/.config/devin", () => {
  it("writes the new file and names an entry an earlier setup left in ~/.codeium/windsurf", async () => {
    const home = tmp();
    const oldFile = join(home, ".codeium", "windsurf", "mcp_config.json");
    mkdirSync(dirname(oldFile), { recursive: true });
    writeFileSync(oldFile, JSON.stringify({ mcpServers: { "summer-engine": { command: "npx", args: ["-y", "summer-engine@latest", "mcp"] } } }));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const env = { XDG_CONFIG_HOME: join(home, "xdg") } as NodeJS.ProcessEnv;
      const result = await configureAgentMcp({ agent: "windsurf", scope: "user", env });
      expect(result.path).toBe(join(home, "xdg", "devin", "mcp_config.json"));
      expect(JSON.parse(readFileSync(result.path, "utf-8")).mcpServers["summer-engine"]).toBeDefined();
      expect(result.warnings).toEqual([expect.stringContaining(`${oldFile} still lists summer-engine`)]);
      expect(readFileSync(oldFile, "utf-8")).toContain("summer-engine");
    } finally {
      process.env.HOME = previousHome;
    }
  });
});

describe("a bundled runtime (--runtime, --package-dir)", () => {
  /** A node file and a summer-engine package folder, as the desktop installer ships them. */
  function bundle(): { root: string; node: string; packageDir: string; cli: string } {
    const dir = tmp();
    const node = join(dir, "runtime", "bin", process.platform === "win32" ? "node.exe" : "node");
    const packageDir = join(dir, "Summer Support", "summer-engine");
    const cli = join(packageDir, "dist", "bin", "summer.js");
    mkdirSync(dirname(node), { recursive: true });
    writeFileSync(node, "");
    chmodSync(node, 0o755);
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "summer-engine", version: "4.5.0" }));
    writeFileSync(cli, "");
    return { root: dir, node, packageDir, cli };
  }

  it("writes <node> <package>/dist/bin/summer.js mcp in every agent's file format", async () => {
    const { node, packageDir, cli } = bundle();
    const runtime = resolveBundledRuntime(node, packageDir)!;
    for (const spec of allAgentSpecs()) {
      const path = join(tmp(), `${spec.id}-config`);
      const result = await configureAgentMcp({
        agent: spec.id,
        scope: "user",
        runtime,
        env: { [spec.envOverride]: path } as NodeJS.ProcessEnv,
      });
      expect(result.runtime, spec.id).toEqual({ node, packageDir });
      expect(result.localDev, spec.id).toBe(false);
      expect(readRecordedMcpServer(readFileSync(path, "utf-8"), spec.format), spec.id).toEqual({
        command: node,
        args: [cli, "mcp"],
      });
    }
  });

  it("keeps the agent's profile in the entry's env", async () => {
    const { node, packageDir } = bundle();
    const path = join(tmp(), "mcp.json");
    const result = await configureAgentMcp({
      agent: "vscode-copilot",
      scope: "user",
      runtime: resolveBundledRuntime(node, packageDir)!,
      env: { SUMMER_VSCODE_COPILOT_CONFIG_FILE: path } as NodeJS.ProcessEnv,
    });
    expect(result.server).toMatchObject({ command: node, env: { SUMMER_PROFILE: "engine" } });
  });

  it("resolves relative paths to absolute ones", () => {
    const { root, node, packageDir } = bundle();
    const relativeNode = join("runtime", "bin", node.split(/[\\/]/).pop()!);
    expect(resolveBundledRuntime(relativeNode, join("Summer Support", "summer-engine"), root)).toEqual({ node, packageDir });
    expect(resolveBundledRuntime(undefined, undefined)).toBeNull();
  });

  it("refuses a missing or wrong runtime or package folder, with a code", () => {
    const { node, packageDir } = bundle();
    const code = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return error instanceof SetupError ? error.code : "not-a-setup-error";
      }
      return "no-error";
    };
    expect(code(() => resolveBundledRuntime(node, undefined))).toBe("runtime_incomplete");
    expect(code(() => resolveBundledRuntime(undefined, packageDir))).toBe("runtime_incomplete");
    expect(code(() => resolveBundledRuntime(join(dirname(node), "missing"), packageDir))).toBe("runtime_not_found");
    expect(code(() => resolveBundledRuntime(dirname(node), packageDir))).toBe("runtime_not_found");
    if (process.platform !== "win32") {
      chmodSync(node, 0o644);
      expect(code(() => resolveBundledRuntime(node, packageDir))).toBe("runtime_not_executable");
      chmodSync(node, 0o755);
    }
    expect(code(() => resolveBundledRuntime(node, join(packageDir, "missing")))).toBe("package_dir_not_found");
    expect(code(() => resolveBundledRuntime(node, dirname(packageDir)))).toBe("package_dir_invalid");
    rmSync(join(packageDir, "dist"), { recursive: true });
    expect(code(() => resolveBundledRuntime(node, packageDir))).toBe("package_dir_invalid");
  });
});

describe("config errors carry a code", () => {
  it("an unparsable file is config_invalid", async () => {
    const path = join(tmp(), ".claude.json");
    writeFileSync(path, "{ not json");
    await expect(
      configureAgentMcp({ agent: "claude-code", scope: "user", env: { SUMMER_CLAUDE_CONFIG_FILE: path } as NodeJS.ProcessEnv })
    ).rejects.toMatchObject({ code: "config_invalid", message: expect.stringContaining("Could not parse JSON") });
  });
});
