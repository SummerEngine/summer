import { describe, expect, it } from "vitest";
import {
  isGodotSafeSaveTemp,
  isHardExcludedDir,
  isHardExcludedFile,
  isHardExcludedPath,
  isIgnoredByRules,
  isTrackedByCurrentRules,
  parseIgnoreRules,
  RULES_VERSION,
} from "./rules.js";

const rules = (raw: string) => ({ rulesVersion: RULES_VERSION, ignore: parseIgnoreRules(raw) });

describe("hard excludes (spec 13)", () => {
  it("excludes the spec directory list at any depth", () => {
    for (const name of [".git", ".godot", "node_modules", ".next", ".claude", ".specstory"]) {
      expect(isHardExcludedDir(name, name)).toBe(true);
      expect(isHardExcludedDir(`sub/${name}`, name)).toBe(true);
    }
  });

  it("excludes /android/ at the root only", () => {
    expect(isHardExcludedDir("android", "android")).toBe(true);
    expect(isHardExcludedDir("addons/android", "android")).toBe(false);
  });

  it("excludes .summer/local but keeps the rest of .summer", () => {
    expect(isHardExcludedDir(".summer/local", "local")).toBe(true);
    expect(isHardExcludedDir(".summer", ".summer")).toBe(false);
    expect(isHardExcludedDir(".summer/skills", "skills")).toBe(false);
  });

  it("excludes secret and junk files", () => {
    const none = new Set<string>();
    expect(isHardExcludedFile(".env", ".env", none)).toBe(true);
    expect(isHardExcludedFile(".env.local", ".env.local", none)).toBe(true);
    expect(isHardExcludedFile("sub/.env.production", ".env.production", none)).toBe(true);
    expect(isHardExcludedFile(".DS_Store", ".DS_Store", none)).toBe(true);
    expect(isHardExcludedFile("Thumbs.db", "Thumbs.db", none)).toBe(true);
    expect(isHardExcludedFile("desktop.ini", "desktop.ini", none)).toBe(true);
    expect(isHardExcludedFile("project.godot.bak", "project.godot.bak", none)).toBe(true);
    expect(isHardExcludedFile("ui.translation", "ui.translation", none)).toBe(true);
    expect(isHardExcludedFile("scratch.tmp", "scratch.tmp", none)).toBe(true);
    expect(isHardExcludedFile("environment.gd", "environment.gd", none)).toBe(false);
  });

  it("excludes Godot safe-save temps only when the base file is present", () => {
    const siblings = new Set(["level.tscn"]);
    expect(isGodotSafeSaveTemp("level.tscn-Abc123", siblings)).toBe(true);
    expect(isGodotSafeSaveTemp("level.tscn-Abc123", new Set())).toBe(false);
    expect(isGodotSafeSaveTemp("level.tscn-Abc12", siblings)).toBe(false); // five chars
    expect(isHardExcludedFile("level.tscn-Abc123", "level.tscn-Abc123", siblings)).toBe(true);
  });

  it("isHardExcludedPath evaluates whole manifest keys", () => {
    expect(isHardExcludedPath(".summer/local/cloud/base.json")).toBe(true);
    expect(isHardExcludedPath("node_modules/lib/index.js")).toBe(true);
    expect(isHardExcludedPath("sub/.env")).toBe(true);
    expect(isHardExcludedPath("scripts/player.gd")).toBe(false);
    expect(isHardExcludedPath(".summer/skills/skill.md")).toBe(false);
  });
});

describe(".summercloudignore (exclude-only, gitignore syntax)", () => {
  it("matches plain names at any depth", () => {
    const r = rules("*.blend\nbuild/");
    expect(isIgnoredByRules("model.blend", false, r)).toBe(true);
    expect(isIgnoredByRules("assets/model.blend", false, r)).toBe(true);
    expect(isIgnoredByRules("build", true, r)).toBe(true);
    expect(isIgnoredByRules("build/out.exe", false, r)).toBe(true);
    expect(isIgnoredByRules("scripts/build.gd", false, r)).toBe(false);
  });

  it("anchors leading-slash patterns to the root", () => {
    const r = rules("/temp");
    expect(isIgnoredByRules("temp", false, r)).toBe(true);
    expect(isIgnoredByRules("assets/temp", false, r)).toBe(false);
  });

  it("ignores comments and never re-includes (no ! support)", () => {
    const r = rules("# comment\n!keep.gd\n*.bak");
    expect(isIgnoredByRules("keep.gd", false, r)).toBe(false);
    expect(isIgnoredByRules("a.bak", false, r)).toBe(true);
  });
});

describe("deletion semantics (spec 13)", () => {
  it("tracked paths are deletable, untracked paths are carried forward", () => {
    const r = rules("*.blend");
    expect(isTrackedByCurrentRules("scripts/player.gd", r)).toBe(true);
    expect(isTrackedByCurrentRules("model.blend", r)).toBe(false); // user-ignored
    expect(isTrackedByCurrentRules(".env", r)).toBe(false); // hard exclude
    expect(isTrackedByCurrentRules("summer-cloud.json", r)).toBe(false);
  });
});
