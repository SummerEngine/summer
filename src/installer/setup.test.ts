import { describe, expect, it, vi } from "vitest";
import { setupSkills } from "./setup.js";

// Four fixture skills: two stable, two preview, one of each recommended.
vi.mock("../core/skills-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/skills-registry.js")>();
  const entry = (name: string, status: string, recommended: boolean) => ({
    id: `skill/${name}`,
    name,
    description: name,
    recommended,
    status,
    path: `library/skills/${name}/`,
  });
  return {
    ...actual,
    getSkillRegistry: () => [
      entry("stable-rec", "stable", true),
      entry("stable-opt", "stable", false),
      entry("preview-rec", "preview", true),
      entry("preview-opt", "preview", false),
    ],
  };
});

// dryRun: setupSkills plans and never spawns `skills install`.
const base = { dryRun: true, yes: false, force: false };

describe("setupSkills: preview skills install by default", () => {
  it("plans every skill by default and says how many of them are preview", () => {
    const result = setupSkills("claude-code", base);
    expect(result.status).toBe("planned");
    expect(result.count).toBe(4);
    expect(result.previewIncluded).toBe(2);
    expect(result.previewSkipped).toBe(0);
    expect(result.message).toContain(
      "Would install 4 skills (2 preview — labelled in each skill's guidance; use --stable-only to skip)"
    );
    expect(result.command).toContain("--all");
    expect(result.command).not.toContain("--stable-only");
    expect(result.command).not.toContain("--include-preview");
  });

  it("--stable-only plans stable skills only and passes the flag to `skills install`", () => {
    const result = setupSkills("claude-code", { ...base, stableOnly: true });
    expect(result.count).toBe(2);
    expect(result.previewIncluded).toBe(0);
    expect(result.previewSkipped).toBe(2);
    expect(result.message).toContain("Would install 2 skills (2 preview skipped by --stable-only)");
    expect(result.command).toContain("--stable-only");
    expect(result.command).toContain("--all");
  });

  it("--recommended applies the same rule inside the subset", () => {
    const result = setupSkills("claude-code", { ...base, recommended: true });
    expect(result.count).toBe(2);
    expect(result.previewIncluded).toBe(1);
    expect(result.command).toContain("--recommended");
    const stableOnly = setupSkills("claude-code", { ...base, recommended: true, stableOnly: true });
    expect(stableOnly.count).toBe(1);
    expect(stableOnly.previewSkipped).toBe(1);
  });
});
