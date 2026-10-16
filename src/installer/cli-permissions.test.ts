import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { addAllowRules, allowedCliCommands, allowRulesPath, claudeAllowRules, cliLauncher, codexRules, NPX_LAUNCHER, SUMMER_LAUNCHER } from "./cli-permissions.js";

const scratch = () => mkdtempSync(join(tmpdir(), "summer-allow-rules-"));
const rulesFor = (launcher = SUMMER_LAUNCHER) => claudeAllowRules(launcher);

describe("the commands an agent runs without asking", () => {
  it("are the read operations, and the spends only as dry runs", () => {
    const rules = rulesFor();
    for (const rule of ["Bash(summer ops search *)", "Bash(summer ops describe *)", "Bash(summer whoami *)", "Bash(summer status *)", "Bash(summer jobs wait *)", "Bash(summer engine screenshot *)", "Bash(summer docs search *)", "Bash(summer assets generate-image --dry-run *)", "Bash(summer assets generate-3d --dry-run *)"]) {
      expect(rules).toContain(rule);
    }
    expect(allowedCliCommands().find((command) => command.words.join(" ") === "assets generate-image")).toEqual({ words: ["assets", "generate-image"], dryRun: true });
  });

  it("never a change, a publish, a price, a delete or a message", () => {
    const text = rulesFor().join("\n");
    for (const command of ["store publish", "store release", "pricing set-base", "engine set-prop", "engine write-file", "assets delete", "team invite", "games invite-member", "docs feedback", "account set-permissions"]) {
      expect(text).not.toContain(`summer ${command} `);
    }
    expect(rulesFor().filter((rule) => !rule.endsWith(" --dry-run *)")).every((rule) => !rule.includes("generate"))).toBe(true);
  });

  it("use summer when it is on PATH outside an npx cache, else the npx form", () => {
    const bin = scratch();
    writeFileSync(join(bin, "summer"), "");
    expect(cliLauncher({ PATH: [bin, "/usr/bin"].join(delimiter) }, "linux")).toEqual(SUMMER_LAUNCHER);
    const npx = join(scratch(), "_npx", "abc", "node_modules", ".bin");
    mkdirSync(npx, { recursive: true });
    writeFileSync(join(npx, "summer"), "");
    expect(cliLauncher({ PATH: npx }, "linux")).toEqual(NPX_LAUNCHER);
    expect(rulesFor(NPX_LAUNCHER)).toContain("Bash(npx -y summer-engine@latest jobs wait *)");
  });
});

describe("Claude Code settings", () => {
  it("adds the rules to permissions.allow and keeps everything else", async () => {
    const path = join(scratch(), "settings.json");
    writeFileSync(path, JSON.stringify({ model: "opus", permissions: { allow: ["Bash(git status *)"], deny: ["Bash(rm *)"] } }));
    const env = { PATH: "" };
    const first = await addAllowRules("claude-code", path, true, env);
    expect(first.wrote).toBe(true);
    const settings = JSON.parse(readFileSync(path, "utf8"));
    expect(settings).toMatchObject({ model: "opus", permissions: { deny: ["Bash(rm *)"] } });
    expect(settings.permissions.allow[0]).toBe("Bash(git status *)");
    expect(settings.permissions.allow).toContain("Bash(npx -y summer-engine@latest ops search *)");
    const again = await addAllowRules("claude-code", path, true, env);
    expect(again).toMatchObject({ added: [], wrote: false });
  });

  it("writes nothing without write, and refuses a file that is not JSON", async () => {
    const dir = scratch();
    const missing = join(dir, "settings.json");
    expect((await addAllowRules("claude-code", missing, false)).wrote).toBe(false);
    expect(() => readFileSync(missing)).toThrow();
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{ not json");
    await expect(addAllowRules("claude-code", broken, true)).rejects.toThrow(/not valid JSON/);
  });

  it("go to the user settings, or the project's personal settings", () => {
    const ctx = { home: "/h", os: "linux" as const, env: {}, cwd: "/p" };
    expect(allowRulesPath("claude-code", "user", ctx)).toBe(join("/h", ".claude", "settings.json"));
    expect(allowRulesPath("claude-code", "project", ctx)).toBe(join("/p", ".claude", "settings.local.json"));
    expect(allowRulesPath("codex", "user", { ...ctx, env: { CODEX_HOME: "/c" } })).toBe(join("/c", "rules", "summer.rules"));
  });
});

describe("Codex rules", () => {
  it("are Summer's own rules file, one prefix_rule per area and kind, for both launchers", async () => {
    const text = codexRules();
    expect(text).toMatch(/pattern = \["summer", "assets", \[[^\]]*"generate-image"[^\]]*\], "--dry-run"\],/);
    expect(text).toContain('pattern = ["npx", "-y", "summer-engine@latest", "jobs", ["get", "list", "wait"]],');
    expect(text).not.toMatch(/"publish"|"set-base"|"set-prop"/);
    const path = join(scratch(), "rules", "summer.rules");
    expect((await addAllowRules("codex", path, true)).wrote).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(text);
    expect((await addAllowRules("codex", path, true)).wrote).toBe(false);
  });
});
