import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localEntries } from "../core/ops/catalog.js";
import { shippedCloudEntries } from "../core/ops/public-catalog.js";
import { addAllowRules, allowedCliCommands, allowRulesPath, AUTO_ALLOWED_READS, claudeAllowRules, codexRules, LAUNCHERS, removeAllowRules } from "./cli-permissions.js";

const scratch = () => mkdtempSync(join(tmpdir(), "summer-allow-rules-"));
const catalog = () => [...localEntries(), ...shippedCloudEntries()];
const words = (op: string) => (op.includes(".") ? `${op.split(".")[0]} ${op.split(".")[1].replace(/_/g, "-")}` : op);

describe("the commands an agent may run without asking", () => {
  it("are a reviewed list: a change to it fails here until someone looks at it", () => {
    expect(allowedCliCommands().map(({ words: parts, dryRun }) => `${parts.join(" ")}${dryRun ? " --dry-run" : ""}`)).toMatchSnapshot();
  });

  it("name only read operations of the catalog in the reviewed reads", () => {
    const effects = new Map(catalog().map((entry) => [entry.name, entry.effect]));
    for (const op of AUTO_ALLOWED_READS) expect(effects.get(op), op).toBe("read");
  });

  it("give every catalog operation exactly its rule: a reviewed read as it is, a current spend only as a dry run, anything else none", () => {
    const rules = claudeAllowRules();
    for (const entry of catalog()) {
      for (const launcher of LAUNCHERS) {
        const prefix = `Bash(${[...launcher, words(entry.name)].join(" ")} `;
        const mine = rules.filter((rule) => rule.startsWith(prefix));
        const want = entry.effect === "spend" && entry.status !== "deprecated" ? [`${prefix}--dry-run *)`] : AUTO_ALLOWED_READS.includes(entry.name) ? [`${prefix}*)`] : [];
        expect(mine, `${launcher.join(" ")} ${entry.name} (${entry.effect})`).toEqual(want);
      }
    }
  });

  it("never run engine capture-gameplay (it runs the project's own code) or studio open (it opens the browser)", () => {
    const text = `${claudeAllowRules().join("\n")}\n${codexRules()}`;
    expect(text).not.toContain("capture-gameplay");
    expect(text).not.toMatch(/studio open|"studio", \[[^\]]*"open"/);
  });

  it("cover both launchers, so a Homebrew summer and the npx form both run without asking", () => {
    const rules = claudeAllowRules();
    expect(rules).toContain("Bash(summer jobs wait *)");
    expect(rules).toContain("Bash(npx -y summer-engine@latest jobs wait *)");
    expect(rules).toContain("Bash(summer assets generate-image --dry-run *)");
    expect(codexRules()).toContain('pattern = ["npx", "-y", "summer-engine@latest", "jobs", ["get", "list", "wait"]],');
  });
});

describe("Claude Code settings", () => {
  it("adds the rules to permissions.allow, keeps everything else, and removes exactly them again", async () => {
    const path = join(scratch(), "settings.json");
    writeFileSync(path, JSON.stringify({ model: "opus", permissions: { allow: ["Bash(git status *)", "Bash(summer engine set-prop *)"], deny: ["Bash(rm *)"] } }));
    expect((await addAllowRules("claude-code", path, true)).wrote).toBe(true);
    const settings = JSON.parse(readFileSync(path, "utf8"));
    expect(settings).toMatchObject({ model: "opus", permissions: { deny: ["Bash(rm *)"] } });
    expect(settings.permissions.allow.slice(0, 2)).toEqual(["Bash(git status *)", "Bash(summer engine set-prop *)"]);
    expect(settings.permissions.allow).toContain("Bash(summer ops search *)");
    expect(await addAllowRules("claude-code", path, true)).toMatchObject({ changed: [], wrote: false });
    const removed = await removeAllowRules("claude-code", path, true);
    expect(removed.changed.length).toBe(claudeAllowRules().length);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ model: "opus", permissions: { allow: ["Bash(git status *)", "Bash(summer engine set-prop *)"], deny: ["Bash(rm *)"] } });
    expect(readdirSync(join(path, ".."))).toEqual(["settings.json"]);
  });

  it("writes through a symlinked settings file (a dotfiles repo) and keeps its mode", async () => {
    const dir = scratch();
    const real = join(dir, "dotfiles", "claude-settings.json");
    mkdirSync(join(dir, "dotfiles"));
    writeFileSync(real, JSON.stringify({ model: "opus" }));
    chmodSync(real, 0o600);
    const link = join(dir, "settings.json");
    symlinkSync(real, link);
    await addAllowRules("claude-code", link, true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf8")).permissions.allow).toContain("Bash(summer ops search *)");
    expect(statSync(real).mode & 0o777).toBe(0o600);
    await removeAllowRules("claude-code", link, true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf8"))).toEqual({ model: "opus", permissions: { allow: [] } });
    expect(readdirSync(join(dir, "dotfiles"))).toEqual(["claude-settings.json"]);
  });

  it("writes nothing without write, and leaves a file it cannot read safely alone", async () => {
    const dir = scratch();
    const missing = join(dir, "settings.json");
    expect((await addAllowRules("claude-code", missing, false)).wrote).toBe(false);
    expect(existsSync(missing)).toBe(false);
    for (const [name, body, message] of [
      ["broken.json", "{ not json", /not valid JSON/],
      ["null.json", "null", /not a JSON object/],
      ["list.json", "[]", /not a JSON object/],
      ["allow.json", JSON.stringify({ permissions: { allow: "Bash(ls *)" } }), /permissions.allow is not a list/],
    ] as const) {
      const path = join(dir, name);
      writeFileSync(path, body);
      await expect(addAllowRules("claude-code", path, true), name).rejects.toThrow(message);
      expect(readFileSync(path, "utf8"), name).toBe(body);
    }
  });

  it("go to the user settings, or the project's personal settings; Codex rules always to the user's folder", () => {
    const ctx = { home: "/h", os: "linux" as const, env: {}, cwd: "/p" };
    expect(allowRulesPath("claude-code", "user", ctx)).toBe(join("/h", ".claude", "settings.json"));
    expect(allowRulesPath("claude-code", "project", ctx)).toBe(join("/p", ".claude", "settings.local.json"));
    expect(allowRulesPath("codex", "project", ctx)).toBe(join("/h", ".codex", "rules", "summer.rules"));
    expect(allowRulesPath("codex", "user", { ...ctx, env: { CODEX_HOME: "/c" } })).toBe(join("/c", "rules", "summer.rules"));
  });
});

describe("Codex rules", () => {
  it("are Summer's own file, one prefix_rule per area and kind; --remove-allow-rules deletes it", async () => {
    const text = codexRules();
    expect(text).toMatch(/pattern = \["summer", "assets", \[[^\]]*"generate-image"[^\]]*\], "--dry-run"\],/);
    expect(text).not.toMatch(/"publish"|"set-base"|"set-prop"/);
    const path = join(scratch(), "rules", "summer.rules");
    expect((await addAllowRules("codex", path, true)).wrote).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(text);
    expect((await addAllowRules("codex", path, true)).wrote).toBe(false);
    expect((await removeAllowRules("codex", path, true)).wrote).toBe(true);
    expect(existsSync(path)).toBe(false);
    const theirs = join(scratch(), "default.rules");
    writeFileSync(theirs, 'prefix_rule(pattern = ["ls"])\n');
    expect((await removeAllowRules("codex", theirs, true)).wrote).toBe(false);
    expect(existsSync(theirs)).toBe(true);
  });
});
