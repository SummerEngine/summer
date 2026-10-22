import { chmodSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { describe, expect, it } from "vitest";
import { detectAgents, searchedBinDirs } from "./agent-detect.js";
import { AGENT_IDS, type PathContext } from "./agent-table.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "summer-detect-"));
}

function touch(path: string, content = "", mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
}

function ctxFor(root: string, os: NodeJS.Platform, env: NodeJS.ProcessEnv = {}): PathContext {
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return { home, os, cwd: join(root, "work"), env: { PATH: "", ...env } };
}

/** Every file under root, so a test can prove detect wrote nothing. */
function listing(root: string): string[] {
  return readdirSync(root, { recursive: true }).map(String).sort();
}

const byId = (agents: ReturnType<typeof detectAgents>, id: string) => agents.find((agent) => agent.id === id)!;

describe("detectAgents", () => {
  it("lists every agent in the table, not installed on an empty computer", () => {
    const root = scratch();
    const agents = detectAgents({ ctx: ctxFor(root, "darwin"), macAppDirs: [join(root, "Applications")], systemBinDirs: [] });
    expect(agents.map((agent) => agent.id)).toEqual([...AGENT_IDS]);
    for (const agent of agents) {
      expect(agent).toMatchObject({ installed: false, programFound: false, detectedBy: [], configExists: false, mcpEntry: false, mcpServer: null });
      expect(agent.configPath).toMatch(/\S/);
    }
  });

  it("finds a command on PATH and in the usual install folders a GUI app's PATH leaves out", () => {
    const root = scratch();
    const bin = join(root, "bin");
    touch(join(bin, "codex"), "#!/bin/sh\n", 0o755);
    const ctx = ctxFor(root, "darwin", { PATH: bin });
    touch(join(ctx.home, ".local", "bin", "claude"), "#!/bin/sh\n", 0o755);
    // Not executable: not a command.
    touch(join(bin, "goose"), "", 0o644);
    const agents = detectAgents({ ctx, macAppDirs: [], systemBinDirs: [] });
    expect(byId(agents, "codex")).toMatchObject({ installed: true, detectedBy: [{ kind: "bin", path: join(bin, "codex") }] });
    expect(byId(agents, "claude-code").detectedBy).toEqual([{ kind: "bin", path: join(ctx.home, ".local", "bin", "claude") }]);
    expect(byId(agents, "goose").installed).toBe(false);
  });

  it("finds macOS app bundles, config folders and VS Code extensions", () => {
    const root = scratch();
    const apps = join(root, "Applications");
    mkdirSync(join(apps, "Cursor.app"), { recursive: true });
    mkdirSync(join(apps, "Claude.app"), { recursive: true });
    const ctx = ctxFor(root, "darwin");
    mkdirSync(join(ctx.home, ".hermes"), { recursive: true });
    mkdirSync(join(ctx.home, ".vscode", "extensions", "saoudrizwan.claude-dev-3.20.1"), { recursive: true });
    const agents = detectAgents({ ctx, macAppDirs: [apps], systemBinDirs: [] });
    expect(byId(agents, "cursor").detectedBy).toEqual([{ kind: "app", path: join(apps, "Cursor.app") }]);
    expect(byId(agents, "claude-desktop").detectedBy).toEqual([{ kind: "app", path: join(apps, "Claude.app") }]);
    expect(byId(agents, "hermes")).toMatchObject({ installed: true, programFound: false, detectedBy: [{ kind: "folder", path: join(ctx.home, ".hermes") }] });
    expect(byId(agents, "cursor").programFound).toBe(true);
    expect(byId(agents, "cline").detectedBy).toEqual([
      { kind: "extension", path: join(ctx.home, ".vscode", "extensions", "saoudrizwan.claude-dev-3.20.1") },
    ]);
  });

  it("on Windows tries PATHEXT endings and the per-user Programs folder", () => {
    const root = scratch();
    const bin = join(root, "bin");
    touch(join(bin, "opencode.cmd"), "@echo off\n");
    const local = join(root, "Local");
    touch(join(local, "Programs", "Zed", "Zed.exe"));
    const ctx = ctxFor(root, "win32", { PATH: bin, PATHEXT: ".EXE;.CMD", LOCALAPPDATA: local, APPDATA: join(root, "Roaming") });
    const agents = detectAgents({ ctx });
    expect(byId(agents, "opencode").detectedBy).toEqual([{ kind: "bin", path: join(bin, "opencode.cmd") }]);
    expect(byId(agents, "zed").detectedBy).toEqual([{ kind: "app", path: join(local, "Programs", "Zed", "Zed.exe") }]);
    expect(searchedBinDirs(ctx)).toContain(join(root, "Roaming", "npm"));
  });

  it("says whether the config file already lists summer-engine, and what it runs", () => {
    const root = scratch();
    const ctx = ctxFor(root, "darwin");
    touch(join(ctx.home, ".claude.json"), JSON.stringify({ mcpServers: { "summer-engine": { type: "stdio", command: "npx", args: ["-y", "summer-engine@latest", "mcp"] } } }));
    touch(join(ctx.home, ".codex", "config.toml"), '[mcp_servers.other]\ncommand = "x"\n');
    touch(join(ctx.home, ".hermes", "config.yaml"), "mcp_servers:\n  summer-engine:\n    command: /opt/summer/node\n    args: [/opt/summer/pkg/dist/bin/summer.js, mcp]\n");
    const before = listing(root);
    const agents = detectAgents({ ctx, macAppDirs: [], systemBinDirs: [] });
    expect(listing(root)).toEqual(before);
    expect(byId(agents, "claude-code")).toMatchObject({
      installed: true,
      configPath: join(ctx.home, ".claude.json"),
      configExists: true,
      mcpEntry: true,
      mcpServer: { command: "npx", args: ["-y", "summer-engine@latest", "mcp"] },
    });
    expect(byId(agents, "codex")).toMatchObject({ configExists: true, mcpEntry: false, mcpServer: null });
    expect(byId(agents, "hermes")).toMatchObject({ mcpEntry: true, mcpServer: { command: "/opt/summer/node", args: ["/opt/summer/pkg/dist/bin/summer.js", "mcp"] } });
  });

  it("honours an agent's config-path override", () => {
    const root = scratch();
    const file = join(root, "custom", "mcp.json");
    touch(file, JSON.stringify({ mcpServers: { "summer-engine": { command: "npx", args: [] } } }));
    const agents = detectAgents({ ctx: ctxFor(root, "linux", { SUMMER_CURSOR_MCP_CONFIG_FILE: file }) });
    expect(byId(agents, "cursor")).toMatchObject({ configPath: file, mcpEntry: true });
  });
});
