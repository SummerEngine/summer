import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeSkillMarker } from "../installer/version-check.js";
import { installedSkillsBefore4, legacyHostedDescription, resolveLegacy, takeLegacyToolset } from "./legacy-toolset.js";

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
