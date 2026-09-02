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

describe("summer skills: preview intake", () => {
  it("list tags preview skills and names the opt-in flag", async () => {
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
    expect(output).toContain("--include-preview");
  });

  it("install exposes --include-preview", () => {
    const install = skillsCommand.commands.find((command) => command.name() === "install")!;
    expect(install.options.map((option) => option.long)).toContain("--include-preview");
    expect(install.helpInformation()).toContain("--include-preview");
  });
});
