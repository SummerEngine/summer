import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getSkillRegistry, resolveSkillDir } from "../core/skills-registry.js";
import { refreshInstalledSkills, refreshNotice } from "./skills-refresh.js";
import { readSkillMarker, writeSkillMarker } from "./version-check.js";

const registry = getSkillRegistry();
const [first, second] = registry;

/** A skills folder as 3.x left it: two Summer skills with old text, a person's own skill, a 3.x marker. */
function oldInstall(markerVersion = "3.9.1"): string {
  const dir = mkdtempSync(join(tmpdir(), "summer-skills-refresh-"));
  for (const entry of [first, second]) {
    mkdirSync(join(dir, entry.name), { recursive: true });
    writeFileSync(join(dir, entry.name, "SKILL.md"), "old 3.x text naming summer_add_node\n");
  }
  mkdirSync(join(dir, "my-own-skill"), { recursive: true });
  writeFileSync(join(dir, "my-own-skill", "SKILL.md"), "mine\n");
  writeSkillMarker(dir, markerVersion);
  return dir;
}

describe("refreshInstalledSkills", () => {
  it("brings the Summer skills a 3.x install left to this version, and nothing else", () => {
    const dir = oldInstall();
    const refreshed = refreshInstalledSkills("4.1.1", { dirs: [dir], registry });
    expect(refreshed).toEqual([{ dir, from: "3.9.1", to: "4.1.1", skills: 2 }]);
    expect(readFileSync(join(dir, first.name, "SKILL.md"), "utf-8")).toBe(readFileSync(join(resolveSkillDir(first), "SKILL.md"), "utf-8"));
    expect(readFileSync(join(dir, "my-own-skill", "SKILL.md"), "utf-8")).toBe("mine\n");
    // Nothing is added: the third library skill was not installed and stays out.
    expect(existsSync(join(dir, registry[2].name))).toBe(false);
    expect(readSkillMarker(dir)?.version).toBe("4.1.1");
  });

  it("runs once per version, and leaves a newer or an unmarked folder alone", () => {
    const dir = oldInstall();
    expect(refreshInstalledSkills("4.1.1", { dirs: [dir], registry })).toHaveLength(1);
    expect(refreshInstalledSkills("4.1.1", { dirs: [dir], registry })).toEqual([]);
    expect(refreshInstalledSkills("4.1.1", { dirs: [oldInstall("4.2.0")], registry })).toEqual([]);
    const unmarked = mkdtempSync(join(tmpdir(), "summer-skills-unmarked-"));
    mkdirSync(join(unmarked, first.name));
    writeFileSync(join(unmarked, first.name, "SKILL.md"), "someone else's\n");
    expect(refreshInstalledSkills("4.1.1", { dirs: [unmarked], registry })).toEqual([]);
    expect(readFileSync(join(unmarked, first.name, "SKILL.md"), "utf-8")).toBe("someone else's\n");
  });

  it("says what changed in one line", () => {
    expect(refreshNotice([])).toBeNull();
    expect(refreshNotice([{ dir: "a", from: "3.9.1", to: "4.1.1", skills: 115 }])).toBe(
      "Summer updated 115 installed skills from 3.9.1 to 4.1.1; the agent loads them in its next session."
    );
  });
});
