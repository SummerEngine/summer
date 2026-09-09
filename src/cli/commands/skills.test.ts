import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PACKAGE_ROOT } from "../../core/package-root.js";
import { skillsCommand } from "./skills.js";

vi.mock("../../core/skills-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/skills-registry.js")>();
  const entry = (name: string, status: string, recommended: boolean) => ({
    id: `skill/${name}`,
    name,
    description: `${name} description`,
    recommended,
    status,
    path: "library/skills/3d-lighting/",
  });
  return {
    ...actual,
    getSkillRegistry: () => [entry("stable-skill", "stable", true), entry("intake-skill", "preview", false)],
    // Every fixture entry resolves to a real skill dir so the SKILL.md check passes.
    resolveSkillDir: () => join(PACKAGE_ROOT, "library", "skills", "3d-lighting"),
  };
});

describe("summer skills: preview skills", () => {
  it("list tags preview skills and names the opt-out flag", async () => {
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      await skillsCommand.parseAsync(["list"], { from: "user" });
    } finally {
      log.mockRestore();
    }
    const output = lines.join("\n");
    expect(output).toMatch(/intake-skill\s+optional\s+\[preview\] intake-skill description/);
    expect(output).toMatch(/stable-skill\s+recommended\s+stable-skill description/);
    expect(output).toContain("--stable-only");
    expect(output).not.toContain("--include-preview");
  });

  it("install exposes --stable-only and hides the --include-preview alias", () => {
    const install = skillsCommand.commands.find((command) => command.name() === "install")!;
    const longs = install.options.map((option) => option.long);
    expect(longs).toContain("--stable-only");
    expect(longs).toContain("--include-preview");
    expect(install.options.find((option) => option.long === "--include-preview")?.hidden).toBe(true);
    expect(install.helpInformation()).toContain("--stable-only");
    expect(install.helpInformation()).not.toContain("--include-preview");
  });
});
