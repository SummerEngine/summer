import { describe, expect, it } from "vitest";
import { bundledRegistry, validateCharacter, validateSettings } from "./registry.js";
import { buildCharacter, TEMPLATES } from "./templates.js";

const registry = bundledRegistry();

describe("character and settings validation against the bundled registry", () => {
  it("ships a Summer Router registry with the character and settings schemas and every SPEC error tag", () => {
    expect(registry.registry).toBe("summer-router");
    expect(registry.schemas.character.required).toEqual(["id", "instructions"]);
    const tags = registry.errors.map((error) => error.tag);
    for (const tag of ["unavailable", "not_signed_in", "mic_denied", "character_not_found", "tool_unhandled", "limit_reached", "credits_required", "router_disabled", "provider_unavailable", "moderated", "invalid_input"]) {
      expect(tags).toContain(tag);
    }
    expect(JSON.stringify(registry)).not.toMatch(/price|markup|margin|cost per/i);
  });

  it("accepts every template, with and without voice and tools", () => {
    for (const template of TEMPLATES) {
      expect(validateCharacter(buildCharacter({ id: "guard", template }), registry)).toEqual([]);
      expect(validateCharacter(buildCharacter({ id: "guard", template, voice: "deep and calm", tools: ["open_gate", "give_key"] }), registry)).toEqual([]);
    }
  });

  it("names the field and the rule for each problem", () => {
    const issues = validateCharacter(
      {
        id: "Guard",
        instructions: "",
        temperature: 3,
        voice: { pitch: 2 },
        turn: { mode: "always" },
        tools: [{ name: "open gate", description: "x" }],
        overridable: ["first_message", "first_message"],
      },
      registry
    );
    const byPath = Object.fromEntries(issues.map((issue) => [issue.path, issue.message]));
    expect(byPath["/id"]).toMatch(/must match/);
    expect(byPath["/instructions"]).toBe("must not be empty");
    expect(byPath["/temperature"]).toBe("must be 2 or less");
    expect(byPath["/voice/pitch"]).toBe("is not a known field");
    expect(byPath["/turn/mode"]).toMatch(/must be one of "server_vad", "push_to_talk"/);
    expect(byPath["/tools/0/name"]).toMatch(/must match/);
    expect(byPath["/tools/0/parameters"]).toBe("is required");
    expect(byPath["/overridable"]).toBe("must not repeat an item");
  });

  it("checks settings caps against the registry bounds", () => {
    expect(validateSettings({ expected_revision: 1, caps: { player_day_micro_usd: 500_000 } }, registry)).toEqual([]);
    expect(validateSettings({ caps: { player_day_micro_usd: 0 } }, registry)[0]).toMatchObject({ path: "/caps/player_day_micro_usd" });
  });
});
