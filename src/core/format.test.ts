import { homedir } from "os";
import { describe, expect, it } from "vitest";
import { stripAnsi, tildeify } from "./format.js";

describe("tildeify", () => {
  it("replaces home directory prefix with ~", () => {
    const home = homedir();
    expect(tildeify(home + "/.claude.json")).toBe("~/.claude.json");
    expect(tildeify(home + "/projects/foo")).toBe("~/projects/foo");
  });

  it("returns ~ when path is the home directory exactly", () => {
    expect(tildeify(homedir())).toBe("~");
  });

  it("does not touch non-home paths", () => {
    expect(tildeify("/Applications/Summer.app")).toBe("/Applications/Summer.app");
    expect(tildeify("/tmp/foo")).toBe("/tmp/foo");
  });

  it("does not partial-match sibling user directories", () => {
    const home = homedir();
    const sibling = home.slice(0, -2) + "Other";
    expect(tildeify(sibling + "/file")).toBe(sibling + "/file");
  });

  it("handles empty/null/undefined input", () => {
    expect(tildeify(undefined)).toBe("");
    expect(tildeify(null)).toBe("");
    expect(tildeify("")).toBe("");
  });
});

describe("stripAnsi", () => {
  it("removes ANSI color codes", () => {
    expect(stripAnsi("\x1b[31mhello\x1b[0m")).toBe("hello");
    expect(stripAnsi("\x1b[1;32mbold green\x1b[0m text")).toBe("bold green text");
  });

  it("leaves clean strings untouched", () => {
    expect(stripAnsi("hello")).toBe("hello");
  });
});
