import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { configureAgentMcp, type SupportedAgent } from "../../installer/agent-config.js";
import { resolveInstallLocation } from "../../installer/skill-locations.js";
import { AGENT_IDS } from "../../installer/agent-table.js";
import { readRecordedMcpServer } from "../../installer/version-check.js";
import { notGitIgnored, setupCommand } from "./setup.js";
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

// Each test installs every skill for an agent into a scratch HOME: on a busy disk that takes far longer than the 20 s default.
describe("summer setup --cli: the skills and no MCP server", () => {
  it.each<SupportedAgent>(["claude-code", "codex", "cursor", "github-copilot", "goose", "mistral-vibe"])(
    "%s: writes the skills, summer-cli among them, and no MCP entry",
    async (agent) => {
      const { json } = await setup([agent, "--cli", "--yes", "--json"]);
      expect(json).toMatchObject({ ok: true, mcp: false, agent, config: null, games: null, existingMcpEntry: null, projectFiles: null });
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

  it("adds Claude Code and Codex allow rules only with --allow-rules, and --remove-allow-rules takes them out", async () => {
    const settings = join(homedir(), ".claude", "settings.json");
    const summerRules = () => (existsSync(settings) ? (JSON.parse(readFileSync(settings, "utf-8")).permissions?.allow ?? []) : []).filter((rule: string) => /^Bash\((summer|npx -y summer-engine@latest) /.test(rule));

    const plain = await setup(["claude-code", "--cli", "--yes"]);
    expect(plain.lines.join("\n")).toContain("summer setup claude-code --cli --allow-rules --yes");
    expect(summerRules()).toEqual([]);

    const planned = await setup(["claude-code", "--cli", "--allow-rules", "--json", "--scope", "project"]);
    expect(planned.json.allowRules).toMatchObject({ wrote: false });
    expect(existsSync((planned.json.allowRules as { path: string }).path)).toBe(false);

    const claude = await setup(["claude-code", "--cli", "--allow-rules", "--yes", "--json"]);
    expect(claude.json.allowRules).toMatchObject({ path: settings, wrote: true });
    expect(summerRules()).toContain("Bash(summer jobs wait *)");
    expect(summerRules().some((rule: string) => rule.includes(" store publish") || rule.includes("capture-gameplay"))).toBe(false);
    const codex = await setup(["codex", "--cli", "--allow-rules", "--yes", "--json"]);
    const codexFile = (codex.json.allowRules as { path: string }).path;
    expect(readFileSync(codexFile, "utf-8")).toContain("prefix_rule(");

    expect((await setup(["claude-code", "--remove-allow-rules", "--json"])).json.allowRules).toMatchObject({ wrote: true });
    expect(summerRules()).toEqual([]);
    await setup(["codex", "--remove-allow-rules"]);
    expect(existsSync(codexFile)).toBe(false);
  });

  it("says --allow-rules needs --cli instead of ignoring it", async () => {
    const errors: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation((line: unknown) => void errors.push(String(line)));
    try {
      await setup(["claude-code", "--allow-rules", "--yes", "--json"]);
    } finally {
      error.mockRestore();
    }
    expect(errors.join("\n")).toContain("--allow-rules works with --cli only");
  });

  it("knows when git would share a project's settings.local.json", () => {
    const repo = mkdtempSync(join(tmpdir(), "summer-gitignore-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
    git("init", "-q");
    const file = join(repo, ".claude", "settings.local.json");
    expect(notGitIgnored(file, repo)).toBe(true);
    writeFileSync(join(repo, ".gitignore"), ".claude/settings.local.json\n");
    expect(notGitIgnored(file, repo)).toBe(false);
    expect(notGitIgnored(file, mkdtempSync(join(tmpdir(), "summer-no-git-")))).toBe(false);
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
}, 120_000);

describe("summer setup inside a Summer project", () => {
  type ProjectFilesJson = { root: string; written: boolean; dryRun: boolean; files: Array<{ file: string; action: string }> } | null;
  const files = (json: Record<string, unknown>) => (json.projectFiles as ProjectFilesJson)?.files.map((f) => `${f.file} ${f.action}`);

  async function inProject(run: (project: string) => Promise<void>, layout: { gitAt?: "project" | "scenes" } = {}): Promise<void> {
    const project = mkdtempSync(join(tmpdir(), "summer-setup-project-"));
    writeFileSync(join(project, "project.godot"), "");
    mkdirSync(join(project, "scenes"));
    if (layout.gitAt) mkdirSync(join(project, ...(layout.gitAt === "scenes" ? ["scenes"] : []), ".git"));
    const cwd = process.cwd();
    process.chdir(join(project, "scenes"));
    try {
      await run(project);
    } finally {
      process.chdir(cwd);
      rmSync(project, { recursive: true, force: true });
    }
  }

  it("with --yes adds AGENTS.md and CLAUDE.md at the project root, and keeps a project's own AGENTS.md text", async () => {
    await inProject(async (project) => {
      writeFileSync(join(project, "AGENTS.md"), "# Our rules\n");
      const { json } = await setup(["amp", "--cli", "--yes", "--json"]);
      expect(json.projectFiles).toMatchObject({ written: true });
      expect(files(json)).toEqual(["AGENTS.md added", "CLAUDE.md created"]);
      expect(readFileSync(join(project, "AGENTS.md"), "utf-8")).toMatch(/^# Our rules\n\n<!-- summer-engine:start/);
      expect(readFileSync(join(project, "CLAUDE.md"), "utf-8")).toBe("@AGENTS.md\n");
      expect(files((await setup(["amp", "--cli", "--yes", "--json"])).json)).toEqual(["AGENTS.md unchanged", "CLAUDE.md unchanged"]);
    }, { gitAt: "project" });
  });

  it("without --yes only plans them, like the skills, and says how to add them", async () => {
    await inProject(async (project) => {
      const { json } = await setup(["amp", "--cli", "--json"]);
      expect(json.projectFiles).toMatchObject({ written: false, dryRun: false });
      expect(files(json)).toEqual(["AGENTS.md created", "CLAUDE.md created"]);
      expect(existsSync(join(project, "AGENTS.md"))).toBe(false);
      const { lines } = await setup(["amp", "--cli"]);
      expect(lines.join("\n")).toContain("Run the same setup command again with --yes to add them");
    });
  });

  it("the MCP setup does the same, and a dry run writes nothing", async () => {
    await inProject(async (project) => {
      const { json } = await setup(["claude-code", "--dry-run", "--yes", "--json"]);
      expect(json.projectFiles).toMatchObject({ written: false, dryRun: true });
      expect(files(json)).toEqual(["AGENTS.md created", "CLAUDE.md created"]);
      expect(existsSync(join(project, "AGENTS.md"))).toBe(false);
      expect(existsSync(join(project, "CLAUDE.md"))).toBe(false);
    });
  });

  it("leaves the project alone with --no-project-files and with --assets-only", async () => {
    await inProject(async (project) => {
      expect((await setup(["amp", "--cli", "--yes", "--no-project-files", "--json"])).json.projectFiles).toBeNull();
      expect((await setup(["amp", "--cli", "--assets-only", "--yes", "--json"])).json.projectFiles).toBeNull();
      expect(existsSync(join(project, "AGENTS.md"))).toBe(false);
    });
  });

  it("does not look above the git top level for project.godot", async () => {
    await inProject(async (project) => {
      expect((await setup(["amp", "--cli", "--yes", "--json"])).json.projectFiles).toBeNull();
      expect(existsSync(join(project, "AGENTS.md"))).toBe(false);
    }, { gitAt: "scenes" });
  });
});

describe("summer setup for the desktop installer: --detect, coded --json steps, a bundled runtime", () => {
  /** Runs setup with process.exit stubbed; returns the exit code it asked for (0 when none). */
  async function setupExit(args: string[]): Promise<{ json: Record<string, unknown>; lines: string[]; exitCode: number }> {
    let exitCode = 0;
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code ?? 0;
    }) as never);
    try {
      return { ...(await setup(args)), exitCode };
    } finally {
      exit.mockRestore();
    }
  }

  type Step = { step: string; ok: boolean; status: string; error?: { code: string; message: string } };
  const steps = (json: Record<string, unknown>) => json.steps as Step[];
  const step = (json: Record<string, unknown>, name: string) => steps(json).find((s) => s.step === name)!;

  function bundle(): { node: string; packageDir: string } {
    const root = mkdtempSync(join(tmpdir(), "summer-bundle-"));
    const node = join(root, "node", "bin", "node");
    const packageDir = join(root, "summer-engine");
    mkdirSync(join(node, ".."), { recursive: true });
    writeFileSync(node, "#!/bin/sh\n", { mode: 0o755 });
    mkdirSync(join(packageDir, "dist", "bin"), { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "summer-engine" }));
    writeFileSync(join(packageDir, "dist", "bin", "summer.js"), "");
    return { node, packageDir };
  }

  it("--detect --json lists every agent and writes nothing", async () => {
    const files = () => readdirSync(homedir(), { recursive: true }).map(String).sort();
    const before = files();
    const { json, exitCode } = await setupExit(["--detect", "--json"]);
    expect(files()).toEqual(before);
    expect(exitCode).toBe(0);
    expect(json.ok).toBe(true);
    const agents = json.agents as Array<Record<string, unknown>>;
    expect(agents.map((agent) => agent.id)).toEqual([...AGENT_IDS]);
    expect(agents[0]).toEqual(
      expect.objectContaining({ id: "claude-code", label: "Claude Code", installed: expect.any(Boolean), configPath: expect.any(String), mcpEntry: expect.any(Boolean) })
    );
  });

  it("--detect takes no agent", async () => {
    const { json, exitCode } = await setupExit(["claude-code", "--detect", "--json"]);
    expect(json).toMatchObject({ ok: false, error: { code: "invalid_option" } });
    expect(exitCode).toBe(1);
  });

  it("--json reports each step ok", async () => {
    const { json, exitCode } = await setupExit(["lm-studio", "--yes", "--json"]);
    expect(exitCode).toBe(0);
    expect(json.ok).toBe(true);
    expect(steps(json).map((s) => [s.step, s.ok, s.status])).toEqual([
      ["mcp_entry", true, expect.stringMatching(/^(written|unchanged)$/)],
      ["summer_games", true, "not_supported"],
      ["skills", true, "skipped"],
      ["project_files", true, "not_in_project"],
      ["doctor", true, "passed"],
    ]);
  });

  it("--json gives a broken config file a coded error, runs the other steps and exits 1", async () => {
    const path = (await mcpConfig("junie")).path;
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{ not json");
    try {
      const { json, exitCode } = await setupExit(["junie", "--yes", "--json"]);
      expect(exitCode).toBe(1);
      expect(json.ok).toBe(false);
      expect(step(json, "mcp_entry")).toMatchObject({ ok: false, status: "failed", error: { code: "config_invalid" } });
      expect(step(json, "summer_games")).toMatchObject({ ok: false, error: { code: "config_invalid" } });
      expect(step(json, "doctor")).toMatchObject({ ok: true });
      expect(json.config).toBeNull();
    } finally {
      rmSync(path);
    }
  });

  it("--runtime and --package-dir write the bundled node instead of npx", async () => {
    const { node, packageDir } = bundle();
    const { json, exitCode } = await setupExit(["lm-studio", "--runtime", node, "--package-dir", packageDir, "--yes", "--json"]);
    expect(exitCode).toBe(0);
    expect(json.config).toMatchObject({ runtime: { node, packageDir }, server: { command: node, args: [join(packageDir, "dist", "bin", "summer.js"), "mcp"] } });
    const recorded = readRecordedMcpServer((await mcpConfig("lm-studio")).text, "json");
    expect(recorded).toEqual({ command: node, args: [join(packageDir, "dist", "bin", "summer.js"), "mcp"] });

    const { lines } = await setupExit(["lm-studio", "--runtime", node, "--package-dir", packageDir, "--yes"]);
    expect(lines.join("\n")).toContain("(bundled runtime)");
  });

  it("refuses a missing runtime, a lone flag and a conflicting flag with a code", async () => {
    const { node, packageDir } = bundle();
    const code = async (args: string[]) => {
      const { json, exitCode } = await setupExit([...args, "--json"]);
      expect(exitCode).toBe(1);
      return (json.error as { code: string }).code;
    };
    expect(await code(["lm-studio", "--runtime", join(packageDir, "nope"), "--package-dir", packageDir])).toBe("runtime_not_found");
    expect(await code(["lm-studio", "--runtime", node])).toBe("runtime_incomplete");
    expect(await code(["lm-studio", "--runtime", node, "--package-dir", packageDir, "--local-dev"])).toBe("invalid_option");
    expect(await code(["claude-code", "--cli", "--runtime", node, "--package-dir", packageDir])).toBe("invalid_option");
    expect(await code(["no-such-agent"])).toBe("unknown_agent");
  });
});
