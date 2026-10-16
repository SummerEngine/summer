import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { LEGACY_SKILL_SLUGS_2_8_2, pruneRetiredSkills, retiredSkillNames } from "./legacy-skills.js";

let dir = "";
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe("retired 2.8.x skills are pruned on --force upgrades (release review P1-2)", () => {
  it("summer-cloud and the un-prefixed vfx recipes are retired against the current registry", () => {
    const current = ["play", "vfx-fire", "vfx-smoke", "using-summer"];
    const retired = retiredSkillNames(current);
    expect(retired).toContain("summer-cloud");
    expect(retired).toContain("fire");
    expect(retired).not.toContain("play");
    expect(retired).not.toContain("using-summer");
    expect(LEGACY_SKILL_SLUGS_2_8_2.length).toBe(79);
  });

  it("also retires v3 skills that were renamed (ai-characters-in-games is now summer-router)", () => {
    expect(retiredSkillNames(["summer-router"])).toContain("ai-characters-in-games");
    expect(retiredSkillNames(["ai-characters-in-games"])).not.toContain("ai-characters-in-games");
  });

  it("removes only retired dirs that hold a SKILL.md; keeps current skills and foreign folders", () => {
    dir = mkdtempSync(join(tmpdir(), "summer-prune-"));
    for (const name of ["summer-cloud", "fire", "play"]) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "SKILL.md"), "---\nname: x\n---\n");
    }
    mkdirSync(join(dir, "smoke")); // same name as a retired skill, but not a skill Summer wrote
    writeFileSync(join(dir, "smoke", "notes.txt"), "mine");
    const pruned = pruneRetiredSkills(dir, ["play", "vfx-fire", "vfx-smoke"]);
    expect(pruned.map((p) => p.name).sort()).toEqual(["fire", "summer-cloud"]);
    expect(existsSync(join(dir, "play", "SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, "smoke", "notes.txt"))).toBe(true);
    expect(existsSync(join(dir, "summer-cloud"))).toBe(false);
  });
});
