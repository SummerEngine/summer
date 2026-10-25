import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getSkillRegistry } from "../core/skills-registry.js";
import { refreshInstalledSkills } from "../installer/skills-refresh.js";
import { readSkillMarker, writeSkillMarker } from "../installer/version-check.js";
import { TOOLKIT_VERSION } from "../core/version.js";
import { installedSkillsBefore4, legacyHostedDescription, resolveLegacy, takeLegacyToolset } from "./legacy-toolset.js";
import { refreshSkillsAfterUpgrade } from "./server.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function skillsDir(version: string | null): { agent: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "summer-legacy-skills-"));
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  if (version) writeSkillMarker(dir, version);
  return { agent: "claude-code", dir };
}

describe("the legacy toolset", () => {
  it("is a word in --toolsets, not a toolset of its own", () => {
    expect(takeLegacyToolset("legacy")).toEqual({ toolsets: "", requested: true });
    expect(takeLegacyToolset("grow, LEGACY")).toEqual({ toolsets: "grow", requested: true });
    expect(takeLegacyToolset("grow")).toEqual({ toolsets: "grow", requested: false });
    expect(takeLegacyToolset(undefined)).toEqual({ toolsets: undefined, requested: false });
  });

  it("is on while installed Summer skills are older than 4.0", () => {
    expect(installedSkillsBefore4([skillsDir("3.9.1")])).toBe(true);
    expect(installedSkillsBefore4([skillsDir("4.0.0"), skillsDir(null)])).toBe(false);
    expect(installedSkillsBefore4([skillsDir("4.1.0"), skillsDir("3.2.0")])).toBe(true);
    expect(installedSkillsBefore4([])).toBe(false);
  });

  it("turns off for upgraded skills once the first 4.x start refreshed them", () => {
    const old = skillsDir("3.9.1");
    const [skill] = getSkillRegistry();
    mkdirSync(join(old.dir, skill.name));
    writeFileSync(join(old.dir, skill.name, "SKILL.md"), "3.x text\n");
    writeFileSync(join(old.dir, skill.name, "resource.yaml"), `id: skill/${skill.name}\n`);
    expect(installedSkillsBefore4([old])).toBe(true);
    refreshInstalledSkills("4.1.1", { dirs: [old.dir] });
    expect(installedSkillsBefore4([old])).toBe(false);
  });

  it("is refreshed away on the first v4 server start only, never on v3 or under doctor's probe", () => {
    // This test deletes ~/.agents/skills: only ever under the faked HOME (src/test-helpers/fake-home.ts).
    if (!homedir().startsWith(realpathSync(tmpdir()))) throw new Error(`HOME is not a test folder: ${homedir()}`);
    const shared = join(homedir(), ".agents", "skills");
    const [skill] = getSkillRegistry();
    mkdirSync(join(shared, skill.name), { recursive: true });
    writeFileSync(join(shared, skill.name, "SKILL.md"), "3.x text\n");
    writeFileSync(join(shared, skill.name, "resource.yaml"), `id: skill/${skill.name}\n`);
    writeSkillMarker(shared, "3.9.1");
    try {
      expect(refreshSkillsAfterUpgrade("v3")).toBeNull();
      process.env.SUMMER_MCP_DOCTOR = "1";
      expect(refreshSkillsAfterUpgrade("v4")).toBeNull();
      delete process.env.SUMMER_MCP_DOCTOR;
      expect(readSkillMarker(shared)?.version).toBe("3.9.1");
      expect(refreshSkillsAfterUpgrade("v4")).toMatch(/^Summer updated its 1 installed skills \(1 folder\) from 3\.9\.1 to /);
      expect(readSkillMarker(shared)?.version).toBe(TOOLKIT_VERSION);
      expect(readFileSync(join(shared, skill.name, "SKILL.md"), "utf-8")).not.toBe("3.x text\n");
    } finally {
      delete process.env.SUMMER_MCP_DOCTOR;
      rmSync(shared, { recursive: true, force: true });
    }
  });

  it("follows --toolsets first, then SUMMER_LEGACY_TOOLS, then the skills", () => {
    const old = () => true;
    const fresh = () => false;
    expect(resolveLegacy(true, { SUMMER_LEGACY_TOOLS: "off" }, fresh)).toEqual({ on: true, reason: "toolsets" });
    expect(resolveLegacy(false, { SUMMER_LEGACY_TOOLS: "on" }, fresh)).toEqual({ on: true, reason: "env" });
    expect(resolveLegacy(false, { SUMMER_LEGACY_TOOLS: "off" }, old)).toEqual({ on: false, reason: "off" });
    expect(resolveLegacy(false, {}, old)).toEqual({ on: true, reason: "skills" });
    expect(resolveLegacy(false, {}, fresh)).toEqual({ on: false, reason: "off" });
  });

  it("describes a hosted 3.x tool by the operation that replaces it", () => {
    expect(legacyHostedDescription({ name: "summer_store_submit", description: "Submit the game for the owner's approval. Returns the approval link. More text." })).toBe(
      "3.x name; use store.publish. Submit the game for the owner's approval."
    );
  });
});
