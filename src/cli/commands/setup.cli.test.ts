import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { configureAgentMcp, type SupportedAgent } from "../../installer/agent-config.js";
import { resolveInstallLocation } from "../../installer/skill-locations.js";
import { readRecordedMcpServer } from "../../installer/version-check.js";
import { setupCommand } from "./setup.js";
import { skillsCommand } from "./skills.js";

// `summer setup` ends with a doctor pass (network + engine probes): stub it.
vi.mock("../../core/capabilities/doctor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/capabilities/doctor.js")>();
  return { ...actual, runDoctor: vi.fn(async () => ({ ok: true, checks: [], summary: { ok: 0, warnings: 0, failures: 0 } })) };
});

vi.mock("../../installer/version-check.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../installer/version-check.js")>();
  return { ...actual, resolveDefaultChannel: vi.fn(async () => ({ channel: "latest" })) };
});

/** Commander keeps parsed values on the shared command objects: start each parse from the defaults. */
function resetOptions(command: Command): void {
  for (const option of command.options) command.setOptionValueWithSource(option.attributeName(), option.defaultValue, "default");
}

// Setup spawns `summer skills install …`; run that same install in this
// process, so the real skill files land in this test file's HOME.
vi.mock("../../installer/setup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../installer/setup.js")>();
  return {
    ...actual,
    setupSkills: (agent: SupportedAgent, options: Parameters<typeof actual.setupSkills>[1]) => {
      const planned = actual.setupSkills(agent, { ...options, dryRun: true });
      if (options.dryRun || !options.yes || !planned.command) return planned;
      const install = skillsCommand.commands.find((command) => command.name() === "install")!;
      resetOptions(install);
      skillsCommand.parse(planned.command.slice(2), { from: "user" });
      return { ...planned, status: "installed" as const, message: "installed in process" };
    },
  };
});

async function setup(args: string[]): Promise<{ json: Record<string, unknown>; lines: string[] }> {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  try {
    resetOptions(setupCommand);
    await setupCommand.parseAsync(args, { from: "user" });
  } finally {
    log.mockRestore();
  }
  const start = lines.findIndex((line) => line.startsWith("{"));
  return { json: start === -1 ? {} : (JSON.parse(lines.slice(start).join("\n")) as Record<string, unknown>), lines };
}

/** The agent's MCP config file and whether it lists summer-engine or summer-games. */
async function mcpConfig(agent: SupportedAgent): Promise<{ path: string; text: string; summerEngine: boolean }> {
  const { path, format } = await configureAgentMcp({ agent, scope: "user", print: true });
  const text = existsSync(path) ? readFileSync(path, "utf-8") : "";
  return { path, text, summerEngine: readRecordedMcpServer(text, format) !== null };
}

const skillFile = (agent: SupportedAgent, skill: string) => join(resolveInstallLocation(agent, "user").path, skill, "SKILL.md");

describe("summer setup --cli: the skills and no MCP server", () => {
  it.each<SupportedAgent>(["claude-code", "codex", "cursor", "github-copilot", "goose", "mistral-vibe"])(
    "%s: writes the skills, summer-cli among them, and no MCP entry",
    async (agent) => {
      const { json } = await setup([agent, "--cli", "--yes", "--json"]);
      expect(json).toMatchObject({ ok: true, mcp: false, agent, config: null, games: null, existingMcpEntry: null });
      expect(existsSync(skillFile(agent, "summer-cli"))).toBe(true);
      expect(existsSync(skillFile(agent, "using-summer"))).toBe(true);
      // The slash commands start work through the MCP tools, so a CLI-only Claude Code gets none.
      if (agent === "claude-code") expect(existsSync(join(homedir(), ".claude", "commands", "summer.md"))).toBe(false);
      const config = await mcpConfig(agent);
      expect(config.summerEngine).toBe(false);
      expect(config.text).not.toContain("summer-games");
      expect(config.text).not.toContain("mcp.summer.games");
    }
  );

  it("lets Claude Code and Codex run read-only and dry-run summer commands without asking, unless --no-allow-rules", async () => {
    vi.stubEnv("CODEX_HOME", "");
    try {
      const claude = await setup(["claude-code", "--cli", "--yes", "--json"]);
      // The first --cli run in this file already added them; a second adds nothing.
      const rules = claude.json.allowRules as { path: string; added: string[]; rules: string[] };
      expect(rules).toMatchObject({ path: join(homedir(), ".claude", "settings.json"), added: [] });
      const allow = JSON.parse(readFileSync(rules.path, "utf-8")).permissions.allow as string[];
      expect(allow.some((rule) => /^Bash\((summer|npx -y summer-engine@latest) jobs wait \*\)$/.test(rule))).toBe(true);
      expect(allow.some((rule) => rule.includes(" store publish"))).toBe(false);
      const codex = await setup(["codex", "--cli", "--yes", "--json"]);
      expect(readFileSync((codex.json.allowRules as { path: string }).path, "utf-8")).toContain("prefix_rule(");
      const skipped = await setup(["claude-code", "--cli", "--yes", "--no-allow-rules", "--json"]);
      expect(skipped.json.allowRules).toBeNull();
      const planned = await setup(["claude-code", "--cli", "--json", "--scope", "project"]);
      expect(planned.json.allowRules).toMatchObject({ wrote: false });
      expect(existsSync((planned.json.allowRules as { path: string }).path)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("--no-mcp is the same as --cli", async () => {
    const { json } = await setup(["kimi-code", "--no-mcp", "--yes", "--json"]);
    expect(json).toMatchObject({ ok: true, mcp: false, config: null });
    expect((await mcpConfig("kimi-code")).summerEngine).toBe(false);
  });

  it("with --assets-only installs the asset skills, summer-cli among them, and no engine skills", async () => {
    const { json } = await setup(["kiro", "--cli", "--assets-only", "--yes", "--json"]);
    expect(json).toMatchObject({ ok: true, mcp: false });
    expect((json.skills as { command: string[] }).command).toContain("--assets");
    expect(existsSync(skillFile("kiro", "summer-cli"))).toBe(true);
    expect(existsSync(skillFile("kiro", "summer-assets"))).toBe(true);
    expect(existsSync(skillFile("kiro", "play"))).toBe(false);
    expect((await mcpConfig("kiro")).summerEngine).toBe(false);
  });

  it("leaves an existing summer-engine entry as it is and says so", async () => {
    await configureAgentMcp({ agent: "qwen-code", scope: "user" });
    const before = await mcpConfig("qwen-code");
    expect(before.summerEngine).toBe(true);
    const { json } = await setup(["qwen-code", "--cli", "--yes", "--json"]);
    expect(json.existingMcpEntry).toBe(before.path);
    expect(json.warnings).toEqual([expect.stringContaining("still lists the summer-engine MCP server from an earlier setup")]);
    expect((await mcpConfig("qwen-code")).text).toBe(before.text);
  });

  it("names a Claude Code per-project summer-engine entry too", async () => {
    const path = (await mcpConfig("claude-code")).path;
    const current = existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>) : {};
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...current, projects: { "/work/game": { mcpServers: { "summer-engine": { type: "http", url: "https://example.invalid/mcp" } } } } }));
    const { json } = await setup(["claude-code", "--cli", "--yes", "--json"]);
    expect(json.existingMcpEntry).toBe(path);
  });

  it("--dry-run writes nothing", async () => {
    const { json } = await setup(["hermes", "--cli", "--dry-run", "--json"]);
    expect(json).toMatchObject({ mcp: false, skills: { status: "planned" } });
    expect(existsSync(skillFile("hermes", "summer-cli"))).toBe(false);
    expect(existsSync((await mcpConfig("hermes")).path)).toBe(false);
  });

  it("prints that the agent runs summer commands, without an MCP line", async () => {
    const { lines } = await setup(["qoder", "--cli", "--yes"]);
    const text = lines.join("\n");
    expect(text).toContain("CLI only for Qoder");
    expect(text).toContain("summer <area> <action>");
    expect(text).not.toContain("Linked to");
    expect(text).not.toContain("Summer Games");
  });

  it("refuses the options that only shape an MCP entry", async () => {
    for (const extra of [["--print"], ["--profile", "engine"], ["--local-dev"], ["--channel", "next"]]) {
      await expect(setup(["claude-code", "--cli", ...extra])).rejects.toThrow(/sets up the MCP entry, and --cli writes none/);
    }
  });

  it("refuses agents --cli cannot give skills", async () => {
    await expect(setup(["claude-desktop", "--cli"])).rejects.toThrow(/has no skills folder, so --cli has nothing to install/);
    await expect(setup(["gemini", "--cli"])).rejects.toThrow(/only through its extension/);
    await expect(setup(["roo-code", "--cli"])).rejects.toThrow(/rule files that tell it to use the MCP tools/);
  });

  it("is listed in --help", () => {
    const help = setupCommand.helpInformation();
    expect(help).toContain("--cli");
    expect(help).toContain("--no-mcp");
  });
});
