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
  it("--all takes stable skills only and counts the preview ones it left out", () => {
    const result = selectSkillsForBulkInstall(SKILLS, {});
    expect(names(result.selected)).toEqual(["stable-rec", "stable-opt"]);
    expect(result.previewSkipped).toBe(2);
  });

  it("--include-preview adds preview skills; deprecated never installs in bulk", () => {
    const result = selectSkillsForBulkInstall(SKILLS, { includePreview: true });
    expect(names(result.selected)).toEqual(["stable-rec", "stable-opt", "preview-rec", "preview-opt"]);
    expect(result.previewSkipped).toBe(0);
  });

  it("--recommended applies the same rule inside the subset", () => {
    expect(names(selectSkillsForBulkInstall(SKILLS, { recommended: true }).selected)).toEqual(["stable-rec"]);
    expect(selectSkillsForBulkInstall(SKILLS, { recommended: true }).previewSkipped).toBe(1);
    expect(
      names(selectSkillsForBulkInstall(SKILLS, { recommended: true, includePreview: true }).selected)
    ).toEqual(["stable-rec", "preview-rec"]);
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
