import { describe, expect, it } from "vitest";
import {
  parseSkillRegistry,
  selectSkillsForBulkInstall,
  type SkillRegistryEntry,
  type SkillStatus,
} from "./skills-registry.js";

const entry = (name: string, status: SkillStatus, recommended = false): SkillRegistryEntry => ({
  id: `skill/${name}`,
  name,
  description: name,
  recommended,
  status,
  path: `library/skills/${name}/`,
});

const SKILLS = [
  entry("stable-rec", "stable", true),
  entry("stable-opt", "stable"),
  entry("preview-rec", "preview", true),
  entry("preview-opt", "preview"),
  entry("old", "deprecated", true),
];
const names = (skills: SkillRegistryEntry[]) => skills.map((skill) => skill.name);

describe("selectSkillsForBulkInstall", () => {
  it("--all installs stable and preview skills by default; deprecated never installs in bulk", () => {
    const result = selectSkillsForBulkInstall(SKILLS, {});
    expect(names(result.selected)).toEqual(["stable-rec", "stable-opt", "preview-rec", "preview-opt"]);
    expect(result.previewIncluded).toBe(2);
    expect(result.previewSkipped).toBe(0);
  });

  it("--stable-only leaves preview skills out and counts what it skipped", () => {
    const result = selectSkillsForBulkInstall(SKILLS, { stableOnly: true });
    expect(names(result.selected)).toEqual(["stable-rec", "stable-opt"]);
    expect(result.previewIncluded).toBe(0);
    expect(result.previewSkipped).toBe(2);
  });

  it("--recommended applies the same rule inside the subset", () => {
    const byDefault = selectSkillsForBulkInstall(SKILLS, { recommended: true });
    expect(names(byDefault.selected)).toEqual(["stable-rec", "preview-rec"]);
    expect(byDefault.previewIncluded).toBe(1);
    const stableOnly = selectSkillsForBulkInstall(SKILLS, { recommended: true, stableOnly: true });
    expect(names(stableOnly.selected)).toEqual(["stable-rec"]);
    expect(stableOnly.previewSkipped).toBe(1);
  });
});

describe("parseSkillRegistry", () => {
  it("reads status, and treats a registry generated before the field existed as stable", () => {
    const parsed = parseSkillRegistry({
      skills: [
        { id: "skill/a", name: "a", path: "library/skills/a/", recommended: true, status: "preview" },
        { id: "skill/b", name: "b", path: "library/skills/b/" },
        { id: "skill/c", name: "c", path: "library/skills/c/", status: "nonsense" },
        { id: "skill/broken", name: 42, path: "library/skills/broken/" },
      ],
    });
    expect(parsed.map((skill) => [skill.name, skill.status, skill.recommended])).toEqual([
      ["a", "preview", true],
      ["b", "stable", false],
      ["c", "stable", false],
    ]);
  });
});
