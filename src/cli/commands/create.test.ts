import { describe, expect, it } from "vitest";
import { renderProjectSettings } from "./create.js";

describe("summer create project settings", () => {
  it("scaffolds a Summer project on the current compatibility line", () => {
    const project = renderProjectSettings("My Summer Game", "res://main.tscn");

    expect(project).toContain("; Summer Engine Project");
    expect(project).toContain("; Technical base 4.6.1; Summer follows upstream continuously");
    expect(project).toContain('config/name="My Summer Game"');
    expect(project).toContain('run/main_scene="res://main.tscn"');
    expect(project).toContain('config/features=PackedStringArray("4.6")');
    expect(project).not.toContain("4.5");
  });
});
