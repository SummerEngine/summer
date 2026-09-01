import { describe, expect, it } from "vitest";
import { mergeProjectGodot, parseGodotConfig, serializeGodotConfig } from "./project-godot-merge.js";

const BASE = `config_version=5

[application]

config/name="My Game"
run/main_scene="res://main.tscn"

[autoload]

GameState="*res://autoload/game_state.gd"
Audio="*res://autoload/audio.gd"

[input]

jump={
"deadzone": 0.5,
"events": [Object(InputEventKey,"resource_local_to_scene":false,"keycode":32,"unicode":0,"script":null)
]
}
`;

describe("parseGodotConfig", () => {
  it("parses sections, keys, and comments", () => {
    const parsed = parseGodotConfig(BASE);
    expect(parsed.sections.get("")!.get("config_version")).toBe("5");
    expect(parsed.sections.get("application")!.get("config/name")).toBe('"My Game"');
    expect(parsed.sections.get("autoload")!.size).toBe(2);
  });

  it("parses multi-line Object(...) Variant values as one value", () => {
    const parsed = parseGodotConfig(BASE);
    const jump = parsed.sections.get("input")!.get("jump")!;
    expect(jump).toContain("InputEventKey");
    expect(jump).toContain('"deadzone": 0.5');
    expect(jump.trim().endsWith("}")).toBe(true);
  });

  it("handles strings containing brackets and escapes", () => {
    const parsed = parseGodotConfig('key="value with ) ] } and \\" quote"\nother=1\n');
    expect(parsed.sections.get("")!.get("key")).toBe('"value with ) ] } and \\" quote"');
    expect(parsed.sections.get("")!.get("other")).toBe("1");
  });

  it("round-trips through serialize and parse", () => {
    const parsed = parseGodotConfig(BASE);
    const reparsed = parseGodotConfig(serializeGodotConfig(parsed));
    expect(reparsed.sections.get("input")!.get("jump")).toEqual(parsed.sections.get("input")!.get("jump"));
    expect(reparsed.sections.get("autoload")!.get("GameState")).toEqual(parsed.sections.get("autoload")!.get("GameState"));
  });

  it("throws on garbage", () => {
    expect(() => parseGodotConfig("[unterminated\n")).toThrow();
    expect(() => parseGodotConfig("no equals sign here\n")).toThrow();
  });
});

describe("mergeProjectGodot 3-way merge (spec 10.2)", () => {
  it("unions keys added on either side", () => {
    const local = `${BASE}\n[display]\n\nwindow/size/viewport_width=1920\n`;
    const remote = `${BASE}\n[rendering]\n\nrenderer/rendering_method="forward_plus"\n`;
    const result = mergeProjectGodot(BASE, local, remote);
    expect(result.fallback).toBe(false);
    const merged = parseGodotConfig(result.merged);
    expect(merged.sections.get("display")!.get("window/size/viewport_width")).toBe("1920");
    expect(merged.sections.get("rendering")!.get("renderer/rendering_method")).toBe('"forward_plus"');
    expect(result.losingValues).toEqual([]);
  });

  it("deletion wins over an unchanged key (no autoload resurrection)", () => {
    // Local deleted the Audio autoload; remote left it unchanged.
    const local = BASE.replace('Audio="*res://autoload/audio.gd"\n', "");
    const result = mergeProjectGodot(BASE, local, BASE);
    const merged = parseGodotConfig(result.merged);
    expect(merged.sections.get("autoload")!.has("Audio")).toBe(false);
    expect(merged.sections.get("autoload")!.get("GameState")).toBe('"*res://autoload/game_state.gd"');
  });

  it("remote deletion also wins over an unchanged local key", () => {
    const remote = BASE.replace('Audio="*res://autoload/audio.gd"\n', "");
    const result = mergeProjectGodot(BASE, BASE, remote);
    const merged = parseGodotConfig(result.merged);
    expect(merged.sections.get("autoload")!.has("Audio")).toBe(false);
  });

  it("one-sided changes win without notices", () => {
    const local = BASE.replace('config/name="My Game"', 'config/name="Renamed"');
    const result = mergeProjectGodot(BASE, local, BASE);
    const merged = parseGodotConfig(result.merged);
    expect(merged.sections.get("application")!.get("config/name")).toBe('"Renamed"');
    expect(result.losingValues).toEqual([]);
  });

  it("both-changed keys take the remote value and surface the losing local value", () => {
    const local = BASE.replace('config/name="My Game"', 'config/name="Local Name"');
    const remote = BASE.replace('config/name="My Game"', 'config/name="Remote Name"');
    const result = mergeProjectGodot(BASE, local, remote);
    const merged = parseGodotConfig(result.merged);
    expect(merged.sections.get("application")!.get("config/name")).toBe('"Remote Name"');
    expect(result.losingValues).toEqual([
      { section: "application", key: "config/name", localValue: '"Local Name"' },
    ]);
  });

  it("merges multi-line Variant values changed on one side", () => {
    const local = BASE.replace('"keycode":32', '"keycode":65');
    const result = mergeProjectGodot(BASE, local, BASE);
    const merged = parseGodotConfig(result.merged);
    expect(merged.sections.get("input")!.get("jump")).toContain('"keycode":65');
  });

  it("remote wins a both-changed multi-line Variant value", () => {
    const local = BASE.replace('"keycode":32', '"keycode":65');
    const remote = BASE.replace('"keycode":32', '"keycode":90');
    const result = mergeProjectGodot(BASE, local, remote);
    const merged = parseGodotConfig(result.merged);
    expect(merged.sections.get("input")!.get("jump")).toContain('"keycode":90');
    expect(result.losingValues).toHaveLength(1);
    expect(result.losingValues[0].key).toBe("jump");
  });

  it("config_version comes from the winner", () => {
    const remote = BASE.replace("config_version=5", "config_version=6");
    const result = mergeProjectGodot(BASE, BASE, remote);
    const merged = parseGodotConfig(result.merged);
    expect(merged.sections.get("")!.get("config_version")).toBe("6");
  });

  it("falls back to whole-file remote-wins when any input fails to parse", () => {
    const remote = BASE.replace('config/name="My Game"', 'config/name="Remote"');
    const result = mergeProjectGodot(BASE, "completely broken ((((", remote);
    expect(result.fallback).toBe(true);
    expect(result.merged).toBe(remote);
  });
});
