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

describe("setupSkills: preview skills are opt-in", () => {
  it("plans stable skills only by default and says how many preview it skipped", () => {
    const result = setupSkills("claude-code", base);
    expect(result.status).toBe("planned");
    expect(result.count).toBe(2);
    expect(result.previewSkipped).toBe(2);
    expect(result.message).toContain("Would install 2 skills (2 preview skipped — use --include-preview)");
    expect(result.command).not.toContain("--include-preview");
  });

  it("--include-preview plans every skill and passes the flag to `skills install`", () => {
    const result = setupSkills("claude-code", { ...base, includePreview: true });
    expect(result.count).toBe(4);
    expect(result.previewSkipped).toBe(0);
    expect(result.message).not.toContain("preview skipped");
    expect(result.command).toContain("--include-preview");
    expect(result.command).toContain("--all");
  });

  it("--recommended applies the same rule inside the subset", () => {
    const result = setupSkills("claude-code", { ...base, recommended: true });
    expect(result.count).toBe(1);
    expect(result.previewSkipped).toBe(1);
    expect(result.command).toContain("--recommended");
  });
});
